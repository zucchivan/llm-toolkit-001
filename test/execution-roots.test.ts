import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bakeProject } from "./fixtures2.ts";
import { buildFauxModels, fauxAssistantMessage } from "./fixtures.ts";
import { FakeJudgmentClient, fakeJudgmentResponse } from "../src/judgment/fake.ts";
import { createTaskControls } from "../src/engine/controls.ts";
import { recipeBundleFromTree, runGates } from "../src/engine/gates.ts";
import { createTaskExecutionContext, discard, fenceWorkspace, freeze, materializeRead, openTask } from "../src/engine/workspace.ts";
import type { PlanIdentity } from "../src/engine/plans.ts";
import { runVerify } from "../src/engine/verifier.ts";
import { hostExecArgv } from "../src/engine/recipe-runner.ts";
import { exec } from "../src/util/exec.ts";

const projects: string[] = [];
const revision = "11111111-1111-4111-8111-111111111111";
const identity: PlanIdentity = {
	planRevision: revision, definitionSha256: "a".repeat(64), baseCommit: null,
	baseBranch: null, prdPath: "docs/prd.md", prdSha256: "b".repeat(64),
};
const taskId = "root-split";

const approve = (notes: string) => fauxAssistantMessage(JSON.stringify({
	// M0-P11: the line reference must exist on the CHECKED tree — the frozen
	// candidate, whose src/candidate-only.ts line 1 the verifier reads.
	verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "line", path: "src/candidate-only.ts", line: 1 }] }], notes,
}), { stopReason: "stop" });

afterEach(async () => {
	await Promise.all(projects.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("task execution root separation", () => {
	it("runs reviewed recipes in the frozen candidate and writes gate logs under the control root", async () => {
		const { project, kit } = await bakeProject({ buildFauxModels });
		projects.push(project.root);
		const recipeBytes = `[candidate-view]\nargv = ["node", "-e", "process.stdout.write(require('node:fs').readFileSync('src/candidate-only.ts', 'utf8'))"]\nmatch = ["candidate bytes"]\n`;
		await writeFile(join(project.root, "evals", "recipes.toml"), recipeBytes);
		expect((await exec(["git", "add", "evals/recipes.toml"], { cwd: project.root, timeoutMs: 10_000 })).code).toBe(0);
		expect((await exec(["git", "commit", "-m", "review recipe"], { cwd: project.root, timeoutMs: 10_000 })).code).toBe(0);
		const head = (await exec(["git", "rev-parse", "HEAD"], { cwd: project.root, timeoutMs: 10_000 })).stdout.trim();
		const workspace = await openTask({ root: project.root, oid: head }, identity, taskId);
		await writeFile(join(workspace.workspacePath, "src", "candidate-only.ts"), "export const marker = 'candidate bytes';\n");
		const controls = createTaskControls({ root: project.root, targetPaths: ["src/"] });
		const candidate = await freeze(fenceWorkspace(workspace, controls));
		const view = await materializeRead({ root: project.root, oid: candidate.tree }, controls);
		await writeFile(join(project.root, "src", "candidate-only.ts"), "export const marker = 'operator bytes';\n");
		const recipeBundle = await recipeBundleFromTree(project.root, workspace.parentTree);
		const context = await createTaskExecutionContext({
			controlPaths: kit.loop.paths,
			grant: { planRevision: revision, selectedTaskIds: [taskId] }, taskId,
			parentOid: head, startOid: workspace.parentTree, candidateOid: candidate.tree,
			writableWorkspace: workspace, frozenReadView: view, recipeBundle, execArgv: hostExecArgv,
		});
		// A post-review operator edit must not replace the gate recipe bytes.
		await writeFile(join(project.root, "evals", "recipes.toml"), `[operator-edit]\nargv = ["node", "-e", "process.exit(8)"]\n`);

		const gates = await runGates(kit, { id: taskId, targetPaths: ["src/"], baselineTreeSha: workspace.parentTree }, {}, { context });
		expect(gates.allPassed).toBe(true);
		expect(gates.results.find((result) => result.name === "candidate-view")?.passed).toBe(true);
		expect(gates.logFile).toBe(join(kit.loop.paths.artifacts, gates.logFile.split("/").at(-1)!));
		expect(await readFile(gates.logFile, "utf8")).toContain("candidate-view");
		expect(await readFile(join(view.viewPath, "src", "candidate-only.ts"), "utf8")).toContain("candidate bytes");
		expect(await readFile(join(project.root, "src", "candidate-only.ts"), "utf8")).toContain("operator bytes");

		await discard(view);
		await discard(workspace);
		await kit.loop.close();
		kit.lock.release();
	});

	it("builds verifier and Jev diffs from the frozen candidate, not operator checkout bytes", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		projects.push(project.root);
		const head = (await exec(["git", "rev-parse", "HEAD"], { cwd: project.root, timeoutMs: 10_000 })).stdout.trim();
		const workspace = await openTask({ root: project.root, oid: head }, identity, taskId);
		await writeFile(join(workspace.workspacePath, "src", "candidate-only.ts"), "export const marker = 'candidate-only evidence';\n");
		const controls = createTaskControls({ root: project.root, targetPaths: ["src/"] });
		const candidate = await freeze(fenceWorkspace(workspace, controls));
		const view = await materializeRead({ root: project.root, oid: candidate.tree }, controls);
		await writeFile(join(project.root, "src", "candidate-only.ts"), "export const marker = 'operator-only evidence';\n");
		const context = await createTaskExecutionContext({
			controlPaths: kit.loop.paths,
			grant: { planRevision: revision, selectedTaskIds: [taskId] }, taskId,
			parentOid: head, startOid: workspace.parentTree, candidateOid: candidate.tree,
			writableWorkspace: workspace, frozenReadView: view,
			recipeBundle: await recipeBundleFromTree(project.root, workspace.parentTree), execArgv: hostExecArgv,
		});
		models.faux.setResponses([approve("primary"), approve("skeptic")]);
		const client = new FakeJudgmentClient((request) => fakeJudgmentResponse(request, Object.fromEntries(
			Object.keys(request.questions).map((id) => [id, { type: "noul", probability: id.endsWith("_violated") ? 0.01 : 0.99 }]),
		), { inputTokens: 1, outputTokens: 1 }));
		const result = await runVerify(kit, {
			id: taskId, title: "root split", spec: "inspect candidate", acceptance: ["The candidate source shall be used."],
			baselineTreeSha: workspace.parentTree, targetPaths: ["src/"],
		}, "scope: pass", { executionContext: context, jevShadow: { enabled: true, client } });
		expect(result.verdict).toBe("approve");
		const patch = client.requests[0]?.state.change?.patch;
		expect(patch).toContain("candidate-only evidence");
		expect(patch).not.toContain("operator-only evidence");
		expect(client.requests[0]?.state.change?.files).toContain("src/candidate-only.ts");

		await discard(view);
		await discard(workspace);
		await kit.loop.close();
		kit.lock.release();
	});
});

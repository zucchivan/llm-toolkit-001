/**
 * P14 candidate-artifact/readout tests (ui/PRD.md A.2/A.3): each frozen wave
 * may write a flat revision-qualified candidate patch + stats side-car. The
 * patch is wave-local startTree→candidate, display-only, excludes engine paths,
 * is capped at 5 MiB, and is never a rollback or publication input. The readout
 * attaches the current revision's newest candidate artifact for terminal tasks.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { openProjectHarness } from "../src/engine/harness.ts";
import { readSessionState } from "../src/engine/state.ts";
import { runWaves } from "../src/engine/waves.ts";
import { runPlan, loadPrd } from "../src/engine/planner.ts";
import { readout } from "../src/engine/inspector.ts";
import { DISPLAY_PATCH_CAP_BYTES, isEngineOwnedPath } from "../src/util/git.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { demoConfigToml } from "./demo-project.ts";
import { bakeProject, scripted, accomplish } from "./fixtures2.ts";
import { writeGateFile } from "./helpers2.ts";
import { readJson } from "../src/util/fsx.ts";
import type { DisplayDiffStats } from "../src/util/git.ts";

beforeEach(() => {
	process.env["NO_COLOR"] = "1";
});

const ONE_TASK = {
	tasks: [
		{ id: "t1", title: "one", spec: "write src/one.ts with the module.", dependsOn: [], acceptance: ["When src/one.ts exists, the system shall compile."], targetPaths: ["src/"], priority: 1 },
	],
};

const implWrites = (writes: { path: string; content: string }[], closing = "STATUS: COMPLETE") =>
	writes.map((w) => fauxAssistantMessage([fauxToolCall("write", w)], { stopReason: "toolUse" })).concat([fauxAssistantMessage(closing, { stopReason: "stop" })]);

const verifyApprove = () =>
	fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "line", path: "src/index.ts", line: 1 }] }], notes: "ok" }), { stopReason: "stop" });
const verifySkepticApprove = () =>
	fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "line", path: "src/index.ts", line: 1 }] }], notes: "adversarial pass: no refutation found" }), { stopReason: "stop" });

const statsOf = async (root: string, name: string): Promise<DisplayDiffStats> => {
	const stats = await readJson<DisplayDiffStats>(join(root, ".orch", "artifacts", name));
	expect(stats, `stats side-car ${name} missing`).toBeTruthy();
	return stats as DisplayDiffStats;
};

describe("P14: frozen candidate artifacts", () => {
	it("a done task has a revision-qualified candidate patch + stats with the expected shape", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			...implWrites([
				{ path: "src/one.ts", content: "export const one = 1;\n" },
			]),
			verifyApprove(),
			verifySkepticApprove(),
		], models.faux);
		const revision = await accomplish(kit);

		const summary = await runWaves(kit, { tasksFilter: [] });
		expect(summary.complete).toBe(true);

		const patchPath = join(project.root, ".orch", "artifacts", `candidate-${revision}-t1-w1.patch`);
		const patchMeta = await stat(patchPath);
		expect(patchMeta.isFile()).toBe(true);
		const patch = await readFile(patchPath, "utf8");
		// the wave's file is there; engine-owned churn is not
		expect(patch).toContain("diff --git a/src/one.ts b/src/one.ts");
		expect(patch).toContain("+export const one = 1;");
		expect(patch).not.toContain("router.md");
		expect(patch).not.toContain("PROMPT.md");
		expect(patch).not.toMatch(/^.{0,200}diff --git a\.orch/m);

		const stats = await statsOf(project.root, `candidate-${revision}-t1-w1.json`);
		expect(stats.task).toBe("t1");
		expect(stats.wave).toBe(1);
		expect(stats.baselineTreeSha).toMatch(/^[0-9a-f]{40}$/);
		expect(typeof stats.generatedAt).toBe("number");
		expect(stats.files.map((f) => f.path).sort()).toEqual(["src/one.ts"]);
		const file = stats.files[0]!;
		expect(file.status).toBe("A");
		expect(file.insertions).toBe(1);
		expect(file.deletions).toBe(0);
		expect(file.binary).toBe(false);
		expect(stats.totalInsertions).toBe(1);
		expect(stats.totalDeletions).toBe(0);
		expect(stats.bytes).toBe(patchMeta.size);
		expect(stats.truncated).toBe(false);

		// delivery ran after the patch write (per-run delivery rows exist);
		// the state is terminal done and the loop ran to completion as before.
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.tasks[0]!.status).toBe("done");
		await kit.loop.close();
		kit.lock.release();
	});

	it("two waves (gate-fail retry) write the second wave's start-tree-to-candidate delta", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			// wave 1: two files, one of them BROKEN → gate fails → retry (tree stays)
			...implWrites([
				{ path: "src/one.ts", content: "export const one = 1;\n" },
				{ path: "src/two.ts", content: "export const BROKEN = true;\n" },
			]),
			// wave 2: fixes the tree (BROKEN gone from two.ts); adds a third file
			...implWrites([
				{ path: "src/one.ts", content: "export const one = 1;\nexport const two = 2;\n" },
				{ path: "src/two.ts", content: "export const settled = true;\n" },
				{ path: "src/three.ts", content: "export const three = 3;\n" },
			]),
			verifyApprove(),
			verifySkepticApprove(),
		], models.faux);
		await writeGateFile(project.root);
		const revision = await accomplish(kit);

		const summary = await runWaves(kit, { tasksFilter: [] });
		expect(summary.complete).toBe(true);

		const state = await readSessionState(kit.loop.harness);
		const task = state.router.tasks[0]!;
		expect(task.status).toBe("done");
		expect(task.waveCount).toBe(2);

		const stats = await statsOf(project.root, `candidate-${revision}-t1-w2.json`);
		// Progress is wave-local: wave 2 compares its start tree (wave 1's failed
		// candidate) with the final candidate, not cumulative task history.
		expect(stats.wave).toBe(2);
		const paths = stats.files.map((f) => f.path).sort();
		expect(paths).toEqual(["src/one.ts", "src/three.ts", "src/two.ts"]);
		const two = stats.files.find((f) => f.path === "src/two.ts")!;
		expect(two.status).toBe("M");
		const one = stats.files.find((f) => f.path === "src/one.ts")!;
		expect(one.insertions).toBe(1);
		expect(one.status).toBe("M");

		const patch = await readFile(join(project.root, ".orch", "artifacts", `candidate-${revision}-t1-w2.patch`), "utf8");
		expect(patch).toContain("src/two.ts");
		expect(patch).toContain("src/three.ts");
		expect(patch).toContain("+export const two = 2;");

		await kit.loop.close();
		kit.lock.release();
	});
});

describe("P14: quarantine retains its frozen candidate and receipt", () => {
	it("the candidate patch + stats survive workspace disposal; the operator checkout remains unchanged", async () => {
		// retryLimit 0 → the wave-1 gate failure quarantines right away (wave 1 exactly)
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(project.root, ".orch", "config.toml"), demoConfigToml().replace("retryLimit = 2", "retryLimit = 0"), "utf8");
		await kit.loop.close();
		kit.lock.release();
		const fresh = buildFauxModels([]);
		const reopen = await openProjectHarness(project.root, "test", { modelsOverride: fresh.models });
		await scripted(reopen, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			...implWrites([{ path: "src/one.ts", content: "export const BROKEN = true;\n" }]),
		], fresh.faux);
		await writeGateFile(project.root);
		const revision = await accomplish(reopen);

		const summary = await runWaves(reopen, { tasksFilter: [] });
		expect(summary.complete).toBe(false);

		const state = await readSessionState(reopen.loop.harness);
		const task = state.router.tasks[0]!;
		expect(task.status).toBe("quarantined");
		const baseline = task.baselineTreeSha!;

		const patch = await readFile(join(project.root, ".orch", "artifacts", `candidate-${revision}-t1-w1.patch`), "utf8");
		expect(patch).toContain("src/one.ts");
		expect(patch).toContain("+export const BROKEN = true;");
		// display rules hold on the quarantine path too
		expect(patch).not.toContain("router.md");

		const stats = await statsOf(project.root, `candidate-${revision}-t1-w1.json`);
		expect(stats.task).toBe("t1");
		expect(stats.wave).toBe(1);
		expect(stats.baselineTreeSha).toBe(baseline);
		expect(stats.files.map((f) => `${f.path}:${f.status}`)).toEqual(["src/one.ts:A"]);

		// The operator checkout stays unchanged; the frozen candidate remains
		// available by receipt/ref and the display patch is never a rollback input.
		const treeNow = await readFile(join(project.root, "src", "one.ts"), "utf8").catch(() => "<absent>");
		expect(treeNow).toBe("<absent>"); // the quarantined file was rolled off the tree

		await reopen.loop.close();
		reopen.lock.release();
	});
});

describe("P14: candidate artifact cap + truncation (display only, never a rollback input)", () => {
	it("a >5 MiB candidate delta truncates its artifact, sets truncated:true, and stays display-only", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		// The big change is produced by a SMALL bash command (the faux provider
		// caps scripted message sizes; the tree change itself must still be > 5 MiB).
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: `yes 'export const filler = XXXX;' | head -c ${Math.ceil(DISPLAY_PATCH_CAP_BYTES * 1.4)} > src/big.ts` })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			verifyApprove(),
			verifySkepticApprove(),
		], models.faux);
		const revision = await accomplish(kit);

		const summary = await runWaves(kit, { tasksFilter: [] });
		expect(summary.complete).toBe(true);
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.tasks[0]!.status).toBe("done"); // the run outcome is untouched by the cap

		const patchPath = join(project.root, ".orch", "artifacts", `candidate-${revision}-t1-w1.patch`);
		const meta = await stat(patchPath);
		expect(meta.size).toBeLessThanOrEqual(DISPLAY_PATCH_CAP_BYTES);
		const patch = await readFile(patchPath, "utf8");
		expect(patch.startsWith("diff --git ")).toBe(true); // head kept (headers first)

		const stats = await statsOf(project.root, `candidate-${revision}-t1-w1.json`);
		expect(stats.truncated).toBe(true);
		expect(stats.bytes).toBeLessThanOrEqual(DISPLAY_PATCH_CAP_BYTES);
		// stats still describe every real file (side-car is not the capped text)
		expect(stats.files.map((f) => f.path)).toEqual(["src/big.ts"]);

		await kit.loop.close();
		kit.lock.release();
	});
});

describe("A.3/P14: readout carries revision-qualified candidate refs", () => {
	it("storage mode: tasks[].diff {task, patch, stats, bytes, truncated} + kind === 'diff' artifacts", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			...implWrites([{ path: "src/one.ts", content: "export const one = 1;\n" }]),
			verifyApprove(),
			verifySkepticApprove(),
		], models.faux);
		const revision = await accomplish(kit);
		await runWaves(kit, { tasksFilter: [] });

		const read = await readout(kit.loop.paths, { loop: kit });
		expect(read.seam).toBe(1);
		expect(read.planRevision).toBe(revision);
		const view = read.tasks[0]!;
		expect(view.status).toBe("done");
		expect(view.diff).toEqual({
			task: "t1",
			patch: `candidate-${revision}-t1-w1.patch`,
			stats: `candidate-${revision}-t1-w1.json`,
			bytes: expect.any(Number),
			truncated: false,
		});
		const diffArtifacts = read.artifacts.filter((a) => a.kind === "diff").map((a) => a.name).sort();
		expect(diffArtifacts).toEqual([`candidate-${revision}-t1-w1.json`, `candidate-${revision}-t1-w1.patch`]);
		// engine-owned paths never leak in as display artifacts
		expect(read.artifacts.every((a) => !isEngineOwnedPath(a.name))).toBe(true);

		await kit.loop.close();
		kit.lock.release();
	});

	it("side-car mode (lock owned elsewhere): diff refs still resolve from the artifacts listing", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			...implWrites([{ path: "src/one.ts", content: "export const one = 1;\n" }]),
			verifyApprove(),
			verifySkepticApprove(),
		], models.faux);
		const revision = await accomplish(kit);
		await runWaves(kit, { tasksFilter: [] });
		await kit.loop.close();
		kit.lock.release();

		// no loop handed in → side-car readout; artifacts + status.json side-cars only
		const read = await readout(kit.loop.paths);
		expect(read.degraded).toBe(true);
		const view = read.tasks.find((t) => t.id === "t1")!;
		expect(view.diff?.patch).toBe(`candidate-${revision}-t1-w1.patch`);
		expect(view.diff?.stats).toBe(`candidate-${revision}-t1-w1.json`);
		expect(view.diff?.bytes).toBeGreaterThan(0);
	});
});

describe("P14 side-car: status.json carries plan and candidate checkpoints", () => {
	it("the atomic status side-car exposes revision, receipt states, and latest frozen candidate", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			...implWrites([{ path: "src/one.ts", content: "export const one = 1;\n" }]),
			verifyApprove(),
			verifySkepticApprove(),
		], models.faux);
		const revision = await accomplish(kit);
		await runWaves(kit, { tasksFilter: [] });

		const payload = await readJson<{
			planRevision?: string;
			receiptStates?: { taskId: string; wave: number; gate?: string; primary?: string; skeptic?: string; delivery?: string };
			checkpoint?: { wave: number; baseTree: string; candidateTree: string; asOf: number };
			tasks: { id: string; baselineTreeSha?: string }[];
		}>(join(project.root, ".orch", "status.json"));
		expect(payload?.planRevision).toBe(revision);
		expect(payload?.receiptStates).toMatchObject({ taskId: "t1", wave: 1, gate: "pass", primary: "approve", skeptic: "approve", delivery: "not_requested" });
		expect(payload?.checkpoint).toMatchObject({ wave: 1, baseTree: expect.any(String), candidateTree: expect.any(String), asOf: expect.any(Number) });
		const entry = payload?.tasks.find((t) => t.id === "t1");
		expect(entry?.baselineTreeSha).toMatch(/^[0-9a-f]{40}$/);
		// router doc and side-car agree
		const state = await readSessionState(kit.loop.harness);
		expect(entry?.baselineTreeSha).toBe(state.router.tasks[0]!.baselineTreeSha);

		await kit.loop.close();
		kit.lock.release();
	});
});



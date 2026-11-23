/**
 * e2e.smoke (§7): fixture PRD (examples/demo-prd) → REAL plan → run --approve
 * with scripted faux outputs, verifying RouterDoc transitions, router.md sync,
 * .orch/status.json updates, and .orch/wave-log.jsonl rows. Task 2 fails its
 * gate on wave 1 (the fixture's BEHAVIORAL gate-query rejects the scripted
 * case-sensitive queryList), undergoes conversation.reset(), and passes on
 * wave 2 — the completed program then satisfies the §0 invocation.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../src/init.ts";
import { openProjectHarness } from "../src/engine/harness.ts";
import { readSessionState } from "../src/engine/state.ts";
import { loadPrd, runPlan, parsePlannerJson, normalizeTasks, parseVerdictStrict, ensureAcyclic } from "../src/engine/planner.ts";
import { runWaves } from "../src/engine/waves.ts";
import { ReceiptsDoc } from "../src/engine/receipts.ts";
import { BACKGROUND_CONTEXT } from "../src/engine/kit.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { prepareDemoProject, writeConfig, demoConfigToml, gitInit, installDemoGates } from "./demo-project.ts";
import { readJson, atomicWriteJson } from "../src/util/fsx.ts";
import { exec } from "../src/util/exec.ts";

// The product sources the wave driver's gates actually execute — the parser
// strips ONE leading dash per token (kept, not dropped) and renderList joins.
const LIST_TS = `export function parseList(input: string): string[] {
	return input.split("/").flatMap((part) => part.split(",")).map((s) => s.trim()).filter((s) => s.length > 0).map((s) => s.startsWith("-") ? s.slice(1) : s);
}
export function renderList(items: string[]): string {
	return items.join(" ");
}
`;
// Task 2 wave 1 ships a CASE-SENSITIVE filter: gate-query rejects it on
// behavior; wave 2 repairs it (the retry is proven by behavior, not by a
// grep-able token). The executed gate imports the module — the scripted
// sources must be valid TypeScript for node's type-stripping (same bytes as
// the shipped replay).
const WRONG_QUERY_TS = `export function queryList(items: string[], q: string): string[] {
	return items.filter((item) => item.includes(q));
}
`;
const QUERY_TS = `export function queryList(items: string[], q: string): string[] {
	const needle = q.toLowerCase();
	return items.filter((item) => item.toLowerCase().includes(needle));
}
`;

const BIN_JS = `#!/usr/bin/env node
import { parseList, renderList } from "../src/list.ts";
console.log(renderList(parseList(process.argv[2] ?? "")));
`;

const PLANNER_TASKS = {
	tasks: [
		{ id: "list-parse", title: "parseList + renderList", spec: "Add src/list.ts with parseList() and renderList().", dependsOn: [], acceptance: ["When parseList receives '/foo/bar baz,-qux', the system shall produce ['foo','bar baz','qux']."], targetPaths: ["src/"], priority: 2 },
		{ id: "list-query", title: "queryList filter", spec: "Add queryList(list, q) filtering case-insensitively.", dependsOn: ["list-parse"], acceptance: ["When queryList is called with 'BAZ', the system shall return entries containing 'baz' ignoring case."], targetPaths: ["src/"], priority: 1 },
		{ id: "cli-render", title: "bin/render.js", spec: "bin/render.js prints renderList(parseList(text)).", dependsOn: ["list-query"], acceptance: ["When bin/render.js runs with '/a/-b', the system shall print 'a b'."], targetPaths: ["bin/"], priority: 0 },
	],
};

const implWrites = (writes: { path: string; content: string }[], closing = "STATUS: COMPLETE") => writes.map((w) => fauxAssistantMessage([fauxToolCall("write", w)], { stopReason: "toolUse" })).concat([fauxAssistantMessage(closing, { stopReason: "stop" })]);
// M0-P11: approvals cite EXECUTED, non-skipped, non-scope passing demo gates
// against the checked tree (gate-list runs every wave; gate-query on src/query.ts
// or bin/; gate-cli on bin/). Scope alone is never criterion evidence.
const gateApprove = (gateId: string, notes = "diff satisfies the criterion") =>
	fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "gate", id: gateId }] }], notes }), { stopReason: "stop" });
const verifyApprove = (gateId = "gate-list", notes = "diff satisfies the criterion") => gateApprove(gateId, notes);
const verifySkepticApprove = (gateId = "gate-list") => gateApprove(gateId, "adversarial pass: no refutation found");

describe("e2e smoke: fixture plan → run --approve (scripted faux)", () => {
	beforeEach(() => {
		process.env["NO_COLOR"] = "1";
	});

	it("plan → 3 tasks (task 2's first wave fails the behavioral gate) → complete, with mirrors + status + wave log", async () => {
		const project = await prepareDemoProject();
		// Demo setup: the fixture's ONE recipe file + the reviewed gate bytes →
		// evals/, committed before planning (initProject skips the existing file).
		await installDemoGates(project.root);
		await writeConfig(project.root, demoConfigToml());
		await initProject(project.root);
		await writeFile(join(project.root, "operator-note.md"), "committed operator base\n", "utf8");
		await writeFile(join(project.root, ".gitignore"), `${await readFile(join(project.root, ".gitignore"), "utf8")}\ncoverage/\n`, "utf8");
		await gitInit(project.root);
		// Dirty, unrelated operator state must not enter the task lease or move
		// when the serial driver freezes/publishes candidate trees.
		await writeFile(join(project.root, "operator-staged.txt"), "staged operator bytes\n", "utf8");
		await exec(["git", "add", "--", "operator-staged.txt"], { cwd: project.root, timeoutMs: 10_000 });
		await writeFile(join(project.root, "operator-note.md"), "unstaged operator bytes\n", "utf8");
		await mkdir(join(project.root, "coverage"), { recursive: true });
		await writeFile(join(project.root, "coverage", "sentinel.bin"), Buffer.from([0, 4, 8, 255]));
		expect((await exec(["git", "check-ignore", "coverage/sentinel.bin"], { cwd: project.root, timeoutMs: 10_000 })).code).toBe(0);
		const operatorHeadBefore = (await exec(["git", "rev-parse", "HEAD"], { cwd: project.root, timeoutMs: 10_000 })).stdout.trim();
		const operatorIndexBefore = (await exec(["git", "write-tree"], { cwd: project.root, timeoutMs: 10_000 })).stdout.trim();
		const stagedDiffBefore = (await exec(["git", "diff", "--cached", "--binary"], { cwd: project.root, timeoutMs: 10_000 })).stdout;
		const unstagedDiffBefore = (await exec(["git", "diff", "--binary"], { cwd: project.root, timeoutMs: 10_000 })).stdout;
		const ignoredBytesBefore = await readFile(join(project.root, "coverage", "sentinel.bin"));

		const { models, faux } = buildFauxModels([]);
		faux.appendResponses([
			// PLAN
			fauxAssistantMessage(JSON.stringify(PLANNER_TASKS), { stopReason: "stop" }),
			// task 1 (list-parse) wave 1: the fixture's gate-list executes the
			// parser + renderer (gate-query/gate-cli skip via `on` — task 2's and
			// task 3's files are not touched yet).
			...implWrites([{ path: "src/list.ts", content: LIST_TS }]),
			verifyApprove("gate-list"),
			verifySkepticApprove("gate-list"),
			// task 2 (list-query) wave 1: the CASE-SENSITIVE query → gate-query
			// fails on behavior → feedback (no verifier call on a failed gate).
			...implWrites([{ path: "src/query.ts", content: WRONG_QUERY_TS }]),
			// task 2 wave 2 (after conversation.reset): the repaired filter
			...implWrites([{ path: "src/query.ts", content: QUERY_TS }]),
			verifyApprove("gate-query", "wave 2 repaired the case-insensitive filter"),
			verifySkepticApprove("gate-query"),
			// task 3 (cli-render) wave 1
			...implWrites([{ path: "bin/render.js", content: BIN_JS }]),
			verifyApprove("gate-cli"),
			verifySkepticApprove("gate-cli"),
		]);

		// PLAN ---------------------------------------------------------------
		const planKit = await openProjectHarness(project.root, "plan", { modelsOverride: models });
		const prdText = await loadPrd(planKit);
		const planOutcome = await runPlan(planKit, "docs/prd.md", prdText);
		expect(planOutcome.tasks.map((t) => t.id)).toEqual(["list-parse", "list-query", "cli-render"]);
		await planKit.loop.close();
		planKit.lock.release();

		const routerMd = await readFile(join(project.root, "router.md"), "utf8");
		expect(routerMd).toContain("list-parse");
		expect(routerMd).toContain("STATUS: PLANNED");

		// APPROVE + RUN (M0-P05: the revision-qualified grant goes through the
		// driver's actual approval path — no bare-timestamp stamp) --------------
		const kit = await openProjectHarness(project.root, "run", { modelsOverride: models });
		const summary = await runWaves(kit, { approve: { planRevision: planOutcome.planRevision }, tasksFilter: [] });
		expect(summary.exit).toBe("plan-complete");
		expect(summary.complete).toBe(true);

		// RouterDoc transitions ----------------------------------------------
		const state = await readSessionState(kit.loop.harness);
		const tasks = new Map(state.router.tasks.map((t) => [t.id, t]));
		expect(tasks.get("list-parse")?.status).toBe("done");
		expect(tasks.get("list-parse")?.waveCount).toBe(1);
		// task 2: wave 1 failed the gate, wave 2 fixed it
		const t2 = tasks.get("list-query");
		expect(t2?.status).toBe("done");
		expect(t2?.waveCount).toBe(2);
		expect(t2?.feedback.some((fb) => fb.from === "gate")).toBe(true);
		expect(tasks.get("cli-render")?.status).toBe("done");

		// paper trail --------------------------------------------------------
		const routerMdAfter = await readFile(join(project.root, "router.md"), "utf8");
		expect(routerMdAfter).toContain("STATUS: COMPLETE — task queue drained");
		expect(routerMdAfter).toContain("done");

		const waveLog = await readFile(join(project.root, ".orch", "wave-log.jsonl"), "utf8");
		const rows = waveLog
			.trim()
			.split("\n")
			.map((r) => JSON.parse(r) as Record<string, unknown>);
		expect(rows.some((r) => r["verb"] === "planned")).toBe(true);
		expect(rows.some((r) => r["kind"] === "gate" && r["verb"] === "fail")).toBe(true);
		expect(rows.some((r) => r["kind"] === "verdict" && r["verdict"] === "approve")).toBe(true);
		expect(rows.filter((r) => r["kind"] === "verdict" && r["verb"] === "verify:skeptic:approve").length).toBe(3);
		expect(rows.filter((r) => r["kind"] === "task" && r["verb"] === "done").length).toBe(3);

		// M0-P11 receipts: 4 gate receipts (list-query's FAILED wave-1 gates are
		// recorded too) + 6 pass receipts (primary + skeptic), each pass bound to
		// its wave's gate receipt and checked tree.
		const receipts = (await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT))!;
		const gateEvents = receipts.events.filter((e) => e.kind === "gate");
		const passEvents = receipts.events.filter((e) => e.kind === "pass");
		expect(gateEvents).toHaveLength(4);
		expect(passEvents).toHaveLength(6);
		expect(passEvents.every((e) => e.kind === "pass" && e.value.review.verdict === "approve" && e.value.gateId.length > 0 && /^[0-9a-f]{40}$/.test(e.value.tree))).toBe(true);
		expect(passEvents.every((e) => e.kind === "gate" || gateEvents.some((g) => g.kind === "gate" && g.value.id === e.value.gateId))).toBe(true);

		const status = await readJson<{ tasks: { id: string; status: string }[] }>(join(project.root, ".orch", "status.json"));
		expect(status?.tasks.filter((t) => t.status === "done").length).toBe(3);

		// The operator checkout is not the result location. Inspect the accepted
		// ref through a detached worktree and run the independent product check there.
		const resultParent = await mkdtemp(join(tmpdir(), "kit-accepted-result-"));
		const resultRoot = join(resultParent, "accepted");
		try {
			const addResult = await exec(["git", "worktree", "add", "--detach", resultRoot, `refs/kit/${planOutcome.planRevision}/accepted`], { cwd: project.root, timeoutMs: 15_000 });
			expect(addResult.code).toBe(0);
			const acceptedHead = (await exec(["git", "rev-parse", "HEAD"], { cwd: resultRoot, timeoutMs: 10_000 })).stdout.trim();
			expect(acceptedHead).toMatch(/^[0-9a-f]{40}$/);
			expect(await readFile(join(resultRoot, "src", "list.ts"), "utf8")).toContain("parseList");
			expect(await readFile(join(resultRoot, "src", "query.ts"), "utf8")).toContain("queryList");
			expect(await readFile(join(resultRoot, "bin", "render.js"), "utf8")).toContain("renderList");
			// The wave-1 defect was BEHAVIORAL: the repaired query is case-insensitive.
			expect(await readFile(join(resultRoot, "src", "query.ts"), "utf8")).toContain("toLowerCase()");

			// §0 outcome test (M0-P08): independent Node invocation in the accepted view.
			const render = await exec(["node", "bin/render.js", "/a/-b"], { cwd: resultRoot, timeoutMs: 15_000 });
			expect(render.code).toBe(0);
			expect(render.stdout).toBe("a b\n");
		} finally {
			await exec(["git", "worktree", "remove", "--force", resultRoot], { cwd: project.root, timeoutMs: 15_000 });
			await rm(resultParent, { recursive: true, force: true });
		}

		// Accepted publication and detached inspection preserve the operator data.
		expect((await exec(["git", "rev-parse", "HEAD"], { cwd: project.root, timeoutMs: 10_000 })).stdout.trim()).toBe(operatorHeadBefore);
		expect((await exec(["git", "write-tree"], { cwd: project.root, timeoutMs: 10_000 })).stdout.trim()).toBe(operatorIndexBefore);
		expect((await exec(["git", "diff", "--cached", "--binary"], { cwd: project.root, timeoutMs: 10_000 })).stdout).toBe(stagedDiffBefore);
		expect((await exec(["git", "diff", "--binary"], { cwd: project.root, timeoutMs: 10_000 })).stdout).toBe(unstagedDiffBefore);
		expect(await readFile(join(project.root, "operator-note.md"), "utf8")).toBe("unstaged operator bytes\n");
		expect(await readFile(join(project.root, "operator-staged.txt"), "utf8")).toBe("staged operator bytes\n");
		expect(await readFile(join(project.root, "coverage", "sentinel.bin"))).toEqual(ignoredBytesBefore);
		expect(await readFile(join(project.root, "src", "list.ts"), "utf8").catch(() => "<absent>")).toBe("<absent>");

		await kit.loop.close();
		kit.lock.release();
	});

	it("handoff note queued by another process is ingested at the next wave and the file is removed", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await mkdir(join(project.root, "bin"), { recursive: true });
		await writeFile(join(project.root, "eval-gate.cjs"), "process.exit(0);\n", "utf8");
		await writeFile(join(project.root, "evals", "recipes.toml"), "[never-fails]\ncmd = \"node eval-gate.cjs\"\n", "utf8");
		await initProject(project.root);
		await gitInit(project.root);

		const { models, faux } = buildFauxModels([]);
		// planner | impl write | impl answer | 1 verifier approve (cites the executed
		// never-fails gate against the checked tree) + skeptic approve
		faux.setResponses([
			fauxAssistantMessage(JSON.stringify({ tasks: [{ id: "t1", title: "one", spec: "write src/one.ts", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 }] }), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/one.ts", content: "export const one = 1;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			gateApprove("never-fails", "executed gate proves the criterion"),
			verifySkepticApprove("never-fails"),
		]);

		const kit = await openProjectHarness(project.root, "test", { modelsOverride: models });
		const { loadPrd, runPlan } = await import("../src/engine/planner.ts");
		const planOutcome = await runPlan(kit, "docs/prd.md", await loadPrd(kit));

		// Queue the note exactly like the `handoff` CLI does (atomic side-car).
		await atomicWriteJson(kit.loop.paths.pendingHandoff, { ts: Date.now(), notes: ["keep tree clean"] });

		await runWaves(kit, { approve: { planRevision: planOutcome.planRevision }, tasksFilter: [] });
		const dumped = await readSessionState(kit.loop.harness);
		expect(dumped.rows.some((r) => r.kind === "handoff" && r.verb === "handoff-ingested" && (r.detail ?? "").includes("keep tree clean"))).toBe(true);
		// The handoff file is removed after ingestion (single process lock respected).
		await kit.loop.close();
		kit.lock.release();
		await expect(readFile(join(project.root, ".orch", "pending-handoff.json"), "utf8")).rejects.toThrow();
	});

	it("lock refusal: a live lock owner blocks a second open (polite error, exit 1)", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		const first = await openProjectHarness(project.root, "run", { modelsOverride: buildFauxModels([]).models });
		await expect(openProjectHarness(project.root, "status", { modelsOverride: buildFauxModels([]).models })).rejects.toThrow(/owns .*lock|busy/s);
		first.loop.close();
		first.lock.release();
	});

});

export { parsePlannerJson, normalizeTasks, parseVerdictStrict, ensureAcyclic };

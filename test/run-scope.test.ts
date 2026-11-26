/**
 * M0-P05 — exact grants and selection completion (ADR 01, §3 transition 5).
 *
 * The CLI parses `run` strictly, grants bind to ONE exact plan revision with
 * an EXPLICIT selected-id list (the full list is not a wildcard), a bare
 * resume inherits the grant untouched (mirror edits are never imported), and
 * whole-plan fulfillment is the only thing that flips the router phase to
 * complete — a satisfied subset reports selection-complete. Quarantined or
 * blocked members stop the selection with ids as a policy stop (exit 2),
 * never 0/complete. Rejections (old revision, unfinished prerequisite,
 * duplicate/unknown ids, edited mirror) leave the current grant unchanged.
 *
 * CLI-level EARS coverage runs through the shared ANSI-stripping runner
 * (test/plan-revision-helpers.ts); driver-level rules run in-process.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { prepareDemoProject, writeConfig, demoConfigToml, gitInit } from "./demo-project.ts";
import { demoBudgetToml2 } from "./fixtures2.ts";
import { initProject } from "../src/init.ts";
import { openProjectHarness } from "../src/engine/harness.ts";
import { readSessionState, grantRefusal, readGrant, type SessionState } from "../src/engine/state.ts";
import { ReceiptsDoc } from "../src/engine/receipts.ts";
import { BACKGROUND_CONTEXT } from "../src/engine/kit.ts";
import { runWaves, approveGrant, pickNextTaskInSelection } from "../src/engine/waves.ts";
import { assertAdmissiblePath, createTaskControls } from "../src/engine/controls.ts";
import { discard as discardWorkspace, materializeRead } from "../src/engine/workspace.ts";
import type { RouterTask } from "../src/engine/infos.ts";
import { KIT_VERSION } from "../src/config.ts";
import { runCli } from "./plan-revision-helpers.ts";

beforeEach(() => {
	process.env["NO_COLOR"] = "1";
});

// ---------------------------------------------------------------------------
// Fixtures: the three-task demo graph + replay chunks
// ---------------------------------------------------------------------------

const THREE_TASKS = {
	tasks: [
		{ id: "list-parse", title: "parseList + renderList", spec: "Add src/list.ts with parseList() and renderList().", dependsOn: [], acceptance: ["When parseList is called on '/a/-b', the system shall return ['a','b']."], targetPaths: ["src/"], priority: 2 },
		{ id: "list-query", title: "queryList filter", spec: "Add queryList(list, q) filtering case-insensitively.", dependsOn: ["list-parse"], acceptance: ["When queryList runs with 'A', the system shall match case-insensitively."], targetPaths: ["src/"], priority: 1 },
		{ id: "cli-render", title: "bin/render.js", spec: "Read argv[2] and print the rendered list.", dependsOn: ["list-query"], acceptance: ["When bin/render.js runs with '/a/-b', the system shall print 'a b'."], targetPaths: ["bin/"], priority: 0 },
	],
};

const LIST_TS = `export function parseList(input: string): string[] {
	return input.split("/").flatMap((p) => p.split(",")).map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith("-"));
}
export function renderList(items: string[]): string {
	return items.join(" ");
}
`;
const QUERY_TS = `export function queryList(items: string[], q: string): string[] {
	const needle = q.toLowerCase();
	return items.filter((i) => i.toLowerCase().includes(needle));
}
`;
const RENDER_JS = `#!/usr/bin/env node
import { parseList, renderList } from "../src/list.ts";
console.log(renderList(parseList(process.argv[2] ?? "")));
`;

const APPROVE = (notes: string, evidencePath = "src/index.ts") => JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "line", path: evidencePath, line: 1 }] }], notes });
const SKEPTIC = (evidencePath = "src/index.ts") => APPROVE("adversarial pass: no refutation found", evidencePath);

/** One task's implementer chunks: tool-write chunks, then the closing text, `---`-separated. */
const implChunks = (writes: { path: string; content: string }[]): string =>
	writes.map((w) => JSON.stringify({ tool: "write", path: w.path, content: w.content })).concat("STATUS: COMPLETE").join("\n---\n");

/** Full three-task replay: every task implements, gates pass, both verifier passes approve. */
const FULL_REPLAY = [
	"[planner]",
	JSON.stringify(THREE_TASKS),
	"[implementer]",
	[
		implChunks([{ path: "src/list.ts", content: LIST_TS }]),
		implChunks([{ path: "src/list.ts", content: LIST_TS }, { path: "src/query.ts", content: QUERY_TS }]),
		implChunks([{ path: "bin/render.js", content: RENDER_JS }]),
	].join("\n---\n"),
	"[verifier]",
	[APPROVE("parser + renderer present", "src/list.ts"), SKEPTIC("src/list.ts"), APPROVE("filter present", "src/query.ts"), SKEPTIC("src/query.ts"), APPROVE("renderer entry present", "bin/render.js"), SKEPTIC("bin/render.js")].join("\n---\n"),
].join("\n");

/** Subset replay: only list-parse is granted, so only its chunks are needed. */
const LIST_PARSE_ONLY_REPLAY = [
	"[planner]",
	JSON.stringify(THREE_TASKS),
	"[implementer]",
	implChunks([{ path: "src/list.ts", content: LIST_TS }]),
	"[verifier]",
	[APPROVE("parser + renderer present", "src/list.ts"), SKEPTIC("src/list.ts")].join("\n---\n"),
].join("\n");

const ZERO_PROGRESS_REPLAY = [
	"[planner]",
	JSON.stringify({
		tasks: [
			{ id: "t1", title: "x", spec: "DO-NOTHING", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 2 },
			{ id: "t2", title: "y", spec: "DO-NOTHING", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 },
		],
	}),
	"[implementer]",
	"STATUS: COMPLETE (no changes)",
].join("\n");

async function prepareProject(configToml: string = demoConfigToml()): Promise<string> {
	const project = await prepareDemoProject();
	await writeConfig(project.root, configToml);
	await gitInit(project.root);
	await initProject(project.root);
	return project.root;
}

async function writeReplay(root: string, text: string): Promise<string> {
	const path = join(root, "run-scope.replay");
	await writeFile(path, text, "utf8");
	return path;
}

/** CLI plan; returns the printed revision. */
async function planViaCli(root: string, replay: string): Promise<string> {
	const planned = await runCli(root, ["plan"], replay);
	expect(planned.code).toBe(0);
	const revision = /plan revision:\s*([0-9a-f-]{36})/.exec(planned.stdout)?.[1];
	expect(revision).toMatch(/^[0-9a-f-]{36}$/);
	return revision!;
}

const waveLogRows = async (root: string): Promise<Record<string, unknown>[]> => {
	const text = await readFile(join(root, ".orch", "wave-log.jsonl"), "utf8").catch(() => "");
	return text.trim() ? text.trim().split("\n").map((r) => JSON.parse(r) as Record<string, unknown>) : [];
};

// ---------------------------------------------------------------------------
// CLI EARS coverage
// ---------------------------------------------------------------------------

describe("run-scope (CLI): exact grants and selection completion", () => {
	it("granting only list-parse never starts list-query: selection complete, router not complete (EARS 1)", async () => {
		const root = await prepareProject();
		const replay = await writeReplay(root, LIST_PARSE_ONLY_REPLAY);
		const revision = await planViaCli(root, replay);

		// The documented subset command: repeated --tasks, one id per flag.
		const granted = await runCli(root, ["run", "--approve", "--revision", revision, "--tasks", "list-parse"], replay);
		expect(granted.code).toBe(0);
		expect(granted.stdout).toMatch(/selection complete/);
		expect(granted.stdout).toContain("list-parse");
		expect(granted.stdout).toContain("list-query"); // the remaining plan work is named
		expect(granted.stdout).not.toMatch(/STATUS: COMPLETE/); // whole-plan success is a DIFFERENT string

		// list-query never ran: still todo, no wave rows, phase stays open.
		const mirror = await readFile(join(root, "router.md"), "utf8");
		expect(mirror).toMatch(/## 2\. list-query[\s\S]*- STATUS: todo/);
		expect(mirror).not.toContain("STATUS: COMPLETE — task queue drained");
		const rows = await waveLogRows(root);
		expect(rows.filter((r) => r["kind"] === "wave" && r["task"] === "list-query" && r["verb"] === "start")).toEqual([]);
		// The grant row carries the exact revision + selection.
		const approvedRow = rows.find((r) => r["verb"] === "approved");
		expect(String(approvedRow?.["detail"])).toContain(`plan revision ${revision}`);
		expect(String(approvedRow?.["detail"])).toContain("grant: list-parse");

		// EARS 2: resuming that grant without flags after reopen does NO
		// additional work — the same selection-complete report, no new waves.
		const rowsBefore = rows.length;
		const resumed = await runCli(root, ["run"], replay);
		expect(resumed.code).toBe(0);
		expect(resumed.stdout).toMatch(/selection complete/);
		expect(resumed.stdout).not.toMatch(/STATUS: COMPLETE/);
		const rowsAfter = await waveLogRows(root);
		expect(rowsAfter.filter((r) => r["kind"] === "wave" && r["task"] === "list-query" && r["verb"] === "start")).toEqual([]);
		expect(rowsAfter.length).toBe(rowsBefore); // nothing was written at all
	}, 180_000);

	it("selecting list-query alone (prerequisite unfinished) rejects and leaves the current grant unchanged (EARS 3a)", async () => {
		const root = await prepareProject();
		const replay = await writeReplay(root, LIST_PARSE_ONLY_REPLAY);
		const revision = await planViaCli(root, replay);

		const refused = await runCli(root, ["run", "--approve", "--revision", revision, "--tasks", "list-query"], replay);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toMatch(/depends on "list-parse", which is outside this grant and not done/);

		// The grant never existed: no approved row, phase still PLANNED.
		const rows = await waveLogRows(root);
		expect(rows.some((r) => r["verb"] === "approved")).toBe(false);
		const mirror = await readFile(join(root, "router.md"), "utf8");
		expect(mirror).toContain("STATUS: PLANNED");
	}, 120_000);

	it("presenting an old revision rejects and leaves the current grant unchanged (EARS 3b)", async () => {
		const root = await prepareProject();
		const replay = await writeReplay(root, LIST_PARSE_ONLY_REPLAY);
		const firstRevision = await planViaCli(root, replay);
		// Replan (identical PRD): fresh revision, first grant invalidated.
		const secondRevision = await planViaCli(root, replay);
		expect(secondRevision).not.toBe(firstRevision);

		const stale = await runCli(root, ["run", "--approve", "--revision", firstRevision], replay);
		expect(stale.code).toBe(1);
		expect(stale.stderr).toMatch(new RegExp(`--revision ${firstRevision} does not name the current plan revision`));

		// No grant was minted by the stale request; the fresh plan is still unapproved.
		const rows = await waveLogRows(root);
		expect(rows.some((r) => r["verb"] === "approved")).toBe(false);
	}, 120_000);

	it("a selected task that quarantines stops with exit 2 and ids, never 0/complete (EARS 4)", async () => {
		const root = await prepareProject();
		const replay = await writeReplay(root, ZERO_PROGRESS_REPLAY);
		const revision = await planViaCli(root, replay);

		const stopped = await runCli(root, ["run", "--approve", "--revision", revision], replay);
		expect(stopped.code).toBe(2);
		expect(stopped.stdout).toMatch(/run stopped short/);
		expect(stopped.stdout).toContain("t1");
		expect(stopped.stdout).not.toMatch(/STATUS: COMPLETE/);
		expect(stopped.stdout).not.toMatch(/selection complete/);

		// t1 quarantined, t2 never started, router phase not complete.
		const mirror = await readFile(join(root, "router.md"), "utf8");
		expect(mirror).toMatch(/## 1\. t1[\s\S]*- STATUS: quarantined/);
		expect(mirror).toMatch(/## 2\. t2[\s\S]*- STATUS: todo/);
		expect(mirror).not.toContain("STATUS: COMPLETE — task queue drained");
	}, 120_000);

	it("the final outstanding work fulfilled records whole-plan completion once (EARS 5)", async () => {
		const root = await prepareProject();
		const replay = await writeReplay(root, FULL_REPLAY);
		const revision = await planViaCli(root, replay);

		const done = await runCli(root, ["run", "--approve", "--revision", revision], replay);
		expect(done.code).toBe(0);
		expect(done.stdout).toMatch(/STATUS: COMPLETE/);
		expect(done.stdout).toMatch(/whole plan fulfilled/);

		// A second bare run re-reports the same fulfillment WITHOUT recording it again.
		const again = await runCli(root, ["run"], replay);
		expect(again.code).toBe(0);
		expect(again.stdout).toMatch(/STATUS: COMPLETE/);
		const rows = await waveLogRows(root);
		const completionRows = rows.filter((r) => r["kind"] === "wave" && r["task"] === "session" && r["verb"] === "complete");
		expect(completionRows).toHaveLength(1);
		// The all-ids grant stored the FULL list explicitly (not a wildcard).
		const approvedRow = rows.find((r) => r["verb"] === "approved");
		expect(String(approvedRow?.["detail"])).toContain("grant: cli-render, list-parse, list-query");
	}, 180_000);

	it("the documented subset command agrees with CLI help and the actual output (EARS 6)", async () => {
		const root = await prepareProject();
		const help = await runCli(root, ["--help"]);
		expect(help.code).toBe(0);
		// The help documents the subset grant exactly as the tests run it.
		expect(help.stdout).toMatch(/run --approve --revision <uuid> \[--tasks id\]… \[--deliver\]/);
		expect(help.stdout).toMatch(/resume the stored grant/);

		const replay = await writeReplay(root, LIST_PARSE_ONLY_REPLAY);
		const revision = await planViaCli(root, replay);
		const granted = await runCli(root, ["run", "--approve", "--revision", revision, "--tasks", "list-parse"], replay);
		expect(granted.code).toBe(0);
		expect(granted.stdout).toMatch(/selection complete/);
	}, 120_000);

	it("strict parsing and grant admission refuse invalid input without touching state", async () => {
		const root = await prepareProject();
		const replay = await writeReplay(root, LIST_PARSE_ONLY_REPLAY);
		const revision = await planViaCli(root, replay);
		const rowsBefore = (await waveLogRows(root)).length;

		// Positionals are never swallowed into scope.
		const positional = await runCli(root, ["run", "list-parse"], replay);
		expect(positional.code).toBe(1);
		expect(positional.stderr).toMatch(/does not take positional arguments/);

		// Unknown flags refuse.
		const unknownFlag = await runCli(root, ["run", "--tasks", "list-parse", "--force"], replay);
		expect(unknownFlag.code).toBe(1);
		expect(unknownFlag.stderr).toMatch(/Unknown option/);

		// --approve without --revision: no hidden default revision.
		const noRevision = await runCli(root, ["run", "--approve"], replay);
		expect(noRevision.code).toBe(1);
		expect(noRevision.stderr).toMatch(/--approve needs --revision/);

		// Bare run on a planned-but-ungranted store: the review point stands.
		const bare = await runCli(root, ["run"], replay);
		expect(bare.code).toBe(1);
		expect(bare.stderr).toMatch(/not human-approved for its current plan revision/);

		// Duplicate --tasks and unknown ids refuse without broadening.
		const dup = await runCli(root, ["run", "--approve", "--revision", revision, "--tasks", "list-parse", "--tasks", "list-parse"], replay);
		expect(dup.code).toBe(1);
		expect(dup.stderr).toMatch(/duplicate --tasks entry "list-parse"/);
		const ghost = await runCli(root, ["run", "--approve", "--revision", revision, "--tasks", "ghost"], replay);
		expect(ghost.code).toBe(1);
		expect(ghost.stderr).toMatch(/not a task in the current plan/);

		// No refusal mutated the paper trail.
		expect((await waveLogRows(root)).length).toBe(rowsBefore);
	}, 180_000);

	it("a missing or edited mirror refuses a new grant; replan refreshes it; the grant never imports the edit", async () => {
		const root = await prepareProject();
		const replay = await writeReplay(root, LIST_PARSE_ONLY_REPLAY);

		const revision = await planViaCli(root, replay);
		await rm(join(root, "router.md"));
		const missing = await runCli(root, ["run", "--approve", "--revision", revision], replay);
		expect(missing.code).toBe(1);
		expect(missing.stderr).toMatch(/router\.md is missing/);

		// Replan mints a fresh revision and rewrites the mirror.
		const revision2 = await planViaCli(root, replay);
		expect(revision2).not.toBe(revision);
		const mirrorPath = join(root, "router.md");
		await writeFile(mirrorPath, (await readFile(mirrorPath, "utf8")).replace("## 1.", "## HAND-EDITED 1."), "utf8");
		const edited = await runCli(root, ["run", "--approve", "--revision", revision2], replay);
		expect(edited.code).toBe(1);
		expect(edited.stderr).toMatch(/differs from the durable plan render/);

		// Replan to refresh, then the documented subset grant goes through.
		const revision3 = await planViaCli(root, replay);
		const granted = await runCli(root, ["run", "--approve", "--revision", revision3, "--tasks", "list-parse"], replay);
		expect(granted.code).toBe(0);
		expect(granted.stdout).toMatch(/selection complete/);
	}, 180_000);
});

// ---------------------------------------------------------------------------
// Driver-level grant rules (in-process)
// ---------------------------------------------------------------------------

describe("run-scope (driver): the grant is the exact triple, mirror-bound on approval", () => {
	it("a stamp without the selection authorizes nothing; the full triple authorizes the exact set", () => {
		const identity = { planRevision: "11111111-1111-4111-8111-111111111111", definitionSha256: "0".repeat(64), baseCommit: null, baseBranch: null, prdPath: "docs/prd.md", prdSha256: "0".repeat(64) };
		const task: RouterTask = { id: "t1", title: "one", spec: "s", dependsOn: [], acceptance: ["c"], targetPaths: ["src/"], priority: 1, status: "todo", waveCount: 0, feedback: [] };
		const baseState: SessionState = {
			router: { version: 2, phase: "planned", tasks: [task], archived: [], identity },
			runStatus: { version: 2, budgetSpentUsd: 0, sleepCycleCount: 0, consecutiveErrors: 0, kitVersion: KIT_VERSION },
			rows: [],
		};
		// No stamp: refuse.
		expect(grantRefusal(baseState, {})).toMatch(/not human-approved/);
		// Pre-grant v2 stamp (revision + timestamp, no selection): still nothing.
		const stamped: SessionState = {
			...baseState,
			runStatus: { ...baseState.runStatus, approvedPlanRevision: identity.planRevision, humanApprovedAt: 1_700_000_000_000 },
		};
		expect(grantRefusal(stamped, {})).toMatch(/not human-approved/);
		// The complete triple authorizes exactly its list.
		const granted: SessionState = {
			...baseState,
			runStatus: { ...baseState.runStatus, approvedPlanRevision: identity.planRevision, approvedSelected: ["t1"], humanApprovedAt: 1_700_000_000_000 },
		};
		expect(readGrant(granted.runStatus)).toEqual({ planRevision: identity.planRevision, selected: ["t1"], humanApprovedAt: 1_700_000_000_000 });
		expect(grantRefusal(granted, {})).toBeUndefined();
		expect(grantRefusal(granted, { tasks: ["t1"] })).toBeUndefined();
		// An explicitly supplied set must EQUAL the grant (sorted compare); an
		// explicit empty set is a (bad) set, never "no explicit set".
		expect(grantRefusal(granted, { tasks: [] })).toMatch(/does not equal the stored grant/);
		expect(grantRefusal(granted, { tasks: ["t1", "ghost"] })).toMatch(/does not equal the stored grant/);
		// New grants always need the CURRENT revision, explicitly.
		expect(grantRefusal(baseState, { approve: {} })).toMatch(/requires --revision/);
		expect(grantRefusal(baseState, { approve: { planRevision: "22222222-2222-4222-8222-222222222222" } })).toMatch(/does not name the current plan revision/);
		expect(grantRefusal(baseState, { approve: { planRevision: identity.planRevision } })).toBeUndefined();
	});

	it("dependency lookup sees all tasks; candidate selection only granted ones", () => {
		const mk = (id: string, dependsOn: string[], priority: number, status: RouterTask["status"]): RouterTask => ({
			id, title: id, spec: "s", dependsOn, acceptance: ["c"], targetPaths: [], priority, status, waveCount: 0, feedback: [],
		});
		const tasks = [mk("a", [], 5, "done"), mk("b", ["a"], 3, "todo"), mk("c", ["b"], 9, "todo"), mk("d", [], 10, "todo")];
		// c outranks d globally but is not granted; b's dependency a is done (seen across ALL tasks).
		expect(pickNextTaskInSelection(tasks, ["b", "c"])?.id).toBe("b");
		// An undone dependency outside the selection makes the granted task unrunnable.
		expect(pickNextTaskInSelection(tasks, ["c"])).toBeUndefined();
		// Selection with b satisfied: c becomes runnable even though d outranks it outside the grant.
		const withBDone = [mk("a", [], 5, "done"), mk("b", ["a"], 3, "done"), mk("c", ["b"], 9, "todo"), mk("d", [], 10, "todo")];
		expect(pickNextTaskInSelection(withBDone, ["c"])?.id).toBe("c");
		// Never select outside the grant, even at higher priority.
		expect(pickNextTaskInSelection(tasks, ["b"])?.id).toBe("b");
	});

	it("an explicit resume set must equal the grant; an equal set runs exactly the grant; mirror edits are never imported", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await gitInit(project.root);
		await initProject(project.root);
		const { models, faux } = buildFauxModels([]);
		faux.setResponses([
			fauxAssistantMessage(JSON.stringify({ tasks: [
				{ id: "t1", title: "one", spec: "write src/one.ts with the module.", dependsOn: [], acceptance: ["When src/one.ts exists, the system shall compile."], targetPaths: ["src/"], priority: 1 },
				{ id: "t2", title: "two", spec: "write src/two.ts with the module.", dependsOn: [], acceptance: ["When src/two.ts exists, the system shall compile."], targetPaths: ["src/"], priority: 2 },
			] }), { stopReason: "stop" }),
			// t2 (priority 2) runs first, then t1.
			fauxAssistantMessage([fauxToolCall("write", { path: "src/two.ts", content: "export const two = 2;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			fauxAssistantMessage(APPROVE("two done")),
			fauxAssistantMessage(SKEPTIC()),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/one.ts", content: "export const one = 1;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			fauxAssistantMessage(APPROVE("one done")),
			fauxAssistantMessage(SKEPTIC()),
		]);
		const kit = await openProjectHarness(project.root, "test", { modelsOverride: models });
		const { loadPrd, runPlan } = await import("../src/engine/planner.ts");
		const planned = await runPlan(kit, "docs/prd.md", await loadPrd(kit));
		await approveGrant(kit, { planRevision: planned.planRevision });

		// A subset that is NOT the grant refuses without any wave.
		await expect(runWaves(kit, { tasksFilter: ["t1"] })).rejects.toThrow(/does not equal the stored grant/);
		const unchanged = await readSessionState(kit.loop.harness);
		expect(unchanged.router.tasks.map((t) => t.status)).toEqual(["todo", "todo"]);

		// The explicit full set (any order) equals the grant and runs the plan.
		const summary = await runWaves(kit, { tasksFilter: ["t2", "t1"] });
		expect(summary.exit).toBe("plan-complete");
		expect(summary.grant.selected).toEqual(["t1", "t2"]);
		await kit.loop.close();
		kit.lock.release();

		// Mirror edits are never imported: a hand-edited mirror does not block
		// (or redirect) a bare resume — the stored grant governs.
		const mirrorPath = join(project.root, "router.md");
		await writeFile(mirrorPath, (await readFile(mirrorPath, "utf8")).replace("## 1.", "## HAND-EDITED 1."), "utf8");
		const counter = await openProjectHarness(project.root, "test", { modelsOverride: buildFauxModels([]).models });
		const rowsBefore = (await readSessionState(counter.loop.harness)).rows.length;
		await counter.loop.close();
		counter.lock.release();
		const reopened = await openProjectHarness(project.root, "test", { modelsOverride: buildFauxModels([]).models });
		const resumed = await runWaves(reopened, {});
		expect(resumed.exit).toBe("plan-complete"); // no additional work, no commit
		const after = await readSessionState(reopened.loop.harness);
		expect(after.rows.length).toBe(rowsBefore);
		await reopened.loop.close();
		reopened.lock.release();
	}, 120_000);

	it("approveGrant rejects an edited mirror under the lock and never mints the grant", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await gitInit(project.root);
		await initProject(project.root);
		const { models, faux } = buildFauxModels([]);
		faux.setResponses([
			fauxAssistantMessage(JSON.stringify({ tasks: [THREE_TASKS.tasks[0]!] }), { stopReason: "stop" }),
		]);
		const kit = await openProjectHarness(project.root, "test", { modelsOverride: models });
		const { loadPrd, runPlan } = await import("../src/engine/planner.ts");
		const planned = await runPlan(kit, "docs/prd.md", await loadPrd(kit));

		const mirrorPath = join(project.root, "router.md");
		await writeFile(mirrorPath, (await readFile(mirrorPath, "utf8")).replace("## 1.", "## TAMPERED 1."), "utf8");
		await expect(approveGrant(kit, { planRevision: planned.planRevision })).rejects.toThrow(/differs from the durable plan render/);
		const state = await readSessionState(kit.loop.harness);
		expect(state.runStatus.approvedSelected).toBeUndefined(); // no grant minted
		expect(state.router.phase).toBe("planned");
		await kit.loop.close();
		kit.lock.release();
	}, 90_000);

	it("the budget ceiling is a policy stop (exit 2 vocabulary at the CLI)", async () => {
		const root = await prepareProject(demoBudgetToml2(0.0001));
		const replay = await writeReplay(root, LIST_PARSE_ONLY_REPLAY);
		const revision = await planViaCli(root, replay); // planning itself spends past the ceiling

		const stopped = await runCli(root, ["run", "--approve", "--revision", revision], replay);
		expect(stopped.code).toBe(2);
		expect(stopped.stdout).toMatch(/run stopped: budget/);
		// No wave started.
		const rows = await waveLogRows(root);
		expect(rows.filter((r) => r["kind"] === "wave" && r["task"] === "list-parse" && r["verb"] === "start")).toEqual([]);
	}, 120_000);
});

// ---------------------------------------------------------------------------
// M0-P18: a human resolution never broadens a grant
// ---------------------------------------------------------------------------

describe("run-scope: resolve never broadens the stored grant (M0-P18)", () => {
	it("refuses a resolution outside the grant, keeps the grant triple intact across a retry, and still reports selection-complete", async () => {
		const { runResolution } = await import("../src/engine/resolution.ts");
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml().replace("retryLimit = 2", "retryLimit = 0"));
		await mkdir(join(project.root, "evals"), { recursive: true });
		await writeFile(
			join(project.root, "eval-gate.cjs"),
			`const fs = require("node:fs");\nconst files = fs.existsSync("src") ? fs.readdirSync("src").map((f) => "src/" + f) : [];\nprocess.exit(files.some((p) => fs.readFileSync(p, "utf8").includes("BROKEN")) ? 1 : 0);\n`,
			"utf8",
		);
		await writeFile(join(project.root, "evals", "recipes.toml"), `[gate-ok]\ncmd = "node eval-gate.cjs"\n`, "utf8");
		await initProject(project.root);
		await gitInit(project.root);

		const { models, faux } = buildFauxModels([]);
		faux.setResponses([
			fauxAssistantMessage(JSON.stringify({
				tasks: [
					{ id: "t1", title: "one", spec: "write src/one.ts", dependsOn: [], acceptance: ["crit 1"], targetPaths: ["src/"], priority: 2 },
					{ id: "t2", title: "two", spec: "write src/two.ts", dependsOn: [], acceptance: ["crit 2"], targetPaths: ["src/"], priority: 1 },
				],
			}), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/one.ts", content: "export const one = 1; // BROKEN\n" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
		]);
		const kit = await openProjectHarness(project.root, "test", { modelsOverride: models });
		const { loadPrd, runPlan } = await import("../src/engine/planner.ts");
		const planned = await runPlan(kit, "docs/prd.md", await loadPrd(kit));
		const summary = await runWaves(kit, { approve: { planRevision: planned.planRevision, tasks: ["t1"] }, tasksFilter: ["t1"] });
		expect(summary.exit).toBe("blocked");

		const before = await readSessionState(kit.loop.harness);
		const grantBefore = readGrant(before.runStatus);
		expect(grantBefore?.selected).toEqual(["t1"]);

		// A resolution outside the grant is refused: it never admits t2.
		await expect(runResolution(kit, {
			planRevision: planned.planRevision, taskId: "t2", action: "retry", reason: "widen the grant by hand",
		})).rejects.toThrow(/is outside the current grant \(t1\)/);
		expect((await readSessionState(kit.loop.harness)).router.tasks.find((t) => t.id === "t2")?.status).toBe("todo");

		// A retry of the GRANTED task leaves the grant triple byte-identical.
		const outcome = await runResolution(kit, {
			planRevision: planned.planRevision, taskId: "t1", action: "retry", reason: "retry the granted task only",
		});
		expect(outcome.idempotent).toBe(false);
		const after = await readSessionState(kit.loop.harness);
		expect(readGrant(after.runStatus)).toEqual(grantBefore);
		expect(after.router.identity?.planRevision).toBe(planned.planRevision);
		expect(after.runStatus.humanApprovedAt).toBe(grantBefore?.humanApprovedAt);

		// An explicit resume set that is not the grant is still refused.
		const refusal = grantRefusal(after, { tasks: ["t1", "t2"] });
		expect(refusal).toMatch(/does not equal the stored grant \(t1\)/);
		await expect(runWaves(kit, { tasksFilter: ["t1", "t2"] })).rejects.toThrow(/does not equal the stored grant/);

		// A replacement added after review and the first wave must not change
		// the retry's projected controls or recipe verdict.
		const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: project.root, encoding: "utf8" }).trim();
		await writeFile(join(project.root, "alternate-recipe.toml"), '[different-gate]\nargv = ["node", "--version"]\nmatch = "no fixture version matches this"\n');
		git("replace", git("rev-parse", "HEAD:evals/recipes.toml"), git("hash-object", "-w", "alternate-recipe.toml"));

		// The retried wave repairs the task; the plan still has work outside the grant.
		faux.appendResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "src/one.ts", content: "export const one = 1;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "gate", id: "gate-ok" }] }], notes: "gate proves crit 1" }), { stopReason: "stop" }),
			fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "gate", id: "gate-ok" }] }], notes: "skeptic: no refutation" }), { stopReason: "stop" }),
		]);
		const resumed = await runWaves(kit, { tasksFilter: [] });
		expect(resumed.exit).toBe("selection-complete");
		expect(resumed.complete).toBe(false);
		expect(resumed.remainingPlanIds).toEqual(["t2"]);
		const final = await readSessionState(kit.loop.harness);
		expect(readGrant(final.runStatus)).toEqual(grantBefore);
		expect(final.router.phase).not.toBe("complete");
		expect(final.router.tasks.find((task) => task.id === "t1")?.status).toBe("done");
		await kit.loop.close();
		kit.lock.release();
	}, 120_000);
});

describe("reviewed PRD is reserved read-only (M1-P01 binding requirement)", () => {
	it("empty and docs* targets cannot change the PRD; the read view still reads it and absence is still reserved", async () => {
		for (const targetPaths of [[], ["docs/"]]) {
			const root = await prepareProject();
			const { models, faux } = buildFauxModels([]);
			faux.setResponses([
				fauxAssistantMessage(JSON.stringify({ tasks: [{
					id: "t1", title: "doc tamper", spec: "Try to rewrite the reviewed PRD.", dependsOn: [],
					acceptance: ["When the wave ends, docs/prd.md shall be unchanged."], targetPaths, priority: 1,
				}] }), { stopReason: "stop" }),
				// The worker deliberately bypasses the projected 0400 mode. Candidate
				// admission, not the filesystem mode, is the boundary under test.
				fauxAssistantMessage([fauxToolCall("bash", { command: "chmod u+w docs/prd.md && printf 'TAMPERED PRD\\n' > docs/prd.md" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			]);
			const kit = await openProjectHarness(root, "test", { modelsOverride: models });
			try {
				const { loadPrd, runPlan } = await import("../src/engine/planner.ts");
				const planned = await runPlan(kit, "docs/prd.md", await loadPrd(kit));
				const identity = (await readSessionState(kit.loop.harness)).router.identity!;
				const prdBefore = await readFile(join(root, "docs", "prd.md"), "utf8");

				// The read-only/verify projection still exposes the PRD bytes.
				const controls = createTaskControls({ root, targetPaths, prdPath: identity.prdPath });
				const view = await materializeRead({ root, oid: identity.baseCommit! }, controls);
				try {
					expect(await readFile(join(view.viewPath, "docs", "prd.md"), "utf8")).toBe(prdBefore);
				} finally {
					await discardWorkspace(view);
				}

				// Reservation is bound to the PATH, not to the file being present.
				const absent = createTaskControls({ root, targetPaths: ["docs/"], prdPath: "docs/missing-prd.md" });
				expect(() => assertAdmissiblePath("docs/missing-prd.md", absent)).toThrow(/read-only task-tree path/);

				await approveGrant(kit, { planRevision: planned.planRevision });
				const summary = await runWaves(kit, { tasksFilter: [] });
				expect(summary.exit).toBe("recovery-required");
				expect(await readFile(join(root, "docs", "prd.md"), "utf8")).toBe(prdBefore);
				// The worker bypassed the 0400 projection mode; the freeze/candidate
				// admission is what refused the PRD delta (not the filesystem mode).
				const freezeFailure = (await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT))?.events.find(
					(event) => event.kind === "checkpoint" && event.value.taskId === "t1" && event.value.code === "candidate-freeze-failed",
				);
				expect(freezeFailure).toBeDefined();
				const state = await readSessionState(kit.loop.harness);
				expect(state.router.tasks[0]!.status).not.toBe("done");
				expect(state.router.tasks[0]!.waveCount).toBe(0);
			} finally {
				await kit.loop.close().catch(() => {});
				kit.lock.release();
			}
		}
	}, 180_000);
});

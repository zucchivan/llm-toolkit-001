/**
 * UI seam tests (ui/PRD.md Appendix A.1 + A.3): truthful live wave status for
 * attached UIs — wave-start sets in_progress + wave-running + startedAt and
 * appends a start row; every wave outcome appends an end row (reset to todo on
 * retry, terminal status otherwise) and flushes status.json; status.json
 * carries the governor extras; the planner flushes { phase: "planning" }
 * BEFORE its conversation; the readout carries seam=1, live, and timeline
 * spans built from the start/end rows. Everything else keeps its behavior —
 * the seam is additive (guards-and-breakers + e2e still pass unchanged).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openProjectHarness, projectPaths, type StatusPayloads } from "../src/engine/harness.ts";
import { readSessionState, commitState, flushStatusSnapshot } from "../src/engine/state.ts";
import { runWaves, pickNextTask } from "../src/engine/waves.ts";
import { runPlan, loadPrd, PlanParseError } from "../src/engine/planner.ts";
import { readout } from "../src/engine/inspector.ts";
import type { WaveRow } from "../src/engine/infos.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { bakeProject, scripted, accomplish } from "./fixtures2.ts";
import { writeGateFile } from "./helpers2.ts";
import { initProject } from "../src/init.ts";
import { prepareDemoProject, writeConfig, demoConfigToml, gitInit } from "./demo-project.ts";
import { readJson, atomicWriteJson } from "../src/util/fsx.ts";

beforeEach(() => {
	process.env["NO_COLOR"] = "1";
});

const statusJson = async (root: string): Promise<StatusPayloads | undefined> =>
	(await readJson(join(root, ".orch", "status.json"))) as unknown as StatusPayloads | undefined;

const waveLogRows = async (root: string): Promise<WaveRow[]> => {
	const text = await readFile(join(root, ".orch", "wave-log.jsonl"), "utf8").catch(() => "");
	return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as WaveRow);
};

/** Poll a status.json predicate for mid-run assertions (side-car is atomic). */
async function waitForStatus(root: string, predicate: (p: StatusPayloads) => boolean, timeoutMs = 8_000): Promise<StatusPayloads> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const payload = await statusJson(root);
		if (payload && predicate(payload)) return payload;
		if (Date.now() > deadline) throw new Error(`status.json never matched: phase=${payload?.phase ?? "<absent>"}`);
		await new Promise((r) => setTimeout(r, 60));
	}
}

const ONE_TASK = {
	tasks: [
		{ id: "t1", title: "one", spec: "write src/one.ts with the module.", dependsOn: [], acceptance: ["When src/one.ts exists, the system shall compile."], targetPaths: ["src/"], priority: 1 },
	],
};

const PLANNER_TASKS = {
	tasks: [
		{ id: "list-parse", title: "parseList", spec: "Add src/list.ts with parseList().", dependsOn: [], acceptance: ["When parseList runs on '/a/b', the system shall return ['a','b']."], targetPaths: ["src/"], priority: 2 },
		{ id: "list-query", title: "queryList filter", spec: "Add queryList(list, q).", dependsOn: ["list-parse"], acceptance: ["When queryList runs with 'a', the system shall match case-insensitively."], targetPaths: ["src/"], priority: 1 },
	],
};

const implWrites = (writes: { path: string; content: string }[], closing = "STATUS: COMPLETE") =>
	writes.map((w) => fauxAssistantMessage([fauxToolCall("write", w)], { stopReason: "toolUse" })).concat([fauxAssistantMessage(closing, { stopReason: "stop" })]);

const verifyApprove = (notes = "diff satisfies the criterion") =>
	fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass" }], notes }), { stopReason: "stop" });

const LIST_TS = `export function parseList(input: string): string[] {
	return input.split('/').filter(Boolean);
}
`;
const QUERY_TS = `export function queryList(items: string[], q: string): string[] {
	return items.filter(Boolean);
}
`;

describe("wave-start flush (A.1)", () => {
	it("mid-wave: wave-running phase with task/wave/startedAt, in_progress router row, and the wave-log start row", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		// Bash sleep holds the submission open — the only reliable mid-run window.
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1.4" })], { stopReason: "toolUse" }),
			...implWrites([{ path: "src/one.ts", content: "export const one = 1;\n" }]),
			verifyApprove(),
		], models.faux);
		await accomplish(kit);

		const runPromise = runWaves(kit, { approve: true, tasksFilter: [] }).catch((err) => ({ threw: err }));
		const payload = await waitForStatus(project.root, (p) => p.phase === "wave-running");
		expect(payload.task).toMatchObject({ id: "t1", wave: 1, status: "running" });
		expect(typeof payload.task?.startedAt).toBe("number");
		// Router status flipped to in_progress (mirrored into the side-car's task list)
		expect(payload.tasks.find((t) => t.id === "t1")?.status).toBe("in_progress");
		// A budget number is present at flush time
		expect(payload.budget.spentUsd).toBeGreaterThanOrEqual(0);

		// wave-log start row with ts === startedAt
		const rows = await waveLogRows(project.root);
		const startRow = rows.find((r) => r.kind === "wave" && r.verb === "start" && r.task === "t1");
		expect(startRow).toBeTruthy();
		expect(startRow?.wave).toBe(1);
		expect(startRow?.ts).toBe(payload.task?.startedAt);

		await expect(runPromise).resolves.toMatchObject({ complete: true });
		// After the wave: side-car returns to idle and the task is terminal.
		const after = await statusJson(project.root);
		expect(after?.phase).toBe("idle");
		expect(after?.task).toBeUndefined();
		expect(after?.tasks.find((t) => t.id === "t1")?.status).toBe("done");
		await kit.loop.close();
		kit.lock.release();
	});
});

describe("wave-end rows (A.1): retry vs terminal outcomes", () => {
	it("failed gate on wave 1 → end row 'retry: gates failed'; wave 2 → end row 'approved'", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(PLANNER_TASKS), { stopReason: "stop" }),
			// t1 wave 1: works
			...implWrites([{ path: "src/list.ts", content: LIST_TS }]),
			verifyApprove(),
			// t2 wave 1: BROKEN token → gate fails → retry
			...implWrites([{ path: "src/list.ts", content: LIST_TS + "\nexport const BROKEN = true;\n" }]),
			// t2 wave 2 (after feedback): fixed + a NEW file — a byte-identical rewrite
			// of a baseline file would trip the zero-progress breaker, so add query.ts.
			...implWrites([{ path: "src/list.ts", content: LIST_TS }, { path: "src/query.ts", content: QUERY_TS }]),
			verifyApprove("fixed on wave 2"),
		], models.faux);
		await accomplish(kit);
		await writeGateFile(project.root);

		const summary = await runWaves(kit, { approve: true, tasksFilter: [] });
		expect(summary.complete).toBe(true);

		const rows = await waveLogRows(project.root);
		const rowsFor = (task: string, wave: number) => rows.filter((r) => r.task === task && r.wave === wave);

		// Wave 1 of list-query: start … gate fail … end("retry: gates failed"), in order.
		const w1 = rowsFor("list-query", 1);
		expect(w1[0]).toMatchObject({ kind: "wave", verb: "start" });
		expect(w1.at(-1)).toMatchObject({ kind: "wave", verb: "end", detail: "retry: gates failed" });
		expect(w1.some((r) => r.kind === "gate" && r.verb === "fail")).toBe(true);
		for (let i = 1; i < w1.length; i++) expect(w1[i]!.ts).toBeGreaterThanOrEqual(w1[i - 1]!.ts);

		// Wave 2 of list-query: start … done/approve … end("approved"), in order.
		const w2 = rowsFor("list-query", 2);
		expect(w2[0]).toMatchObject({ kind: "wave", verb: "start" });
		expect(w2.some((r) => r.kind === "task" && r.verb === "done")).toBe(true);
		expect(w2.at(-1)).toMatchObject({ kind: "wave", verb: "end", detail: "approved" });

		// Every wave has exactly one start and one end row, in that symmetry.
		for (const pair of [["list-parse", 1], ["list-query", 1], ["list-query", 2]] as const) {
			const seq = rowsFor(pair[0], pair[1]).map((r) => r.verb);
			expect(seq.filter((v) => v === "start").length).toBe(1);
			expect(seq.filter((v) => v === "end").length).toBe(1);
			expect(seq[0]).toBe("start");
			expect(seq.at(-1)).toBe("end");
		}

		// Terminal state: both tasks done; status.json is idle with a message.
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.tasks.map((t) => t.status)).toEqual(["done", "done"]);
		const payload = await statusJson(project.root);
		expect(payload?.phase).toBe("idle");
		expect(payload?.message).toContain("complete");
		// No wave-running residue in the side-car.
		expect(payload?.task).toBeUndefined();
		await kit.loop.close();
		kit.lock.release();
	});

	it("retryLimit exhausted → terminal end row 'quarantined: …' instead of a retry", async () => {
		// engine.retryLimit = 0: wave 1's gate failure quarantines right away.
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml().replace("retryLimit = 2", "retryLimit = 0"));
		await gitInit(project.root);
		await initProject(project.root);
		const models = buildFauxModels([]);
		models.faux.appendResponses([
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			// wave 1: writes broken file; gates fail; retryLimit 0 → immediate quarantine
			...implWrites([{ path: "src/one.ts", content: "export const BROKEN = true;\n" }]),
		]);
		await writeGateFile(project.root);
		const kit = await openProjectHarness(project.root, "test", { modelsOverride: models.models });
		await runPlan(kit, "docs/prd.md", await loadPrd(kit));
		await commitState(kit, { runStatus: (d) => { d.humanApprovedAt = Date.now(); } });

		const summary = await runWaves(kit, { approve: true, tasksFilter: [] });
		expect(summary.complete).toBe(false);
		const rows = await waveLogRows(project.root);
		const w1 = rows.filter((r) => r.task === "t1" && r.wave === 1).map((r) => r.verb);
		expect(w1[0]).toBe("start");
		expect(w1.at(-1)).toBe("end");
		const endRow = rows.filter((r) => r.task === "t1" && r.wave === 1 && r.verb === "end")[0]!;
		expect(endRow.detail).toContain("quarantined");
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.tasks[0]!.status).toBe("quarantined");
		const payload = await statusJson(project.root);
		expect(payload?.phase).toBe("idle");
		// the drained queue carries the stop-short message (pre-existing vocabulary)
		expect(payload?.message).toContain("1 task(s) quarantined: t1");
		await kit.loop.close();
		kit.lock.release();
	});
});

describe("resumability keeps working with the seam (pickNextTask on in_progress)", () => {
	it("a task left in_progress by a killed run is picked up by the next run and completes", async () => {
		const { kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			...implWrites([{ path: "src/one.ts", content: "export const one = 1;\n" }]),
			verifyApprove(),
		], models.faux);
		await accomplish(kit);
		// Simulate the crash the seam can now create: in_progress mid-wave.
		await commitState(kit, {
			router: (d) => {
				d.tasks[0]!.status = "in_progress";
			},
		});
		expect(pickNextTask((await readSessionState(kit.loop.harness)).router.tasks)?.id).toBe("t1");

		const summary = await runWaves(kit, { approve: true, tasksFilter: [] });
		expect(summary.complete).toBe(true);
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.tasks[0]!.status).toBe("done");
		await kit.loop.close();
		kit.lock.release();
	});
});

describe("planner pre-flush (A.1)", () => {
	it("planning flushes { phase: 'planning' } BEFORE the conversation (a failed planning still leaves the flush)", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [fauxAssistantMessage("this is not json at all", { stopReason: "stop" })], models.faux);

		await expect(runPlan(kit, "docs/prd.md", "PRD text")).rejects.toBeInstanceOf(PlanParseError);
		const payload = await statusJson(project.root);
		expect(payload?.phase).toBe("planning");
		expect(payload?.root).toBe(project.root);
		expect(payload?.tasks).toEqual([]); // no plan committed (the conversation failed)
		expect(payload?.budget).toMatchObject({ sessionCeilingUsd: 25, waveWarnUsd: 6 });
		await kit.loop.close();
		kit.lock.release();
	});

	it("a successful plan flushes 'planning' first and carries prdPath through the planned commit", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" })], models.faux);

		await runPlan(kit, "docs/prd.md", await loadPrd(kit));
		const payload = await statusJson(project.root);
		// The planned commit keeps its existing status flush (phase "planning" is the
		// kit's review-pending vocabulary; router.md says PLANNED — unchanged).
		expect(payload?.phase).toBe("planning");
		expect(payload?.prdPath).toBe("docs/prd.md");
		expect(payload?.tasks.map((t) => t.id)).toEqual(["t1"]);
		// The readout in storage mode carries the seam + no live wave while idle.
		const read = await readout(kit.loop.paths, { loop: kit });
		expect(read.seam).toBe(1);
		expect(read.live).toBeUndefined();
		await kit.loop.close();
		kit.lock.release();
	});
});

describe("status.json governor extras (A.1)", () => {
	it("rate-limit sleep arms sleepUntil + sleepCycleCount into the side-car and ends the wave with detail 'sleeping'", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels, retryMax: 0 });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			fauxAssistantMessage("provider overloaded", { stopReason: "error", errorMessage: "429 rate_limit resets in 90m" }),
		], models.faux);
		await accomplish(kit);

		const summary = await runWaves(kit, { approve: true, tasksFilter: [] });
		expect(summary.exit).toBe("sleeping");

		const payload = await statusJson(project.root);
		expect(payload?.sleepUntil).toBeGreaterThan(Date.now());
		expect(payload?.sleepCycleCount).toBe(1);
		expect(payload?.consecutiveErrors).toBe(1);
		expect(payload?.prdPath).toBe("docs/prd.md");
		expect(payload?.phase).toBe("idle");
		// wave end row with the sleeping outcome
		const rows = await waveLogRows(project.root);
		const end = rows.filter((r) => r.task === "t1" && r.verb === "end").at(-1);
		expect(end?.detail).toBe("sleeping");
		// the alert echoes the sleep
		expect(payload?.alert).toContain("rate limit");
		await kit.loop.close();
		kit.lock.release();
	});
});

describe("readout seam (A.3): seam=1, live, timeline spans from start/end rows", () => {
	it("side-car readout builds live + spans straight from the fabricated side-cars", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await gitInit(project.root);
		await initProject(project.root);

		const startedAt = Date.now() - 6_000;
		const payload = {
			kit: "0.2.1",
			piDurable: "1.5.0",
			ts: Date.now(),
			root: project.root,
			lockedByPid: 4242,
			phase: "wave-running",
			task: { id: "t1", wave: 2, status: "running", startedAt },
			budget: { spentUsd: 0.5, sessionCeilingUsd: 25, waveWarnUsd: 6 },
			tasks: [{ id: "t1", status: "in_progress", waveCount: 1, title: "one" }],
			alert: "rate limit: 429",
			message: "t1 wave 2 running",
			sleepUntil: startedAt + 9 * 60_000,
			consecutiveErrors: 1,
			sleepCycleCount: 1,
			prdPath: "docs/prd.md",
			usageNote: 0.5,
		};
		await atomicWriteJson(join(project.root, ".orch", "status.json"), payload);

		const t0 = startedAt;
		const t1 = startedAt + 2_000;
		const t2 = startedAt + 5_500;
		const rows = [
			{ ts: t0, kind: "wave", task: "t1", wave: 2, verb: "start" },
			{ ts: t1, kind: "gate", task: "t1", wave: 2, verb: "fail", detail: "type: bad" },
			{ ts: t2, kind: "wave", task: "t1", wave: 2, verb: "end", detail: "retry: gates failed" },
		] as unknown as WaveRow[];
		await writeFile(join(project.root, ".orch", "wave-log.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

		const read = await readout(projectPaths(project.root));
		expect(read.seam).toBe(1);
		expect(read.degraded).toBe(true);
		// live mirrors the side-car flush exactly (elapsed is wall-clock since startedAt)
		expect(read.live).toMatchObject({ task: "t1", wave: 2, startedAt, pid: 4242 });
		expect(read.live!.elapsedMs).toBeGreaterThanOrEqual(6_000);
		// timeline: the span starts at the start row and ends at the end row with its outcome
		expect(read.timeline).toHaveLength(1);
		expect(read.timeline[0]).toMatchObject({ task: "t1", wave: 2, startedMs: t0, durationMs: t2 - t0, outcome: "retry: gates failed" });
		// the fabricated task list survives the readout path
		expect(read.tasks[0]?.status).toBe("in_progress");
		// health carries the new checks
		const byId = new Map(read.health.map((c) => [c.id, c]));
		expect(byId.get("seam")?.ok).toBe(true);
		expect(byId.get("live")?.ok).toBe(true);
		expect(byId.get("live")?.detail).toContain("t1 #w2");
	});

	it("legacy waves without start/end rows keep the min/max span behavior", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await gitInit(project.root);
		await initProject(project.root);

		const base = Date.now() - 60_000;
		const rows = [
			{ ts: base, kind: "task", task: "t1", verb: "baseline", detail: "sha" },
			{ ts: base + 30_000, kind: "task", task: "t1", wave: 1, verb: "done", verdict: "approve" },
		] as unknown as WaveRow[];
		await writeFile(join(project.root, ".orch", "wave-log.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
		await mkdir(join(project.root, ".orch", "artifacts"), { recursive: true });

		const read = await readout(projectPaths(project.root));
		expect(read.timeline).toHaveLength(1);
		// no start row → startedMs = earliest row of the span (baseline)
		expect(read.timeline[0]).toMatchObject({ task: "t1", wave: 1, startedMs: base, durationMs: 30_000, outcome: "approved" });
		// no wave-running payload → live absent
		expect(read.live).toBeUndefined();
	});
});

it("flushStatusSnapshot writes the side-car without a commit (visibility-only)", async () => {
	const { project, kit } = await bakeProject({ buildFauxModels });
	await flushStatusSnapshot(kit, { phase: "planning" });
	const payload = await statusJson(project.root);
	expect(payload?.phase).toBe("planning");
	expect(payload?.lockedByPid).toBe(process.pid);
	// No commit happened: the router doc is untouched and the wave log has no rows.
	const state = await readSessionState(kit.loop.harness);
	expect(state.router.tasks).toEqual([]);
	const rows = await waveLogRows(project.root);
	expect(rows).toEqual([]);
	await kit.loop.close();
	kit.lock.release();
});

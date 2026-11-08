/**
 * UI seam tests (ui/PRD.md Appendix A.1 + A.3 + A.5): truthful live wave status for
 * attached UIs — wave-start sets in_progress + wave-running + startedAt and
 * appends a start row; every wave outcome appends an end row (reset to todo on
 * retry, terminal status otherwise) and flushes status.json; status.json
 * carries the governor extras; the planner flushes { phase: "planning" }
 * BEFORE its conversation; the readout carries seam=1, live, and timeline
 * spans built from the start/end rows. A.5 adds conversationEntries(): bounded
 * read-only transcript excerpts (plain JSON shapes, ≤ 2,000-entry window,
 * truncated flag, no pi-durable types across the boundary). Everything else
 * keeps its behavior — the seam is additive (guards-and-breakers + e2e still
 * pass unchanged).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openProjectHarness, projectPaths, type StatusPayloads } from "../src/engine/harness.ts";
import { readSessionState, commitState, flushStatusSnapshot } from "../src/engine/state.ts";
import { runWaves, pickNextTask } from "../src/engine/waves.ts";
import { runPlan, loadPrd, PlanParseError } from "../src/engine/planner.ts";
import { readout, conversationEntries, CONV_ENTRY_SCAN_CAP } from "../src/engine/inspector.ts";
import type { WaveRow } from "../src/engine/infos.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { bakeProject, scripted, accomplish } from "./fixtures2.ts";
import { writeGateFile } from "./helpers2.ts";
import { initProject } from "../src/init.ts";
import { BACKGROUND_CONTEXT, convId } from "../src/engine/kit.ts";
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

describe("conversation transcript excerpts (A.5)", () => {
	it("a completed run's implementer conversation excerpts as plain JSON: kinds, timestamps, text, tool calls", async () => {
		const { kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			...implWrites([{ path: "src/one.ts", content: "export const one = 1;\n" }]),
			verifyApprove(),
		], models.faux);
		await accomplish(kit);
		const summary = await runWaves(kit, { approve: true, tasksFilter: [] });
		expect(summary.complete).toBe(true);

		const read = await readout(kit.loop.paths, { loop: kit });
		const implConv = read.storage!.conversations.find((c) => c.role === "implementer")!;
		expect(implConv).toBeDefined();

		const excerpt = await conversationEntries(kit, implConv.id);
		expect(excerpt).toBeDefined();
		expect(excerpt!.conversation).toBe(implConv.id);
		expect(excerpt!.entries.length).toBeGreaterThanOrEqual(3);
		expect(excerpt!.truncated).toBe(false);

		// kinds present: the task prompt (user), the model's write + answer (assistant), tool results
		const kinds = new Set(excerpt!.entries.map((e) => e.kind));
		expect(kinds.has("pi.user")).toBe(true);
		expect(kinds.has("pi.assistant")).toBe(true);
		expect(kinds.has("pi.tool-result")).toBe(true);

		// every shape is plain JSON: numbers + strings only (no pi-durable types)
		expect(() => JSON.parse(JSON.stringify(excerpt))).not.toThrow();
		for (const entry of excerpt!.entries) {
			expect(Number.isInteger(entry.id)).toBe(true);
			if (entry.ts !== undefined) expect(Number.isFinite(entry.ts)).toBe(true);
			expect(typeof entry.text).toBe("string");
			for (const call of entry.toolCalls ?? []) {
				expect(typeof call.name).toBe("string");
				expect(typeof call.input).toBe("string");
				expect(() => JSON.parse(call.input)).not.toThrow();
			}
		}

		// the assistant entry that requested the write carries the call (name + JSON input)
		const writeCall = excerpt!.entries.flatMap((e) => e.toolCalls ?? []).find((c) => c.name === "write");
		expect(writeCall).toBeDefined();
		expect(writeCall!.input).toContain("src/one.ts");
		// the closing STATUS answer is visible as assistant text
		expect(excerpt!.entries.some((e) => e.kind === "pi.assistant" && e.text.includes("STATUS: COMPLETE"))).toBe(true);
		// timestamps ride the model messages
		expect(excerpt!.entries.some((e) => e.ts !== undefined)).toBe(true);

		// an id that does not exist answers undefined (the server's 404)
		expect(await conversationEntries(kit, 987_654)).toBeUndefined();

		// read-only + stable: a second read deep-equals the first
		const again = await conversationEntries(kit, implConv.id);
		expect(JSON.stringify(again)).toBe(JSON.stringify(excerpt));
		await kit.loop.close();
		kit.lock.release();
	});

	it("the cap is the contract: > 2,000 entries truncate; 'newest' keeps the tail, 'oldest' keeps the head", async () => {
		const { kit } = await bakeProject({ buildFauxModels });
		// Seed one ownerless conversation with 2,001 plain entries in a single commit.
		const conv = await kit.loop.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
		const convIdNum = conv.id as unknown as number;
		await kit.loop.harness.commit(async (tx) => {
			for (let i = 1; i <= CONV_ENTRY_SCAN_CAP + 1; i++) {
				await tx.appendEntry(convId(convIdNum), {
					kind: "seed.entry",
					model: [{ role: "user", content: `entry ${i}`, timestamp: 1_700_000_000_000 + i }],
				});
			}
		}, BACKGROUND_CONTEXT);

		const newest = await conversationEntries(kit, convIdNum);
		expect(newest).toBeDefined();
		expect(newest!.entries).toHaveLength(CONV_ENTRY_SCAN_CAP);
		expect(newest!.truncated).toBe(true);
		// chronological inside the window: the OLDEST entry of the window is #2; #1 was cut
		expect(newest!.entries[0]!.text).toBe("entry 2");
		expect(newest!.entries.at(-1)!.text).toBe(`entry ${CONV_ENTRY_SCAN_CAP + 1}`);

		const oldest = await conversationEntries(kit, convIdNum, { order: "oldest" });
		expect(oldest!.entries).toHaveLength(CONV_ENTRY_SCAN_CAP);
		expect(oldest!.truncated).toBe(true);
		expect(oldest!.entries[0]!.text).toBe("entry 1");
		expect(oldest!.entries.at(-1)!.text).toBe(`entry ${CONV_ENTRY_SCAN_CAP}`);
		await kit.loop.close();
		kit.lock.release();
	});

	it("exactly at the cap is NOT truncated; thinking blocks stay out of the text", async () => {
		const { kit } = await bakeProject({ buildFauxModels });
		const conv = await kit.loop.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
		const convIdNum = conv.id as unknown as number;
		await kit.loop.harness.commit(async (tx) => {
			for (let i = 1; i <= CONV_ENTRY_SCAN_CAP; i++) {
				await tx.appendEntry(convId(convIdNum), {
					kind: "seed.entry",
					model: [{ role: "user", content: `entry ${i}`, timestamp: 1_700_000_000_000 + i }],
				});
			}
			// one assistant entry whose content mixes thinking + text + a tool call
			await tx.appendEntry(convId(convIdNum), {
				kind: "pi.assistant",
				model: [{
					role: "assistant",
					api: "faux",
					provider: "faux",
					model: "kit-impl",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "toolUse",
					timestamp: 1_700_000_999_000,
					content: [
						{ type: "thinking", thinking: "secret chain-of-thought" },
						{ type: "text", text: "writing the file now" },
						{ type: "toolCall", id: "c1", name: "write", arguments: { path: "src/x.ts", content: "x" } },
					],
				}],
			});
		}, BACKGROUND_CONTEXT);

		const excerpt = await conversationEntries(kit, convIdNum);
		// the window is the newest 2,000: seeds 2..2000 + the assistant entry
		expect(excerpt!.entries).toHaveLength(CONV_ENTRY_SCAN_CAP);
		expect(excerpt!.truncated).toBe(true); // seed #1 fell out of the window
		const assistant = excerpt!.entries.find((e) => e.kind === "pi.assistant")!;
		expect(assistant.text).toBe("writing the file now");
		expect(assistant.text).not.toContain("secret chain-of-thought");
		expect(assistant.toolCalls).toEqual([{ name: "write", input: JSON.stringify({ path: "src/x.ts", content: "x" }) }]);
		expect(assistant.stopReason).toBe("toolUse");
		expect(assistant.ts).toBe(1_700_000_999_000);
		await kit.loop.close();
		kit.lock.release();
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

describe("delivery truth (A.6): readout surfaces the mode + outcome rows, read-only", () => {
	it("a commit-mode run's readout echoes the configured mode and the delivered rows", async () => {
		// the demo config with delivery flipped to commit: the delivery path
		// runs for real (git add/commit in the fixture repo) and the wave log
		// gains kind:"delivery" rows the readout must echo verbatim
		const { kit, models } = await bakeProject({
			buildFauxModels,
			configToml: demoConfigToml().replace('[delivery]\nmode = "none"', '[delivery]\nmode = "commit"'),
		});
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			...implWrites([{ path: "src/one.ts", content: "export const one = 1;\n" }]),
			verifyApprove(),
		], models.faux);
		await accomplish(kit);
		const summary = await runWaves(kit, { approve: true, tasksFilter: [] });
		expect(summary.complete).toBe(true);

		const read = await readout(kit.loop.paths, { loop: kit });
		expect(read.delivery).toBeDefined();
		expect(read.delivery.mode).toBe("commit");
		expect(read.delivery.rows.length).toBeGreaterThanOrEqual(1);
		const delivered = read.delivery.rows.find((r) => r.verb === "delivered");
		expect(delivered).toBeDefined();
		expect(delivered!.task).toBe("t1");
		expect(delivered!.detail).toContain("committed:");
		// plain JSON shapes (no engine row types across the boundary)
		expect(() => JSON.parse(JSON.stringify(read.delivery))).not.toThrow();
		for (const row of read.delivery.rows) {
			expect(Number.isFinite(row.ts)).toBe(true);
			expect(typeof row.task).toBe("string");
			expect(typeof row.verb).toBe("string");
		}
		await kit.loop.close();
		kit.lock.release();
	});

	it("side-car readout: delivery rows come from the wave log, mode from the static config read", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await gitInit(project.root);
		await initProject(project.root);

		const base = Date.now() - 30_000;
		const rows = [
			{ ts: base, kind: "task", task: "t1", verb: "baseline", detail: "sha" },
			{ ts: base + 10_000, kind: "delivery", task: "t1", verb: "commit-failed", detail: "git commit failed (nothing to commit?)" },
			{ ts: base + 20_000, kind: "delivery", task: "t1", wave: 1, verb: "delivered", detail: "committed: demo: t1 (wave 1)" },
		] as unknown as WaveRow[];
		await writeFile(join(project.root, ".orch", "wave-log.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

		const read = await readout(projectPaths(project.root));
		expect(read.degraded).toBe(true);
		expect(read.delivery.mode).toBe("none"); // from .orch/config.toml, not storage
		expect(read.delivery.rows).toHaveLength(2);
		expect(read.delivery.rows.map((r) => r.verb)).toEqual(["commit-failed", "delivered"]);
		expect(read.delivery.rows[1]).toEqual({ ts: base + 20_000, task: "t1", verb: "delivered", wave: 1, detail: "committed: demo: t1 (wave 1)" });
		// non-delivery rows stay out, plain JSON end to end
		expect(read.delivery.rows.some((r) => r.verb === "baseline")).toBe(false);
		expect(() => JSON.parse(JSON.stringify(read.delivery))).not.toThrow();
	});

	it("side-car readout with an unreadable config keeps the delivery rows and omits the mode", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await gitInit(project.root);
		await initProject(project.root);
		// break the config: the reader degrades to rows-only, never guesses
		await writeFile(join(project.root, ".orch", "config.toml"), "this is not [valid toml\n", "utf8");

		const rows = [
			{ ts: Date.now() - 5_000, kind: "delivery", task: "t1", verb: "delivered", detail: "committed: demo: t1 (wave 1)" },
		] as unknown as WaveRow[];
		await writeFile(join(project.root, ".orch", "wave-log.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

		const read = await readout(projectPaths(project.root));
		expect(read.delivery.mode).toBeUndefined();
		expect(read.delivery.rows).toHaveLength(1);
		expect(read.delivery.rows[0]?.task).toBe("t1");
	});
});

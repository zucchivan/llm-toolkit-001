/**
 * Pure view logic (§7.1/§8): view decision, job outcome mapping, plan-review
 * topological order + selection defaults, failure-row toasts.
 */
import { describe, expect, it } from "vitest";
import { decideView, topoOrder, jobOutcome, failureRows, defaultSelection, selectableTasks, diffDrawerState, diffOpenable, latestDiffTask, hashDiffTask, orderedHealthChecks, healthAlertText, budgetBarData, filterWaveRows, globalShortcut, escapeTarget, modelPreflight, firstFailureLine, rolesNeeded, conversationGroups, conversationById, hashConversationDrawer, isConversationListHash, excerptErrorState, entryKindLabel, deliveryReport, windowedTail, EVENT_LOG_DOM_WINDOW, filterTasks, TASK_STATUSES } from "../src/lib/view.ts";
import type { RoleModelInfo } from "../src/lib/api.ts";
import type { HealthCheck } from "../../src/engine/inspector.ts";
import type { ReadoutSnapshot } from "../src/lib/api.ts";
import type { JobRecord } from "../server/jobs.ts";
import type { KitReadout, KitTaskView, ConvSummary, ConvEntryView, DeliveryRow } from "../../src/engine/inspector.ts";
import type { RouterTask, WaveRow } from "../../src/engine/infos.ts";

function snap(over: Partial<{ phase: string; tasks: KitReadout["tasks"]; mode: "storage" | "sidecars"; storageTasks?: RouterTask[]; storageConversations?: ConvSummary[]; sleep?: ReadoutSnapshot["sleep"] }> = {}): ReadoutSnapshot {
	return {
		readout: {
			at: 1,
			seam: 1,
			degraded: over.mode === "sidecars",
			identity: { kit: "k", piDurable: "1", root: "/r", at: 1 },
			phase: over.phase ?? "idle",
			tasks: over.tasks ?? [],
			rows: [],
			usage: { sessionUsd: 0, tokens: 0, ceilingUsd: 0, warnUsdPerWave: 0, wavesExecuted: 0, spendRateUsdPerWave: 0, byModel: {}, byTask: {}, source: "storage" },
			timeline: [],
			delivery: { rows: [] },
			artifacts: [],
			health: [],
			...(over.storageTasks || over.storageConversations
			? { storage: { router: { version: 1, phase: "planned", tasks: over.storageTasks ?? [] }, runStatus: { version: 1, budgetSpentUsd: 0, sleepCycleCount: 0, consecutiveErrors: 0, kitVersion: "k" }, conversations: over.storageConversations ?? [], reports: [] } }
			: {}),
		},
		mode: over.mode ?? "storage",
		at: 1,
		sleep: over.sleep,
	} as ReadoutSnapshot;
}

function job(over: Partial<JobRecord> & Pick<JobRecord, "id" | "kind">): JobRecord {
	return { argv: [], cwd: "/r", startedAt: 1, status: "running", logPath: "/l", ...over };
}

describe("decideView", () => {
	it("a running plan job → planning; a running run job → monitor; nothing + planned → review", () => {
		const planActive = decideView(snap(), { at: 1, jobs: [job({ id: "a", kind: "plan" })] });
		expect(planActive.view).toBe("planning");
		expect(planActive.activeJob?.kind).toBe("plan");

		const runActive = decideView(snap(), { at: 1, jobs: [job({ id: "b", kind: "run" })] });
		expect(runActive.view).toBe("monitor");

		const review = decideView(snap({ phase: "planned" }), { at: 1, jobs: [] });
		expect(review.view).toBe("review");
	});

	it("all terminal tasks → report with todo list empty; partial work stays monitor", () => {
		const tasks: KitReadout["tasks"] = [
			{ id: "t1", title: "one", status: "done", waveCount: 2, dependsOn: [], targetPaths: [], priority: 1, feedback: 0 },
			{ id: "t2", title: "two", status: "quarantined", waveCount: 3, dependsOn: ["t1"], targetPaths: [], priority: 1, feedback: 1 },
		];
		const report = decideView(snap({ phase: "idle", tasks }), { at: 1, jobs: [] });
		expect(report.view).toBe("report");
		expect(report.allTerminal).toBe(true);

		const partial = decideView(snap({ phase: "idle", tasks: [{ id: "t3", title: "x", status: "todo", waveCount: 0, dependsOn: [], targetPaths: [], priority: 1, feedback: 0 }] }), { at: 1, jobs: [] });
		expect(partial.view).toBe("monitor");
		expect(partial.todo).toHaveLength(1);
	});

	it("sleep banner: armed sleep + no live run; a live runJob suppresses it", () => {
		const sleepingView = decideView(snap({ sleep: { until: 9_001, cycleCount: 2 } }), { at: 1, jobs: [job({ id: "r", kind: "run", status: "exited", exitCode: 42, endedAt: 2 })] });
		expect(sleepingView.sleeping).toEqual({ until: 9_001, cycleCount: 2 });

		const liveRun = decideView(snap({ sleep: { until: 9_001 } }), { at: 1, jobs: [job({ id: "r2", kind: "run" })] });
		expect(liveRun.sleeping).toBeUndefined();
		expect(liveRun.view).toBe("monitor");
	});

	it("handoff jobs never hijack the view", () => {
		const v = decideView(snap({ phase: "planned" }), { at: 1, jobs: [job({ id: "h", kind: "handoff" })] });
		expect(v.view).toBe("review");
		expect(v.activeJob).toBeUndefined();
	});
});

describe("exit-code mapping", () => {
	it("0 ok · 42 sleeping · 130 interrupted · other failed", () => {
		expect(jobOutcome(0)).toBe("ok");
		expect(jobOutcome(42)).toBe("sleeping");
		expect(jobOutcome(130)).toBe("interrupted");
		expect(jobOutcome(1)).toBe("failed");
		expect(jobOutcome(undefined)).toBe("none");
	});
});

describe("plan review helpers", () => {
	const plan: RouterTask[] = [
		{ id: "a", title: "one", spec: "", dependsOn: [], acceptance: [], targetPaths: ["src/"], priority: 2, status: "todo", waveCount: 0, feedback: [] },
		{ id: "c", title: "three", spec: "", dependsOn: ["b"], acceptance: [], targetPaths: [], priority: 0, status: "todo", waveCount: 0, feedback: [] },
		{ id: "b", title: "two", spec: "", dependsOn: ["a"], acceptance: [], targetPaths: [], priority: 1, status: "todo", waveCount: 0, feedback: [] },
	];

	it("topological order with stable input tiebreak", () => {
		expect(topoOrder(plan).map((t) => t.id)).toEqual(["a", "b", "c"]);
	});

	it("selectable + default selection require deps done/empty (§8.2 step 3–4)", () => {
		// b depends on a (still todo) → not selectable yet; c blocked twice over
		expect(selectableTasks(plan).map((t) => t.id)).toEqual(["a"]);
		expect(defaultSelection(plan)).toEqual(["a"]);
	});

	it("done dependencies unlock selected dependents too (b itself needs its own dep)", () => {
		const withDone = plan.map((t) => (t.id === "b" ? { ...t, status: "done" as const } : t));
		// a: no deps · c: dep b done → selectable. b: deps a still todo → not selectable now.
		expect(selectableTasks(withDone).map((t) => t.id)).toEqual(["a", "c"]);
		expect(defaultSelection(withDone)).toEqual(["a", "c"]);
	});
});

describe("failureRows (toast inputs)", () => {
	it("gate fails, verifier rejections, quarantines and sleeps become rows; passes stay quiet", () => {
		const rows = failureRows([
			{ ts: 1, kind: "wave", task: "t", verb: "start" },
			{ ts: 2, kind: "gate", task: "t", wave: 1, verb: "pass", detail: "lint:true" },
			{ ts: 3, kind: "gate", task: "t", wave: 2, verb: "fail", detail: "lint:false" },
			{ ts: 4, kind: "verdict", task: "t", wave: 2, verb: "reject:2", verdict: "needs_human", detail: "criterion missing" },
			{ ts: 5, kind: "task", task: "t", verb: "quarantined", reason: "2 failures" },
			{ ts: 6, kind: "governor", task: "t", verb: "rate-limit-sleep", detail: "429" },
			{ ts: 7, kind: "verdict", task: "u", wave: 1, verb: "reject:1", verdict: "approve", detail: "ok" },
		]);
		expect(rows.map((r) => r.text)).toEqual([
			"gate failed — t #w2: lint:false",
			"verifier needs_human — t #w2: criterion missing",
			"quarantined — t: 2 failures",
			expect.stringContaining("durable sleep armed"),
		]);
		expect(rows.every((r) => r.severity === "error" || r.severity === "warn")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// M2: diff drawer state (mode/label derivation) + latest diff shortcut
// ---------------------------------------------------------------------------

describe("diffDrawerState", () => {
	it("in_progress or the live task → live mode; done → persisted with wave label; quarantined → rolled back", () => {
		const s = snap({
			tasks: [
				{ id: "t-live", title: "x", status: "in_progress", waveCount: 1, dependsOn: [], targetPaths: [], priority: 1, feedback: 0 },
				{ id: "t-done", title: "y", status: "done", waveCount: 2, dependsOn: [], targetPaths: [], priority: 1, feedback: 0, diff: { task: "t-done", patch: "task-t-done.patch", stats: "task-t-done.json", bytes: 99, truncated: false } },
				{ id: "t-q", title: "z", status: "quarantined", waveCount: 1, dependsOn: [], targetPaths: [], priority: 1, feedback: 0, diff: { task: "t-q", patch: "quarantined-t-q-w1.patch", bytes: 10, truncated: false } },
			] as KitReadout["tasks"],
		});
		(s.readout as { live?: unknown }).live = { task: "t-live", wave: 1, startedAt: 1, elapsedMs: 5 };

		const live = diffDrawerState(s, "t-live")!;
		expect(live).toEqual({ task: "t-live", live: true, waves: 1, rolledBack: false });
		// the side-car's live task counts even when the task list hasn't caught up
		const s2 = snap({ tasks: [{ id: "t-2", title: "t", status: "todo", waveCount: 0, dependsOn: [], targetPaths: [], priority: 1, feedback: 0 }] as KitReadout["tasks"] });
		(s2.readout as { live?: unknown }).live = { task: "t-2", wave: 1, startedAt: 1, elapsedMs: 5 };
		expect(diffDrawerState(s2, "t-2")?.live).toBe(true);

		const done = diffDrawerState(s, "t-done")!;
		expect(done).toEqual({ task: "t-done", live: false, waves: 2, rolledBack: false });
		const quarantined = diffDrawerState(s, "t-q")!;
		expect(quarantined).toEqual({ task: "t-q", live: false, waves: 1, rolledBack: true });

		expect(diffDrawerState(s, "ghost")).toBeUndefined();
		expect(diffDrawerState(s, undefined)).toBeUndefined();
		expect(diffDrawerState(undefined, "t-done")).toBeUndefined();
	});
});

describe("hashDiffTask (unknown deep link → kind note)", () => {
	it("parses a well-formed #/diff/<task> hash, rejects other hashes, tolerates URI-encoded ids", () => {
		expect(hashDiffTask("#/diff/list-parse")).toBe("list-parse");
		expect(hashDiffTask("#/diff/-a-b_c.9"));
		expect(hashDiffTask("#/diff/" + encodeURIComponent("task/1"))).toBe("task/1");
		expect(hashDiffTask("#bad")).toBeUndefined();
		expect(hashDiffTask("#/health")).toBeUndefined();
		expect(hashDiffTask("#/diff/")).toBeUndefined();
		expect(hashDiffTask("#/diff/nested/slash")).toBeUndefined(); // keep deep-link shape strict
	});
});

describe("diffOpenable + latestDiffTask", () => {
	it("a row with a ref or the live wave is openable; todo rows are not", () => {
		const readout = snap({
			tasks: [
				{ id: "a", title: "a", status: "done", waveCount: 1, dependsOn: [], targetPaths: [], priority: 1, feedback: 0, diff: { task: "a", patch: "task-a.patch", bytes: 1, truncated: false } },
				{ id: "b", title: "b", status: "in_progress", waveCount: 0, dependsOn: [], targetPaths: [], priority: 1, feedback: 0 },
				{ id: "c", title: "c", status: "todo", waveCount: 0, dependsOn: ["b"], targetPaths: [], priority: 1, feedback: 0 },
			] as KitReadout["tasks"],
		}).readout;
		expect(diffOpenable(readout.tasks[0]!, readout)).toBe(true);
		expect(diffOpenable(readout.tasks[1]!, readout)).toBe(true);
		expect(diffOpenable(readout.tasks[2]!, readout)).toBe(false);
	});

	it("newest diff patch wins: task-…patch parses to its id; quarantined names strip the wave", () => {
		expect(latestDiffTask([
			{ name: "task-a.patch", kind: "diff", mtimeMs: 10 },
			{ name: "task-a.json", kind: "diff", mtimeMs: 11 },
			{ name: "quarantined-b-w2.patch", kind: "diff", mtimeMs: 20 },
			{ name: "report.json", kind: "other", mtimeMs: 99 },
		])).toBe("b");
		expect(latestDiffTask([{ name: "task-a.patch", kind: "diff", mtimeMs: 30 }, { name: "quarantined-b-w2.patch", kind: "diff", mtimeMs: 20 }])).toBe("a");
		expect(latestDiffTask(undefined)).toBeUndefined();
		expect(latestDiffTask([{ name: "gate-x.log", kind: "gate", mtimeMs: 1 }])).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// M4-a: conversation visibility (§7.5 stage 1) — grouping, drawer lookup, hashes
// ---------------------------------------------------------------------------

function conv(over: Partial<ConvSummary> & Pick<ConvSummary, "id" | "role">): ConvSummary {
	return { entries: 0, resets: 0, compactions: 0, toolRounds: 0, byKind: {}, entriesTruncated: false, usage: { usd: 0, totalTokens: 0 }, ...over };
}

describe("conversationGroups (§7.5 list grouping)", () => {
	const convs: ConvSummary[] = [
		conv({ id: 7, role: "implementer", task: "list-parse", targetPaths: ["src/list.ts"], entries: 9 }),
		conv({ id: 2, role: "implementer", task: "list-parse", entries: 4 }),
		conv({ id: 1, role: "planner", entries: 30 }),
		conv({ id: 5, role: "verifier", entries: 6 }),
		conv({ id: 9, role: "implementer", task: "render-rows", entries: 12 }),
		conv({ id: 3, role: "none", entries: 1 }),
		// a task the router no longer has (stale mapping) still renders, last
		conv({ id: 4, role: "implementer", task: "ghost-task", entries: 2 }),
	];
	const taskOrder = ["render-rows", "list-parse"];

	it("groups planner → per-task (task-table order, unknown last) → verifier → other; rows by id inside a group", () => {
		const groups = conversationGroups(convs, taskOrder);
		expect(groups.map((g) => g.key)).toEqual(["planner", "render-rows", "list-parse", "ghost-task", "verifier", "other"]);
		expect(groups.map((g) => g.rows.map((r) => r.id))).toEqual([[1], [9], [2, 7], [4], [5], [3]]);
	});

	it("several implementer conversations mapping to one task share a group", () => {
		const groups = conversationGroups(convs, taskOrder);
		const listGroup = groups.find((g) => g.key === "list-parse")!;
		expect(listGroup.rows.map((r) => r.id)).toEqual([2, 7]);
		expect(listGroup.rows.every((r) => r.task === "list-parse")).toBe(true);
	});

	it("unknown task order falls back to id order; empty input → no groups; undefined never throws", () => {
		expect(conversationGroups(convs, []).map((g) => g.key)).toEqual(["planner", "ghost-task", "list-parse", "render-rows", "verifier", "other"]);
		expect(conversationGroups([], taskOrder)).toEqual([]);
		expect(conversationGroups(undefined, taskOrder)).toEqual([]);
	});

	it("an implementer conversation without a task lands in other, not a task group", () => {
		const groups = conversationGroups([conv({ id: 1, role: "implementer" }), conv({ id: 2, role: "planner" })], []);
		expect(groups.map((g) => g.key)).toEqual(["planner", "other"]);
	});
});

describe("conversationById (drawer lookup)", () => {
	const convs = [conv({ id: 1, role: "planner" }), conv({ id: 2, role: "implementer", task: "t" })];

	it("finds by numeric id; unknown id / undefined list / undefined id → undefined", () => {
		expect(conversationById(convs, 2)?.task).toBe("t");
		expect(conversationById(convs, 99)).toBeUndefined();
		expect(conversationById(undefined, 1)).toBeUndefined();
		expect(conversationById(convs, undefined)).toBeUndefined();
	});
});

describe("excerptErrorState (A.5 fetch classification)", () => {
	const LOCK_BUSY = "conversation detail returns when the lock is free — a run is live";

	it("the server's lock-busy sentence classifies to the established empty state", () => {
		expect(excerptErrorState(LOCK_BUSY)).toEqual({ kind: "lock-busy" });
		expect(excerptErrorState(`409: ${LOCK_BUSY}`)).toEqual({ kind: "lock-busy" });
	});

	it("anything else stays a plain error the banner quotes", () => {
		expect(excerptErrorState("no conversation #42 in this project")).toEqual({ kind: "error", message: "no conversation #42 in this project" });
		expect(excerptErrorState("HTTP 500")).toEqual({ kind: "error", message: "HTTP 500" });
	});
});

describe("entryKindLabel (A.5 row labels)", () => {
	function entry(over: Partial<ConvEntryView>): ConvEntryView {
		return { id: 1, kind: "pi.user", text: "", ...over };
	}

	it("trims the pi. prefix; unknown/empty kinds do not blank the row", () => {
		expect(entryKindLabel(entry({ kind: "pi.user" }))).toBe("user");
		expect(entryKindLabel(entry({ kind: "pi.assistant" }))).toBe("assistant");
		expect(entryKindLabel(entry({ kind: "seed.entry" }))).toBe("seed.entry"); // non-pi kinds stay verbatim
		expect(entryKindLabel(entry({ kind: "" }))).toBe("entry");
	});

	it("assistant entries name their tool calls; failed tool results say so", () => {
		expect(entryKindLabel(entry({ kind: "pi.assistant", toolCalls: [{ name: "write", input: "{}" }] }))).toBe("assistant · write");
		expect(entryKindLabel(entry({ kind: "pi.assistant", toolCalls: [{ name: "bash", input: "{}" }, { name: "write", input: "{}" }] }))).toBe("assistant · bash, write");
		expect(entryKindLabel(entry({ kind: "pi.tool-result", isError: true }))).toBe("tool-result · failed");
		expect(entryKindLabel(entry({ kind: "pi.tool-result" }))).toBe("tool-result");
	});
});

describe("conversation hash parsing (deep links)", () => {
	it("#/conversations/<id> parses strictly to a safe integer id", () => {
		expect(hashConversationDrawer("#/conversations/12")).toBe(12);
		expect(hashConversationDrawer("#/conversations/007")).toBe(7);
		expect(hashConversationDrawer("#/conversations/")).toBeUndefined();
		expect(hashConversationDrawer("#/conversations")).toBeUndefined(); // the list link, not a drawer
		expect(hashConversationDrawer("#/conversations/abc")).toBeUndefined();
		expect(hashConversationDrawer("#/conversations/1/extra")).toBeUndefined();
		expect(hashConversationDrawer("#/conversations/9007199254740993")).toBeUndefined(); // unsafe integer
		expect(hashConversationDrawer("#/diff/x")).toBeUndefined();
		expect(hashConversationDrawer("#bad")).toBeUndefined();
	});

	it("isConversationListHash matches exactly #/conversations and nothing else", () => {
		expect(isConversationListHash("#/conversations")).toBe(true);
		expect(isConversationListHash("#/conversations/3")).toBe(false);
		expect(isConversationListHash("#/health")).toBe(false);
		expect(isConversationListHash("")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// M3: health panel order (§7.1) — errors → warnings → pass → skipped-labeled
// ---------------------------------------------------------------------------

const hc = (id: string, ok: boolean, severity: HealthCheck["severity"], detail: string): HealthCheck => ({ id, ok, severity, detail });

describe("orderedHealthChecks (health panel order)", () => {
	it("failing errors first, then failing warnings, then passing, skipped checks labeled and last", () => {
		const items = orderedHealthChecks([
			hc("prd", true, "info", "PRD present at docs/prd.md (sha drift check needs the lock)"),
			hc("mirrors", true, "info", "skipped: mirror parity needs the lock"),
			hc("pin", false, "error", "installed pi-durable 0.1 != tested pin"),
			hc("patches", true, "info", "nothing quarantined"),
			hc("alert", false, "warn", "active alert: rate limit"),
			hc("storage-skip", true, "info", "storage-bound aspects skipped: conversation detail (lock busy)"),
		])!;
		expect(items.map((i) => i.check.id)).toEqual(["pin", "alert", "patches", "prd", "mirrors", "storage-skip"]);
		// the PRD check's degrade wording ("sha drift check needs the lock") marks it
		// a skip too — passing "real" checks still come before skipped ones
		expect(items.map((i) => (i.skip ? "skip" : "check"))).toEqual(["check", "check", "check", "skip", "skip", "skip"]);
	});

	it("skipped-in-degraded checks keep ok=true but get the skip flag", () => {
		const item = orderedHealthChecks([hc("status-sidecar", true, "info", "status.json parses (degraded read)")])![0]!;
		expect(item.check.ok).toBe(true);
		expect(item.skip).toBe(true);
	});

	it("undefined/empty health → empty list; undefined never throws", () => {
		expect(orderedHealthChecks(undefined)).toEqual([]);
	});

	it("healthAlertText: first error wins, else the first warn; undefined when all pass", () => {
		const health: HealthCheck[] = [
			hc("prd", true, "info", "PRD present"),
			hc("alert", false, "warn", "active alert: budget"),
			hc("pin", false, "error", "pin mismatch"),
		];
		expect(healthAlertText(health)).toBe("error: pin mismatch");
		expect(healthAlertText([hc("prd", true, "info", "ok")])).toBeUndefined();
		expect(healthAlertText(undefined)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// M3: budget bar data (§9) — spent/ceiling + wave-warn + per-model breakdown
// ---------------------------------------------------------------------------

describe("budgetBarData", () => {
	const usage = {
		sessionUsd: 3,
		ceilingUsd: 4,
		warnUsdPerWave: 0.5,
		spendRateUsdPerWave: 0.25,
		byModel: {
			"b-model": { usage: {} as never, usd: 1 },
			"a-model": { usage: {} as never, usd: 2 },
		},
		source: "storage" as const,
	};

	it("fill fraction, over-ceiling flag, per-model rows sorted desc with shares", () => {
		const bar = budgetBarData(usage);
		expect(bar.spentPct).toBeCloseTo(75);
		expect(bar.over).toBe(false);
		expect(bar.models.map((m) => m.model)).toEqual(["a-model", "b-model"]);
		expect(bar.models[0]!.share).toBeCloseTo(2 / 3);
	});

	it("over the ceiling caps the bar at 100% and flips over", () => {
		const bar = budgetBarData({ ...usage, sessionUsd: 5 });
		expect(bar.spentPct).toBe(100);
		expect(bar.over).toBe(true);
	});

	it("no ceiling → 0 bar; zero total spend → zero shares", () => {
		const zero = budgetBarData({ ...usage, ceilingUsd: 0, byModel: {} });
		expect(zero.spentPct).toBe(0);
		expect(zero.over).toBe(false);
		expect(zero.models).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// M3: event-log filter (§7.1 "filter by task/kind") + keyboard bindings (§10)
// ---------------------------------------------------------------------------

const row = (over: Partial<WaveRow> & Pick<WaveRow, "task" | "kind" | "verb">): WaveRow => ({ ts: 1, ...over });

describe("filterWaveRows (event log)", () => {
	const rows = [
		row({ task: "t1", kind: "wave", wave: 1, verb: "start" }),
		row({ task: "t1", kind: "gate", wave: 1, verb: "fail", detail: "lint:false" }),
		row({ task: "t2", kind: "verdict", wave: 2, verb: "reject:1", verdict: "needs_human", detail: "missing criterion" }),
		row({ task: "t2", kind: "governor", verb: "rate-limit-sleep", reason: "429" }),
	];

	it("empty/blank query returns everything", () => {
		expect(filterWaveRows(rows, "")).toHaveLength(4);
		expect(filterWaveRows(rows, "   ")).toHaveLength(4);
	});

	it("matches task id (+wave suffix), kind, verb, detail, reason — case-insensitive", () => {
		expect(filterWaveRows(rows, "t1")).toHaveLength(2);
		expect(filterWaveRows(rows, "#w1")).toHaveLength(2);
		expect(filterWaveRows(rows, "gate")).toHaveLength(1);
		expect(filterWaveRows(rows, "REJECT")).toHaveLength(1);
		expect(filterWaveRows(rows, "lint")).toHaveLength(1);
		expect(filterWaveRows(rows, "429")).toHaveLength(1);
		expect(filterWaveRows(rows, "no-such-token")).toHaveLength(0);
	});
});

// M4-c: event-log window raise (§13) + task-table row filter
describe("windowedTail (§13 event-log DOM window)", () => {
	it("under the window: everything shows, no truncation", () => {
		const rows = Array.from({ length: 10 }, (_, i) => i);
		expect(windowedTail(rows, 2_000)).toEqual({ shown: rows, hidden: 0, truncated: false });
	});

	it("over the window: the NEWEST rows survive, the cut is counted", () => {
		const rows = Array.from({ length: 10 }, (_, i) => i);
		expect(windowedTail(rows, 4)).toEqual({ shown: [6, 7, 8, 9], hidden: 6, truncated: true });
	});

	it("exactly at the window is not truncation (nothing is hidden)", () => {
		const rows = Array.from({ length: 4 }, (_, i) => i);
		expect(windowedTail(rows, 4)).toEqual({ shown: rows, hidden: 0, truncated: false });
	});

	it("empty input stays empty; one over the §13 default window truncates to 2,000", () => {
		expect(windowedTail([], 4)).toEqual({ shown: [], hidden: 0, truncated: false });
		expect(EVENT_LOG_DOM_WINDOW).toBe(2_000);
		const over = windowedTail(Array.from({ length: 2_001 }, (_, i) => i));
		expect(over.shown).toHaveLength(2_000);
		expect(over.shown[0]).toBe(1);
		expect(over.hidden).toBe(1);
		expect(over.truncated).toBe(true);
	});
});

describe("filterTasks (task-table row filter)", () => {
	const tasks: KitTaskView[] = [
		{ id: "list-parse", title: "Parse the list module", status: "done", waveCount: 1, dependsOn: [], targetPaths: ["src/list.ts"], priority: 1, feedback: 0 },
		{ id: "list-query", title: "Query wiring", status: "in_progress", waveCount: 2, dependsOn: ["list-parse"], targetPaths: ["src/query.ts"], priority: 1, feedback: 1 },
		{ id: "cli-render", title: "Render the CLI", status: "todo", waveCount: 0, dependsOn: ["list-query"], targetPaths: ["src/cli.ts"], priority: 2, feedback: 0 },
		{ id: "docs-sweep", title: "Sweep docs", status: "quarantined", waveCount: 3, dependsOn: [], targetPaths: ["docs/"], priority: 3, feedback: 2 },
	];

	it("blank filter (all statuses + no text) returns everything", () => {
		expect(filterTasks(tasks, { status: "all", text: "" })).toHaveLength(4);
		expect(filterTasks(tasks, { status: "all", text: "   " })).toHaveLength(4);
	});

	it("status chip narrows to exactly that status", () => {
		expect(filterTasks(tasks, { status: "done", text: "" }).map((t) => t.id)).toEqual(["list-parse"]);
		expect(filterTasks(tasks, { status: "todo", text: "" }).map((t) => t.id)).toEqual(["cli-render"]);
		expect(TASK_STATUSES).toEqual(["todo", "in_progress", "done", "quarantined"]);
	});

	it("text matches id, title, dependency, and target path — case-insensitive substring", () => {
		expect(filterTasks(tasks, { status: "all", text: "LIST-P" }).map((t) => t.id)).toEqual(["list-parse", "list-query"]); // own id + the dependency join
		expect(filterTasks(tasks, { status: "all", text: "query wiring" }).map((t) => t.id)).toEqual(["list-query"]); // title
		expect(filterTasks(tasks, { status: "all", text: "list-query" }).map((t) => t.id)).toEqual(["list-query", "cli-render"]); // dependency join only
		expect(filterTasks(tasks, { status: "all", text: "docs/" }).map((t) => t.id)).toEqual(["docs-sweep"]); // target path
	});

	it("status chip AND text combine; no match → empty (the table's kind empty state)", () => {
		expect(filterTasks(tasks, { status: "in_progress", text: "query" }).map((t) => t.id)).toEqual(["list-query"]);
		expect(filterTasks(tasks, { status: "done", text: "query" })).toEqual([]);
	});
});

describe("keyboard binding derivations (§10)", () => {
	const clean = { ctrlKey: false, altKey: false, metaKey: false };

	it("/: focus the filter — but never while typing or with modifiers", () => {
		expect(globalShortcut("/", false, clean)).toBe("filter");
		expect(globalShortcut("/", true, clean)).toBeNull();
		expect(globalShortcut("/", false, { ctrlKey: true, altKey: false, metaKey: false })).toBeNull();
		expect(globalShortcut("/", false, { ctrlKey: false, altKey: false, metaKey: true })).toBeNull();
	});

	it("?: open the shortcut sheet — same guards", () => {
		expect(globalShortcut("?", false, clean)).toBe("sheet");
		expect(globalShortcut("?", true, clean)).toBeNull();
	});

	it("other keys are inert (no destructive single-key shortcuts)", () => {
		expect(globalShortcut("d", false, clean)).toBeNull();
		expect(globalShortcut("Enter", false, clean)).toBeNull();
		expect(globalShortcut("Escape", false, clean)).toBeNull();
	});

	it("Esc precedence: sheet > dialog > drawer > nothing", () => {
		expect(escapeTarget({ sheetOpen: true, dialogOpen: true, drawerOpen: true })).toBe("sheet");
		expect(escapeTarget({ sheetOpen: false, dialogOpen: true, drawerOpen: true })).toBe("dialog");
		expect(escapeTarget({ sheetOpen: false, dialogOpen: false, drawerOpen: true })).toBe("drawer");
		expect(escapeTarget({ sheetOpen: false, dialogOpen: false, drawerOpen: false })).toBeNull();
	});
});

describe("modelPreflight (dialog readiness, §7.2 friendliness)", () => {
	const models = (values: Partial<Record<string, string>>): RoleModelInfo[] =>
		(["planner", "implementer", "verifier"] as const).map((name) => ({ name, provider: values[name]?.split(" ")[0] ?? "", modelId: values[name]?.split(" ")[1] ?? "" }));
	const full: RoleModelInfo[] = [
		{ name: "planner", provider: "anthropic", modelId: "claude-sonnet-4-5" },
		{ name: "implementer", provider: "anthropic", modelId: "claude-sonnet-4-5" },
		{ name: "verifier", provider: "openrouter", modelId: "openai/gpt-5-nano" },
	];

	it("plan needs planner only; run/resume need implementer + verifier", () => {
		expect(rolesNeeded("plan")).toEqual(["planner"]);
		expect(rolesNeeded("run-all")).toEqual(["implementer", "verifier"]);
		expect(rolesNeeded("run-selected")).toEqual(["implementer", "verifier"]);
		expect(rolesNeeded("resume")).toEqual(["implementer", "verifier"]);
	});

	it("configured roles are fine; no snapshot info stays permissive (server is authoritative)", () => {
		expect(modelPreflight("plan", full)).toEqual({ ok: true });
		// roles arrive with every snapshot; the undefined case is "unknown", not "missing"
		expect(modelPreflight("plan", undefined)).toEqual({ ok: true });
	});

	it("empty provider/modelId or a missing role warns with a paste-ready TOML block", () => {
		const result = modelPreflight("plan", models({ implementer: "anthropic/claude-sonnet-4-5" }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.missing).toEqual(["planner"]);
			expect(result.reason).toMatch(/roles\.planner has no model configured/);
			expect(result.snippet).toMatch(/\[roles\.planner\]/);
			expect(result.snippet).toMatch(/provider = "openrouter"/);
			expect(result.snippet).toMatch(/modelId = "openai\/gpt-5-nano"/);
		}
		const runResult = modelPreflight("run-all", models({ planner: "anthropic/claude-sonnet-4-5" }));
		expect(runResult.ok).toBe(false);
		if (!runResult.ok) {
			expect(runResult.missing.sort()).toEqual(["implementer", "verifier"]);
			expect(runResult.snippet).toContain("[roles.implementer]");
			expect(runResult.snippet).toContain("[roles.verifier]");
		}
	});

	it("blank-string provider/modelId count as missing, not ready", () => {
		const blank = models({ planner: "x z", implementer: " / ", verifier: "openrouter openai/gpt-5-nano" });
		expect(modelPreflight("plan", blank).ok).toBe(true);
		expect(modelPreflight("run-all", blank).ok).toBe(false);
	});

	it("a config the readout could not parse disables everything with its reason", () => {
		const result = modelPreflight("plan", undefined, "config.toml is not valid TOML: oops");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/config can't be read/);
			expect(result.snippet).toBe("");
		}
	});

	it("a missing-roles config error becomes the prescriptive warning, mirroring the server", () => {
		const result = modelPreflight("plan", undefined, 'roles.planner: needs provider and modelId — e.g. provider = "openrouter"\n  modelId = "openai/gpt-5-nano"');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.missing).toEqual(["planner"]);
			expect(result.reason).toMatch(/roles\.planner has no model configured/);
			expect(result.snippet).toContain("[roles.planner]");
		}
	});
});

describe("firstFailureLine (failed-job toast reason)", () => {
	it("first non-empty line, trimmed; undefined when no tail", () => {
		expect(firstFailureLine(undefined)).toBeUndefined();
		expect(firstFailureLine([""])).toBeUndefined();
		expect(firstFailureLine(["", "  plan failed: roles.planner needs provider and modelId", "hint: run init"])).toBe("plan failed: roles.planner needs provider and modelId");
	});
});

describe("deliveryReport (§8.6 delivery mode/outcome rows, Appendix A.6 — read-only)", () => {
	const rows = [
		{ ts: 1, task: "t1", verb: "commit-failed", detail: "git commit failed (nothing to commit?)" },
		{ ts: 2, task: "t1", wave: 1, verb: "delivered", detail: "committed: demo: t1 (wave 1)" },
	] as DeliveryRow[];

	it("mode + row count; rows pass through as engine verbs", () => {
		const view = deliveryReport({ mode: "commit", rows });
		expect(view.mode).toBe("commit");
		expect(view.stat).toBe("commit · 2 row(s)");
		expect(view.rows).toEqual(rows);
		expect(view.rows[1]?.verb).toBe("delivered");
	});

	it("mode none with no rows is 'none' (delivery off is the truth, not an error)", () => {
		expect(deliveryReport({ mode: "none", rows: [] })).toEqual({ mode: "none", stat: "none", rows: [] });
	});

	it("mode none keeps any outcome rows visible (e.g. a project that ran with commit mode, then switched config)", () => {
		const view = deliveryReport({ mode: "none", rows });
		expect(view.stat).toBe("none · 2 row(s)");
		expect(view.rows).toHaveLength(2);
	});

	it("a side-car snapshot with an unreadable config: rows stay, the stat says the mode is unknown", () => {
		const view = deliveryReport({ rows });
		expect(view.mode).toBeUndefined();
		expect(view.stat).toBe("2 delivery row(s) — mode unknown");
		// nothing at all (no delivery in the readout — old snapshot shape)
		expect(deliveryReport(undefined)).toEqual({ stat: "unknown", rows: [] });
	});
});

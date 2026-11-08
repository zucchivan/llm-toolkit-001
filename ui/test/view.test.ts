/**
 * Pure view logic (§7.1/§8): view decision, job outcome mapping, plan-review
 * topological order + selection defaults, failure-row toasts.
 */
import { describe, expect, it } from "vitest";
import { decideView, topoOrder, jobOutcome, failureRows, defaultSelection, selectableTasks, diffDrawerState, diffOpenable, latestDiffTask, hashDiffTask, orderedHealthChecks, healthAlertText, budgetBarData, filterWaveRows, globalShortcut, escapeTarget } from "../src/lib/view.ts";
import type { HealthCheck } from "../../src/engine/inspector.ts";
import type { ReadoutSnapshot } from "../src/lib/api.ts";
import type { JobRecord } from "../server/jobs.ts";
import type { KitReadout } from "../../src/engine/inspector.ts";
import type { RouterTask, WaveRow } from "../../src/engine/infos.ts";

function snap(over: Partial<{ phase: string; tasks: KitReadout["tasks"]; mode: "storage" | "sidecars"; storageTasks?: RouterTask[]; sleep?: ReadoutSnapshot["sleep"] }> = {}): ReadoutSnapshot {
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
			artifacts: [],
			health: [],
			...(over.storageTasks ? { storage: { router: { version: 1, phase: "planned", tasks: over.storageTasks }, runStatus: { version: 1, budgetSpentUsd: 0, sleepCycleCount: 0, consecutiveErrors: 0, kitVersion: "k" }, conversations: [], reports: [] } } : {}),
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

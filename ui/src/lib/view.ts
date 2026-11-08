/**
 * Pure view derivation for the one phase-aware page (§7.1/§8): readout + jobs →
 * the view to render, action enabling, plan-review selection, failure rows for
 * toasts. No DOM, no Svelte — unit-testable.
 */
import type { ReadoutSnapshot, JobsPayload } from "./api.ts";
import type { JobRecord } from "../../server/jobs.ts";
import type { KitTaskView, KitUsage, HealthCheck } from "../../../src/engine/inspector.ts";
import type { RouterTask, WaveRow } from "../../../src/engine/infos.ts";

export type PhaseView = "connecting" | "setup" | "planning" | "review" | "monitor" | "report";

export interface ViewDecision {
	view: PhaseView;
	/** The running non-handoff job, when any (plan-job → planning, run-job → monitor). */
	activeJob?: JobRecord;
	/** Newest ended run job whose exit code still drives the visible state. */
	lastRunJob?: JobRecord;
	/** Sleep banner state: a run ended with exit 42 and nothing is running. */
	sleeping: { until?: number; cycleCount?: number } | undefined;
	/** Tasks still todo (Run again / Run selected enablement). */
	todo: KitTaskView[];
	/** Plan-review data when the full router is available (storage mode). */
	planTasks: RouterTask[] | undefined;
	/** True when every task reached done/quarantined. */
	allTerminal: boolean;
	/** A terminal-started run (never stoppable from the UI). */
	attachedPid?: number;
}

/** Exit-code mapping (§7.3): 0 ok · 42 sleeping · 130 interrupted · else failed. */
export type JobOutcome = "ok" | "sleeping" | "interrupted" | "failed" | "none";
export function jobOutcome(exitCode: number | undefined): JobOutcome {
	if (exitCode === undefined) return "none";
	if (exitCode === 0) return "ok";
	if (exitCode === 42) return "sleeping";
	if (exitCode === 130) return "interrupted";
	return "failed";
}

export function decideView(snapshot: ReadoutSnapshot | undefined, jobs: JobsPayload | undefined): ViewDecision {
	const empty: ViewDecision = { view: "connecting", sleeping: undefined, todo: [], planTasks: undefined, allTerminal: false };
	if (!snapshot || !jobs) return empty;
	const readout = snapshot.readout;

	const mutationJobs = jobs.jobs.filter((j) => j.status === "running" && j.kind !== "handoff");
	const activeJob = mutationJobs.sort((a, b) => b.startedAt - a.startedAt)[0];
	const planJob = activeJob?.kind === "plan" ? activeJob : undefined;
	const runJob = activeJob?.kind === "run" ? activeJob : undefined;
	const endedRuns = jobs.jobs
		.filter((j) => j.kind === "run" && (j.status === "exited" || j.status === "failed" || j.status === "stale"))
		.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
	const lastRunJob = endedRuns[0];

	const tasks = readout.tasks;
	const allTerminal = tasks.length > 0 && tasks.every((t) => t.status === "done" || t.status === "quarantined");
	const todo = tasks.filter((t) => t.status === "todo");

	// Sleep banner: status.json's armed sleep; a live run has none (it clears it on wake).
	const sleeping = runJob === undefined && snapshot.sleep !== undefined
		? { until: snapshot.sleep.until, cycleCount: snapshot.sleep.cycleCount }
		: undefined;

	let view: PhaseView;
	if (planJob) view = "planning";
	else if (runJob) view = "monitor";
	else if (readout.phase === "planning") view = "planning"; // terminal-started plan (attach case)
	else if (readout.phase === "planned") view = "review";
	else if (allTerminal || readout.phase === "complete") view = "report";
	else if (tasks.length === 0 && (readout.phase === "empty" || readout.phase === "unknown")) view = "setup";
	else view = "monitor";

	// The full router only comes in storage mode; review needs it (spec/acceptance/deps).
	const planTasks = readout.storage?.router.tasks;

	return {
		view,
		activeJob,
		lastRunJob,
		sleeping,
		todo,
		planTasks,
		allTerminal,
		attachedPid: jobs.attached?.pid,
	};
}

// ---------------------------------------------------------------------------
// Plan review (§8.2): topological cards + selection
// ---------------------------------------------------------------------------

export interface PlanCard {
	task: RouterTask;
	depsSatisfied: boolean;
}

/** Stable topological order (Kahn, original-index tiebreak); cycles fall back to input order. */
export function topoOrder(tasks: RouterTask[]): RouterTask[] {
	const byId = new Map(tasks.map((t, i) => [t.id, { t, i }]));
	const remaining = new Set(taskIds(tasks));
	const ordered: RouterTask[] = [];
	const indegree = new Map<string, number>();
	for (const t of tasks) indegree.set(t.id, t.dependsOn.filter((d) => remaining.has(d) && d !== t.id).length);
	for (;;) {
		const next = [...remaining]
			.map((id) => byId.get(id))
			.filter((e): e is { t: RouterTask; i: number } => e !== undefined && (indegree.get(e.t.id) ?? 0) === 0)
			.sort((a, b) => a.i - b.i);
		if (next.length === 0) break; // cycle: leave the rest in input order
		for (const entry of next) {
			ordered.push(entry.t);
			remaining.delete(entry.t.id);
			for (const t of tasks) {
				if (remaining.has(t.id) && t.dependsOn.includes(entry.t.id)) {
					indegree.set(t.id, Math.max(0, (indegree.get(t.id) ?? 1) - 1));
				}
			}
		}
	}
	for (const id of remaining) {
		const entry = byId.get(id);
		if (entry) ordered.push(entry.t);
	}
	return ordered;
}

function taskIds(tasks: RouterTask[]): string[] {
	return tasks.map((t) => t.id);
}

/** Dependence check: every named dep exists and is `done` (done/empty deps pass). */
export function depsDone(task: RouterTask, all: RouterTask[]): boolean {
	return task.dependsOn.every((dep) => {
		const found = all.find((t) => t.id === dep);
		return found === undefined || found.status === "done";
	});
}

/** Selectable now: no unsatisfied todo dependency (done/empty deps pass). */
export function selectableTasks(planTasks: RouterTask[] | undefined): RouterTask[] {
	if (!planTasks) return [];
	return planTasks.filter((t) => depsDone(t, planTasks));
}

/** Default selection: every selectable task that is still actionable. */
export function defaultSelection(planTasks: RouterTask[] | undefined): string[] {
	if (!planTasks) return [];
	return planTasks
		.filter((t) => t.status === "todo" && depsDone(t, planTasks))
		.map((t) => t.id);
}

// ---------------------------------------------------------------------------
// Diff drawer (M2, §7.4): mode/label derivation from the snapshot
// ---------------------------------------------------------------------------

/** Task-table sort (§15.1): keep the plan order, or failing-first by status. */
export type TaskSort = "plan" | "status";

/** Status rank: problems above todo above done; the plan order in a status. */
const STATUS_RANK: Record<string, number> = { quarantined: 0, in_progress: 1, todo: 2, done: 3 };

/** Table order: plan order (stable input), or status-failing-first (stable). */
export function sortedTasks(tasks: KitTaskView[], sort: TaskSort): KitTaskView[] {
	if (sort === "plan") return tasks;
	return [...tasks].sort((a, b) => (STATUS_RANK[a.status] ?? 4) - (STATUS_RANK[b.status] ?? 4));
}

export interface DiffDrawerState {
	task: string;
	/** live preview while the wave is in flight; persisted patch otherwise */
	live: boolean;
	/** task.waveCount for "cumulative since baseline, N waves" */
	waves: number;
	/** quarantined → the tree was rolled back; the drawer shows the rollback badge */
	rolledBack: boolean;
}

/** Drawer state for one task id (or undefined when the task is unknown). */
export function diffDrawerState(snapshot: ReadoutSnapshot | undefined, task: string | undefined): DiffDrawerState | undefined {
	if (!snapshot || !task) return undefined;
	const t = snapshot.readout.tasks.find((x) => x.id === task);
	if (!t) return undefined;
	return {
		task,
		live: t.status === "in_progress" || snapshot.readout.live?.task === task,
		waves: Math.max(1, t.waveCount),
		rolledBack: t.status === "quarantined",
	};
}

/** The task id a `#/diff/<task>` deep link names, if the hash is well-formed. Pure: tests + the unknown-task drawer note. */
export function hashDiffTask(hash: string): string | undefined {
	const match = /^#\/diff\/([\w.%-]+)$/.exec(hash);
	if (!match) return undefined;
	const task = decodeURIComponent(match[1] ?? "");
	return task.length > 0 ? task : undefined;
}

/** Whether a row/summary can open a diff at all (persisted ref or live wave). */
export function diffOpenable(task: KitTaskView, readout: ReadoutSnapshot["readout"]): boolean {
	return task.diff !== undefined || task.status === "in_progress" || readout.live?.task === task.id;
}

/** Newest diff-bearing patch artifact's task id (jobs panel shortcut). */
export function latestDiffTask(artifacts: Array<{ name: string; kind: string; mtimeMs: number }> | undefined): string | undefined {
	const patches = (artifacts ?? [])
		.filter((a) => a.kind === "diff" && a.name.endsWith(".patch"))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const name = patches[0]?.name;
	if (!name) return undefined;
	if (name.startsWith("task-")) return name.slice("task-".length, -".patch".length);
	return name.slice("quarantined-".length).replace(/-w\d+\.patch$/, "");
}

// ---------------------------------------------------------------------------
// M3: health panel (§7.1) — errors + warnings first, skipped checks labeled
// ---------------------------------------------------------------------------

/** One check with its derived "skipped-in-degraded" flag (§11 sidecars mode). */
export interface HealthItem {
	check: HealthCheck;
	/** The check ran in degraded mode and only reports that it was skipped. */
	skip: boolean;
}

/** Skipped-in-degraded wording the engine writes into details (inspector.ts). */
const SKIP_PATTERN = /skipped|needs the lock|degraded read/;

/** Sort checks: failing errors → failing warnings → passing → skipped. Natural order elsewhere. */
export function orderedHealthChecks(health: HealthCheck[] | undefined): HealthItem[] {
	if (!health) return [];
	const ranked = health.map((check, i) => ({ check, skip: check.ok && SKIP_PATTERN.test(check.detail), i }));
	const rank = (item: { check: HealthCheck; skip: boolean }): number => {
		if (!item.check.ok) return item.check.severity === "error" ? 0 : 1;
		return item.skip ? 3 : 2;
	};
	return ranked.sort((a, b) => rank(a) - rank(b) || a.i - b.i).map(({ check, skip }) => ({ check, skip }));
}

/** Header alert text (§7.1 "health dot and alert text"): first failing check, errors first. */
export function healthAlertText(health: HealthCheck[] | undefined): string | undefined {
	const failing = (health ?? []).filter((c) => !c.ok);
	const first = failing.find((c) => c.severity === "error") ?? failing[0];
	return first ? `${first.severity}: ${first.detail}` : undefined;
}

// ---------------------------------------------------------------------------
// M3: budget bar (§9) — spent/ceiling + wave-warn + per-model breakdown
// ---------------------------------------------------------------------------

export interface ModelSpendRow {
	model: string;
	usd: number;
	/** share of the session's total spend (0..1, for mini bars) */
	share: number;
}

/** Read-only BudgetBar derivation: fill fraction, over-ceiling flag, top per-model rows. */
export function budgetBarData(usage: Pick<KitUsage, "sessionUsd" | "ceilingUsd" | "warnUsdPerWave" | "spendRateUsdPerWave" | "byModel" | "source">): {
	spentPct: number;
	over: boolean;
	models: ModelSpendRow[];
} {
	const spentPct = usage.ceilingUsd > 0 ? Math.min(100, (usage.sessionUsd / usage.ceilingUsd) * 100) : 0;
	const models = Object.entries(usage.byModel)
		.map(([model, entry]): ModelSpendRow => ({ model, usd: entry.usd, share: 0 }))
		.sort((a, b) => b.usd - a.usd);
	const total = models.reduce((n, m) => n + m.usd, 0);
	return { spentPct, over: usage.ceilingUsd > 0 && usage.sessionUsd >= usage.ceilingUsd, models: total > 0 ? models.map((m) => ({ ...m, share: m.usd / total })) : models.map((m) => ({ ...m, share: 0 })) };
}

// ---------------------------------------------------------------------------
// M3: event-log filter (§7.1 "filter by task/kind") + keyboard bindings (§10)
// ---------------------------------------------------------------------------

/** Case-insensitive substring match across task(+wave), kind, verb, detail, reason. Empty/null → everything. */
export function filterWaveRows<T extends Pick<WaveRow, "task"> & Pick<WaveRow, "kind" | "verb"> & Partial<Pick<WaveRow, "wave" | "detail" | "reason">>>(rows: readonly T[], rawQuery: string): T[] {
	const q = rawQuery.trim().toLowerCase();
	if (!q) return [...rows];
	return rows.filter((r) => {
		const hay = `${r.task}${r.wave !== undefined ? ` #w${r.wave}` : ""} ${r.kind} ${r.verb} ${r.detail ?? ""} ${r.reason ?? ""}`;
		return hay.toLowerCase().includes(q);
	});
}

export type ShortcutAction = "filter" | "sheet";

/** Non-destructive global keys (§10): "/" focuses the event filter, "?" opens
    the shortcut sheet. Nothing happens while typing or with modifiers held. */
export function globalShortcut(key: string, typing: boolean, mods: { ctrlKey: boolean; altKey: boolean; metaKey: boolean }): ShortcutAction | null {
	if (typing || mods.ctrlKey || mods.altKey || mods.metaKey) return null;
	if (key === "/") return "filter";
	if (key === "?") return "sheet";
	return null;
}

export type EscapeTarget = "sheet" | "dialog" | "drawer";

/** Esc precedence: shortcut sheet → confirmation dialog (closes itself) → drawer. */
export function escapeTarget(state: { sheetOpen: boolean; dialogOpen: boolean; drawerOpen: boolean }): EscapeTarget | null {
	if (state.sheetOpen) return "sheet";
	if (state.dialogOpen) return "dialog"; // ActionDialog handles its own Escape
	if (state.drawerOpen) return "drawer";
	return null;
}

// ---------------------------------------------------------------------------
// Failure toast input: rows newer than the last seen monster
// ---------------------------------------------------------------------------

export interface FailureRow {
	ts: number;
	severity: "error" | "warn";
	text: string;
}

/** Wave-log rows worth a toast: gate failures, rejections, quarantines, sleeps. */
export function failureRows(rows: { ts: number; kind: string; task: string; wave?: number; verb: string; detail?: string; verdict?: string; reason?: string }[]): FailureRow[] {
	const out: FailureRow[] = [];
	for (const row of rows) {
		if (row.kind === "gate" && row.verb === "fail") {
			out.push({ ts: row.ts, severity: "error", text: `gate failed — ${row.task}${row.wave !== undefined ? ` #w${row.wave}` : ""}: ${row.detail ?? "(no detail)"}` });
		} else if (row.kind === "verdict" && row.verb.startsWith("reject") && row.verdict !== "approve") {
			out.push({ ts: row.ts, severity: "error", text: `verifier ${row.verdict ?? "rejected"} — ${row.task}${row.wave !== undefined ? ` #w${row.wave}` : ""}: ${row.detail ?? ""}` });
		} else if (row.kind === "task" && row.verb === "quarantined") {
			out.push({ ts: row.ts, severity: "error", text: `quarantined — ${row.task}: ${row.reason ?? row.detail ?? "rolled back"}` });
		} else if (row.kind === "governor" && row.verb === "rate-limit-sleep") {
			out.push({ ts: row.ts, severity: "warn", text: `provider reset — durable sleep armed: ${row.detail ?? row.reason ?? ""}` });
		} else if (row.kind === "wave" && row.verb === "end" && (row.detail ?? "").startsWith("fail")) {
			out.push({ ts: row.ts, severity: "warn", text: `wave end — ${row.task}${row.wave !== undefined ? ` #w${row.wave}` : ""}: ${row.detail ?? ""}` });
		}
	}
	return out;
}

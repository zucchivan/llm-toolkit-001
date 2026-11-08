/**
 * Pure view derivation for the one phase-aware page (§7.1/§8): readout + jobs →
 * the view to render, action enabling, plan-review selection, failure rows for
 * toasts. No DOM, no Svelte — unit-testable.
 */
import type { ReadoutSnapshot, JobsPayload, RoleModelInfo } from "./api.ts";
import type { JobRecord } from "../../server/jobs.ts";
import type { KitTaskView, KitUsage, HealthCheck, ConvSummary, ConvEntryView, DeliveryRow, DeliveryView } from "../../../src/engine/inspector.ts";
import type { RouterTask, WaveRow } from "../../../src/engine/infos.ts";
import type { RoleName } from "../../../src/config.ts";

// ---------------------------------------------------------------------------
// Model readiness (§7.2 friendliness): a plan/run/verify only makes sense
// when its roles name a provider+model in .orch/config.toml. The dialogs
// show the configured models as chips and — when a needed role is empty —
// a kind warning with a paste-ready TOML block instead of a doomed job.
// Server-side twin: ui/server/actions.ts configPreflight (422 backstop).
// ---------------------------------------------------------------------------

export type DialogKind = "plan" | "run-all" | "run-selected" | "resume";

/** The roles a dialog's action will need (stop/handoff/export need none). */
export function rolesNeeded(kind: DialogKind): readonly RoleName[] {
	switch (kind) {
		case "plan":
			return ["planner"];
		case "run-all":
		case "run-selected":
		case "resume":
			return ["implementer", "verifier"];
	}
}

export type ModelPreflight = { ok: true } | { ok: false; missing: string[]; reason: string; snippet: string };

/**
 * Client-side mirror of the server's configPreflight, from the snapshot's
 * `roles` extra (fetched per read; the server stays authoritative — this
 * just makes the DIALOG say it before the POST is even sent). Unknown role
 * info (no snapshot yet / degraded-without-extras) stays permissive: unknown
 * is not missing — the server's 422 backstop catches what this can't see.
 */
export function modelPreflight(kind: DialogKind, roles?: RoleModelInfo[], configError?: string): ModelPreflight {
	if (configError) {
		// Mirror the server: when the config error IS the missing-roles diagnostic
		// (the loader bails on the first role block with no provider/modelId),
		// quote the named missing roles prescriptively; anything else stays a
		// plain unreadable-config reason.
		const named: string[] = [];
		for (const match of configError.matchAll(/roles\.([A-Za-z_][A-Za-z0-9_]*): needs provider and modelId/g)) named.push(match[1]!);
		if (named.length > 0) {
			return {
				ok: false,
				missing: named,
				reason: `${named.map((r) => `roles.${r}`).join(", ")} has no model configured`,
				snippet: named.map((role) => `[roles.${role}]\nprovider = "openrouter"\nmodelId = "openai/gpt-5-nano"`).join("\n\n"),
			};
		}
		return {
			ok: false,
			missing: [],
			reason: `the project config can't be read, so this action can't start: ${configError}`,
			snippet: "",
		};
	}
	if (!roles) return { ok: true };
	const missing = rolesNeeded(kind).filter((name) => {
		const r = roles?.find((x) => x.name === name);
		return !r || !r.provider?.trim() || !r.modelId?.trim();
	});
	if (missing.length === 0) return { ok: true };
	const snippet = missing.map((role) => `[roles.${role}]\nprovider = "openrouter"\nmodelId = "openai/gpt-5-nano"`).join("\n\n");
	return {
		ok: false,
		missing,
		reason: `${missing.map((r) => `roles.${r}`).join(", ")} has no model configured`,
		snippet,
	};
}

/** First diagnostic line of a failed job's log tail (ANSI already stripped server-side); undefined when none. */
export function firstFailureLine(tail?: string[]): string | undefined {
	return tail?.find((line) => line.trim().length > 0)?.trim();
}

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
// M4-a: conversation visibility (§7.5, stage 1 — summaries only; transcript
// content is stage 2 and needs the Appendix A.5 seam, still pending)
// ---------------------------------------------------------------------------

export interface ConversationGroup {
	/** Group key: "planner", a task id, "verifier", or "other" (role-less). */
	key: string;
	rows: ConvSummary[];
}

/**
 * §7.5 conversation list, grouped sensibly: the planner's conversation first,
 * then one group per task that has implementer conversations (several can map
 * to one task — ordered by the task table's order, unknown tasks last), then
 * verifier conversations, then anything role-less. Rows sort by conversation
 * id inside a group.
 */
export function conversationGroups(conversations: ConvSummary[] | undefined, taskOrder: string[]): ConversationGroup[] {
	if (!conversations || conversations.length === 0) return [];
	const byId = [...conversations].sort((a, b) => a.id - b.id);
	const planner: ConvSummary[] = [];
	const verifier: ConvSummary[] = [];
	const other: ConvSummary[] = [];
	const byTask = new Map<string, ConvSummary[]>();
	for (const conv of byId) {
		if (conv.role === "implementer" && conv.task) {
			const list = byTask.get(conv.task);
			if (list) list.push(conv);
			else byTask.set(conv.task, [conv]);
		} else if (conv.role === "planner") planner.push(conv);
		else if (conv.role === "verifier") verifier.push(conv);
		else other.push(conv);
	}
	const rank = (task: string): number => {
		const i = taskOrder.indexOf(task);
		return i === -1 ? Number.MAX_SAFE_INTEGER : i;
	};
	const groups: ConversationGroup[] = [];
	if (planner.length > 0) groups.push({ key: "planner", rows: planner });
	for (const key of [...byTask.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
		groups.push({ key, rows: byTask.get(key)! });
	}
	if (verifier.length > 0) groups.push({ key: "verifier", rows: verifier });
	if (other.length > 0) groups.push({ key: "other", rows: other });
	return groups;
}

/** One conversation by id (the drawer's data); undefined for unknown ids or no storage. */
export function conversationById(conversations: ConvSummary[] | undefined, id: number | undefined): ConvSummary | undefined {
	if (id === undefined || !conversations) return undefined;
	return conversations.find((c) => c.id === id);
}

/** The conversation id a `#/conversations/<id>` deep link names; undefined for any other hash (strict shape, like hashDiffTask). */
export function hashConversationDrawer(hash: string): number | undefined {
	const match = /^#\/conversations\/(\d+)$/.exec(hash);
	if (!match) return undefined;
	const id = Number(match[1]);
	return Number.isSafeInteger(id) ? id : undefined;
}

/** Whether the hash is exactly `#/conversations` — the list deep link (sibling of `#/health`). */
export function isConversationListHash(hash: string): boolean {
	return hash === "#/conversations";
}

// ---------------------------------------------------------------------------
// M4-a stage 2: transcript excerpts (§18 fast-follow, Appendix A.5) — the
// drawer's excerpt state + kind labels. The fetch itself lives in api.ts.
// ---------------------------------------------------------------------------

/** The excerpt's client state: loading → ready | lock-busy (the established empty state) | error. */
export type ExcerptState =
	| { kind: "loading" }
	| { kind: "ready"; entries: ConvEntryView[]; truncated: boolean }
	| { kind: "lock-busy" }
	| { kind: "error"; message: string };

/**
 * Classify a failed excerpt fetch (pure, so the 409 wording stays in one
 * place): the server's lock-busy answer speaks the established sentence —
 * anything else is a plain error the banner quotes.
 */
export function excerptErrorState(message: string): Extract<ExcerptState, { kind: "lock-busy" } | { kind: "error" }> {
	if (/lock is free — a run is live/.test(message)) return { kind: "lock-busy" };
	return { kind: "error", message };
}

/** Kind label for one excerpt row: the "pi." prefix trimmed; tool calls and failures named. */
export function entryKindLabel(entry: Pick<ConvEntryView, "kind" | "toolCalls" | "isError">): string {
	const kind = entry.kind.replace(/^pi\./, "") || "entry";
	if (entry.toolCalls && entry.toolCalls.length > 0) {
		return `${kind} · ${entry.toolCalls.map((c) => c.name).join(", ")}`;
	}
	if (entry.kind === "pi.tool-result" && entry.isError) return `${kind} · failed`;
	return kind;
}

// ---------------------------------------------------------------------------
// M4-b: delivery truth (§8.6 "delivery mode/outcome rows", Appendix A.6) — a
// READ-ONLY report section. The mode/outcome surface just says what ran; there
// is deliberately no toggle action: delivery is a config + CLI decision (§5),
// the CLI's only delivery paths are .orch/config.toml's delivery.mode and the
// --deliver run qualifier the pr mode requires (a per-run override, not a
// safe toggle), and config editors stay deferred to M5 (§18).
// ---------------------------------------------------------------------------

/** The readout's delivery truth reworded for the completion report. */
export interface DeliveryReportView {
	/** The configured mode from .orch/config.toml; undefined = side-car mode with an unreadable config. */
	mode?: string;
	/** The stat cell text: mode + row count, or "unknown" when the readout carries neither. */
	stat: string;
	/** The outcome rows, engine verbs verbatim ("delivered", "commit-failed", "pr-skip", …). */
	rows: DeliveryRow[];
}

export function deliveryReport(delivery: DeliveryView | undefined): DeliveryReportView {
	const rows = delivery?.rows ?? [];
	const mode = delivery?.mode;
	if (mode === undefined) {
		return { stat: rows.length > 0 ? `${rows.length} delivery row(s) — mode unknown` : "unknown", rows };
	}
	return { mode, stat: rows.length > 0 ? `${mode} · ${rows.length} row(s)` : mode, rows };
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
// M4-c: event-log window raise (§13) — the DOM window the M3 record deferred
// (300) is raised to §13's 2,000-row windowed tail, with an explicit
// "truncated — showing newest N of M" notice. The server readout carries the
// FULL wave-log tail (no server-side cap — readout build stays the engine's
// job and CompletionReport's wall clock reads rows[0]); the notice names both
// numbers so what is cut is never hidden.
// ---------------------------------------------------------------------------

/** §13's event-log DOM window: the newest N rows rendered, older ones cut. */
export const EVENT_LOG_DOM_WINDOW = 2_000;

/** The windowed tail: the newest `max` rows plus how many were cut (the notice numbers). */
export function windowedTail<T>(rows: readonly T[], max: number = EVENT_LOG_DOM_WINDOW): { shown: T[]; hidden: number; truncated: boolean } {
	if (rows.length <= max) return { shown: [...rows], hidden: 0, truncated: false };
	return { shown: rows.slice(rows.length - max), hidden: rows.length - max, truncated: true };
}

// ---------------------------------------------------------------------------
// M4-c: task-table row filter (§7.1's dense table) — the §13/§16 deferral the
// M3 record documented ("row filtering stays a §13/§16 deferral") ships as a
// small status chip + text match (id/title/deps), sibling of the event log's
// filter. Sorting (sortedTasks) composes on top.
// ---------------------------------------------------------------------------

/** The status chip: one concrete status, or "all" (no status constraint). */
export type TaskStatusFilter = "all" | KitTaskView["status"];

/** The task-table filter: a status chip plus a case-insensitive text match. */
export interface TaskTableFilter {
	status: TaskStatusFilter;
	/** Case-insensitive substring over id, title, dependsOn, target paths; blank → all. */
	text: string;
}

/** The concrete statuses the filter chip offers (TaskTable order, not rank). */
export const TASK_STATUSES: readonly KitTaskView["status"][] = ["todo", "in_progress", "done", "quarantined"];

/** Row filter: status chip AND text match; blank chip + blank text → everything. */
export function filterTasks(tasks: readonly KitTaskView[], filter: TaskTableFilter): KitTaskView[] {
	const q = filter.text.trim().toLowerCase();
	return tasks.filter((t) => {
		if (filter.status !== "all" && t.status !== filter.status) return false;
		if (!q) return true;
		const hay = `${t.id} ${t.title} ${t.dependsOn.join(" ")} ${t.targetPaths.join(" ")}`;
		return hay.toLowerCase().includes(q);
	});
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

// ---------------------------------------------------------------------------
// M5-a/M5-b: read-only project sources (config + PRD + PROMPT.md + gate
// recipes viewers, §5/§18) — per-file chip labels. One glyph+label per file;
// the worst fact wins so the header never lies about a file it merely carried
// raw.
// ---------------------------------------------------------------------------

export type SourceChip = { kind: "ok"; label: "ok" | "ok · absent" } | { kind: "missing"; label: "missing" | "absent" } | { kind: "parse-error"; label: "parse error" } | { kind: "capped"; label: "ok · capped" } | { kind: "binary"; label: "binary" } | { kind: "unloaded"; label: "…" };

/** Chip for one source file; the worst fact wins (parse error → capped → binary → missing → ok). */
export function sourceChip(file: { exists: boolean; truncated?: boolean; binary?: boolean }, parseError?: string): SourceChip {
	if (parseError) return { kind: "parse-error", label: "parse error" };
	if (!file.exists) return { kind: "missing", label: "missing" };
	if (file.truncated) return { kind: "capped", label: "ok · capped" };
	if (file.binary) return { kind: "binary", label: "binary" };
	return { kind: "ok", label: "ok" };
}

/**
 * M5-b: PROMPT.md chip. Nothing parses it (raw markdown — no verdict beyond
 * the §11.4 facts), and its ABSENCE is a warn, not an error: the engine
 * reads it best-effort each wave (waves.ts), so a missing file means every
 * wave input assembles without the per-wave discipline doc — amber
 * "absent", with the panel's note telling you how to fix it.
 */
export function promptChip(file: { exists: boolean; truncated?: boolean; binary?: boolean }): SourceChip {
	if (!file.exists) return { kind: "missing", label: "absent" };
	return sourceChip(file);
}

/**
 * M5-b: evals/recipes.toml chip; the verdict is the engine gate loader's.
 * An ABSENT file is a DEFINED state (empty gates = scope check only,
 * gates.ts) — green "ok · absent", surfaced only inside the panel; a broken
 * file is the plain-words error the next wave's gate step throws — parse
 * error wins over every §11.4 fact.
 */
export function recipesChip(file: { exists: boolean; truncated?: boolean; binary?: boolean }, parseError?: string): SourceChip {
	const chip = sourceChip(file, parseError);
	if (chip.kind === "missing") return { kind: "ok", label: "ok · absent" };
	return chip;
}

/**
 * M5-b header summary: the worst chip across the four sources — severity
 * first (parse error > missing > binary > capped > ok), not merely position,
 * so a red recipes verdict outranks an amber PROMPT.md absence.
 */
export function worstSourceChip(chips: SourceChip[]): SourceChip | undefined {
	const rank: Record<SourceChip["kind"], number> = { "parse-error": 5, missing: 4, binary: 3, capped: 2, ok: 1, unloaded: 0 };
	let worst: SourceChip | undefined;
	let worstRank = -1;
	for (const chip of chips) {
		const r = rank[chip.kind] ?? 0;
		if (r > worstRank) {
			worst = chip;
			worstRank = r;
		}
	}
	return worst;
}

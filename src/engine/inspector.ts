/**
 * inspector.ts — the read-only visibility seam (docs/concepts.md § visibility).
 *
 * `readout()` assembles everything the kit can show about a project into ONE
 * `KitReadout` object. Two readable modes, chosen by the caller:
 *
 *  - storage mode (`{ loop }`): we hold `.orch/lock`, so durable storage is
 *    ours to read. Everything is present: the three session docs,
 *    conversation summaries (role, entry counts, per-conversation usage),
 *    per-task/per-model cost splits, mirror parity, full health checks.
 *  - side-car mode (`{}`): storage is owned elsewhere (a live run). Only the
 *    atomic side-cars are read: `.orch/status.json` + `.orch/wave-log.jsonl`
 *    (+ directory listings). Storage-bound sections stay absent and health
 *    marks them skipped.
 *
 * Strictly read-only: never writes docs, mirrors, or side-cars; never opens
 * storage in side-car mode; the one storage read is a commit that touches
 * tables only (`scanConversations`/`scanEntries`) — the same established
 * table-read pattern as `ConversationKit.readAnswerText`. pi-durable is
 * reached only through the `kit.ts`/`harness.ts` seam (§3.10).
 *
 * A.5 adds `conversationEntries()`: the same gated table-scan pattern serves
 * bounded, plain-JSON transcript excerpts to the UI. The seam version stays
 * `readout.seam = 1` — A.5 is additive surface, not a new seam version.
 *
 * M1-P01 step (g): every host file read here (the status side-car, the
 * `.orch/artifacts` listing and its text/stats, the PRD, `router.md` and
 * `.orch/wave-log.jsonl`) goes through the canonical-root + no-follow, capped
 * boundary in one resolved root per readout. A genuine ENOENT stays the defined
 * empty/absent state; a REFUSED read (symlink at any component, hard link,
 * non-regular leaf, permission, platform, cap, escape) throws
 * `SafeReadRefusalError` — no partial readout, no outside bytes and no
 * fabricated empty section. The config is awaited (no sync production read).
 */
import { readSessionState } from "./state.ts";
import { latestFrozenCheckpoint, latestReceiptStates, ReceiptsDoc } from "./receipts.ts";
import type { FrozenCheckpointView, ReceiptEvent, ReceiptStateView } from "./receipts.ts";
import { renderRouterMd, renderWaveLogJsonl } from "./infos.ts";
import type { RouterTask, RouterDocValue, RunStatusDocValue, TaskStatus, WaveRow } from "./infos.ts";
import {
	estimateUsageUsd,
	roleRatesFor,
	LoopGuardDoc,
	UsageDoc,
	PD_VERSION,
} from "./harness.ts";
import type {
	LoopAndLock,
	ProjectPaths,
	StatusPayloads,
	ReportRow,
	Usage,
} from "./harness.ts";
import type { SessionState } from "./state.ts";
import { BACKGROUND_CONTEXT, convId, readInstalledPiDurableVersion } from "./kit.ts";
import type { Cursor, EntryRecord } from "./kit.ts";
import type { CostRates } from "../util/budget.ts";
import { usageUsd } from "../util/budget.ts";
import { KIT_VERSION, loadConfig } from "../config.ts";
import type { KitConfig } from "../config.ts";
import { shasum } from "../util/git.ts";
import { openSafeDirectory, readSafeText, requireSafeReadRoot, SafeReadRefusalError } from "../util/safe-read.ts";
import type { SafeDirectory } from "../util/safe-read.ts";

// ---------------------------------------------------------------------------
// Readout shape: one type every view renders from
// ---------------------------------------------------------------------------

export interface KitIdentity {
	kit: string;
	piDurable: string;
	root: string;
	/** pid owning `.orch/lock`: ours in storage mode, the live run's in side-car mode. */
	lockedByPid?: number;
	at: number;
}

/**
 * P15: the four receipt-derived labels every report renders — the CLI views
 * and the UI share this ONE derivation so their wording can never drift.
 * Receipts are observed facts: a missing receipt is "no receipt", never an
 * inferred outcome (a quarantine row alone does not say "discarded"; an
 * approval alone does not say "published").
 */
export interface ReceiptLabels {
	/** Review passes: "accepted" when the acceptance receipt exists, else the
	 *  newest recorded pass verdict, else "no receipt". */
	review: string;
	/** Gate receipt outcome: "pass" / "fail" / "no receipt". */
	checks: string;
	/** Workspace-disposal (rollback) receipt: "discarded" is ONLY ever the
	 *  confirmed receipt; otherwise the recorded pending/failed/unknown state
	 *  or "no receipt". */
	recovery: string;
	/** Delivery receipt: not requested / pending / published / failed /
	 *  unknown, else the integration state as the publication pipeline's
	 *  progress, else "no receipt". */
	publication: string;
}

/** Derive the four P15 labels from the latest receipt-state projection. */
export function receiptLabels(states: ReceiptStateView | undefined): ReceiptLabels {
	const review = states?.acceptance === "accepted"
		? "accepted"
		: states?.primary !== undefined
			? states.primary
			: states?.skeptic !== undefined
				? states.skeptic
				: "no receipt";
	const checks = states?.gate ?? "no receipt";
	const recovery = states?.rollback ?? "no receipt";
	const publication = states?.delivery !== undefined
		? states.delivery === "not_requested" ? "not requested" : states.delivery
		: states?.integration !== undefined
			? states.integration === "integrated" ? "pending" : states.integration
			: "no receipt";
	return { review, checks, recovery, publication };
}

/** Render the four labels in the shared "k v · k v" report form (CLI + UI). */
export function receiptLabelsLine(states: ReceiptStateView | undefined): string {
	const labels = receiptLabels(states);
	return `review ${labels.review} · checks ${labels.checks} · workspace recovery ${labels.recovery} · publication ${labels.publication}`;
}

export interface KitTaskView {
	id: string;
	title: string;
	status: TaskStatus;
	waveCount: number;
	dependsOn: string[];
	targetPaths: string[];
	priority: number;
	baselineTreeSha?: string;
	lastGateHash?: string;
	/** Feedback entries on the task (previous waves' gate/verifier/handoff text). */
	feedback: number;
	/** A.3: viewable diff for done/quarantined tasks (artifact names, not content). */
	diff?: DiffArtifactRef;
}

export interface KitUsage {
	sessionUsd: number;
	tokens: number;
	ceilingUsd: number;
	warnUsdPerWave: number;
	wavesExecuted: number;
	spendRateUsdPerWave: number;
	byModel: Record<string, { usage: Usage; usd: number }>;
	byTask: Record<string, { usd: number; totalTokens: number; waves?: number }>;
	/** `storage`: joined from durable usage docs; `sidecars`: derived from wave-log + status.json estimates. */
	source: "storage" | "sidecars";
}

export interface WaveSpan {
	task: string;
	wave: number;
	startedMs: number;
	durationMs: number;
	rowsCount: number;
	outcome: string;
	/** UI seam A.7: the wave's own git trees (start/end rows' `treeSha`) — used
	 *  by the UI's per-wave isolated diff (`GET /api/tasks/:id/diff?wave=N`).
	 *  Optional: rows that predate the seam, or a failed capture, carry none —
	 *  that wave is simply not isolatable. */
	startTreeSha?: string;
	endTreeSha?: string;
}

/** UI seam A.1: live wave state from the status side-car (both readout modes). */
export interface KitLiveView {
	task: string;
	wave: number;
	startedAt: number;
	elapsedMs: number;
	pid?: number;
}

export interface ConvSummary {
	id: number;
	role: "planner" | "implementer" | "verifier" | "none";
	/** Implementer conversations only. */
	task?: string;
	targetPaths?: string[];
	entries: number;
	resets: number;
	compactions: number;
	toolRounds: number;
	byKind: Record<string, number>;
	/** true when the entry scan hit its page cap (counts are a floor, not exact). */
	entriesTruncated: boolean;
	usage: { usd: number; totalTokens: number };
}

export interface ArtifactFile {
	name: string;
	bytes: number;
	mtimeMs: number;
	/** A.3: "diff" marks the per-task display patches + their stats side-cars. */
	kind: "gate" | "quarantine" | "diff" | "other";
}

// ---------------------------------------------------------------------------
// A.5: conversation transcript excerpts (bounded, read-only, plain JSON)
// ---------------------------------------------------------------------------

/** A.5: one tool call requested by an assistant entry, as plain strings. */
export interface ConvEntryToolCall {
	name: string;
	/** The call arguments as compact JSON text (bounded by CONV_ENTRY_TEXT_CAP). */
	input: string;
}

/**
 * A.5: one transcript entry as the UI may render it. Every field is plain
 * JSON — ids as numbers, timestamps as ms numbers, content as strings. No
 * pi-durable types cross this boundary.
 */
export interface ConvEntryView {
	/** Durable entry id (the branded EntryId bridged back to a plain number). */
	id: number;
	/** Entry kind: pi.user / pi.assistant / pi.tool-result / pi.reset / pi.compaction / … */
	kind: string;
	/** ms timestamp from the entry's model message, when the kind carries one. */
	ts?: number;
	/** Model-message role when present: "user" | "assistant" | "toolResult" | "system". */
	role?: string;
	/** Plain-text content: text blocks joined, thinking omitted, per-entry bounded. */
	text: string;
	/** Assistant entries that requested tool calls: names + bounded JSON input. */
	toolCalls?: ConvEntryToolCall[];
	/** The assistant stop reason, when the provider recorded one. */
	stopReason?: string;
	/** Tool-result entries: the call failed. */
	isError?: boolean;
	/** The entry text (or a tool input) hit CONV_ENTRY_TEXT_CAP and was cut. */
	textCapped?: boolean;
}

/** A.5: the bounded excerpt payload for one conversation. */
export interface ConvEntriesView {
	/** The conversation these entries belong to (plain number). */
	conversation: number;
	/**
	 * The excerpt window in chronological order — at most CONV_ENTRY_SCAN_CAP
	 * (≤ 2,000) entries per request.
	 */
	entries: ConvEntryView[];
	/**
	 * True when entries exist beyond the window: the default "newest" order cut
	 * OLDER entries; "oldest" cut NEWER ones. The cap is the contract; there is
	 * no pagination protocol in v1.
	 */
	truncated: boolean;
}

export interface ConversationEntriesOptions {
	/**
	 * Which end of the transcript the cap keeps. Default "newest": the excerpt
	 * is the most recent ≤ 2,000 entries (where the outcome lives) and
	 * `truncated` means older entries were cut. "oldest" mirrors the summary
	 * scan's counting direction. The cap is the contract either way.
	 */
	order?: "newest" | "oldest";
}

/** A.3: where a task's viewable diff lives (artifact NAMES, not content). */
export interface DiffArtifactRef {
	task: string;
	/** Revision-qualified candidate artifact name: candidate-<revision>-<task>-w<N>.patch. */
	patch: string;
	/** Stats side-car artifact name when present (written alongside by A.2). */
	stats?: string;
	bytes: number;
	/** The stored patch was cut at the 5 MiB cap (from the stats side-car). */
	truncated: boolean;
}

/** A.6: one delivery outcome, echoed from the wave log's kind:"delivery" rows as plain JSON. */
export interface DeliveryRow {
	ts: number;
	task: string;
	verb: string;
	wave?: number;
	detail?: string;
}

/**
 * A.6: delivery truth for connected UIs — the configured mode (§4.6) plus the
 * delivery outcome rows already in the wave log. Read-only: the mode is
 * echoed from config (never writable from here), and the CLI keeps every
 * mutation path (`delivery.mode` in .orch/config.toml, the `--deliver` run
 * qualifier the `pr` mode requires).
 */
export interface DeliveryView {
	/** Configured `delivery.mode`; absent only when the config itself is unreadable (side-car mode). */
	mode?: string;
	rows: DeliveryRow[];
}

export interface HealthCheck {
	id: string;
	ok: boolean;
	severity: "info" | "warn" | "error";
	detail: string;
}

/** Durable-truth sections: present only in storage mode. */
export interface StorageReadout {
	router: RouterDocValue;
	runStatus: RunStatusDocValue;
	conversations: ConvSummary[];
	/** Harness report ring tail (task_faulted, task_interrupted, …) since open. */
	reports: ReportRow[];
}

export interface KitReadout {
	at: number;
	/** Latest reviewed plan identity, when one exists. */
	planRevision?: string;
	/** Latest receipt outcomes for one wave; the journal remains authoritative. */
	receiptStates?: ReceiptStateView;
	/** Latest frozen candidate point for this plan. */
	checkpoint?: FrozenCheckpointView;
	/** UI seam version (Appendix A). Present in both modes; M0 ships A.1. */
	seam: 1;
	degraded: boolean;
	degradedReason?: string;
	identity: KitIdentity;
	phase: string;
	current?: { task: string; wave: number };
	/** Live wave truth from the status side-car; absent when no wave is running. */
	live?: KitLiveView;
	tasks: KitTaskView[];
	rows: WaveRow[];
	usage: KitUsage;
	timeline: WaveSpan[];
	/** A.6: the configured delivery mode + the outcome rows from the wave log. */
	delivery: DeliveryView;
	artifacts: ArtifactFile[];
	health: HealthCheck[];
	storage?: StorageReadout;
}

/**
 * A.6: delivery — pick the configured mode and echo the wave log's kind:"delivery"
 * rows (plain JSON shapes; the UI server never parses engine row semantics).
 * The wave log already carries at most one delivery row per task+wave attempt,
 * so the echo stays proportional to the rows the caller already holds.
 */
function deliveryView(mode: string | undefined, rows: readonly WaveRow[]): DeliveryView {
	const delivery: DeliveryView = { rows: [] };
	if (mode !== undefined) delivery.mode = mode;
	for (const row of rows) {
		if (row.kind !== "delivery") continue;
		delivery.rows.push({ ts: row.ts, task: row.task, verb: row.verb, ...(row.wave !== undefined ? { wave: row.wave } : {}), ...(row.detail !== undefined ? { detail: row.detail } : {}) });
	}
	return delivery;
}

/** A.1: the live view is derived from the status side-car's wave-running flush. */
export function liveFromPayload(payload?: StatusPayloads): KitLiveView | undefined {
	if (payload?.phase !== "wave-running" || !payload.task?.id) return undefined;
	const startedAt = payload.task.startedAt;
	if (typeof startedAt !== "number") return undefined;
	return { task: payload.task.id, wave: payload.task.wave, startedAt, elapsedMs: Math.max(0, Date.now() - startedAt), pid: payload.lockedByPid };
}

export interface ReadoutOptions {
	/** When absent, the readout degrades to side-cars only (storage untouched). */
	loop?: LoopAndLock;
	/**
	 * Why the readout is side-car-only ("lock busy" vs "never run — no storage").
	 * A view never opens storage it would have to create just to inspect.
	 */
	sidecarReason?: string;
}

/** Renderable sections of the inspect panel (positional filters on the CLI). */
export const INSPECT_SECTIONS = ["tasks", "usage", "conversations", "timeline", "artifacts", "health"] as const;
export type InspectSectionName = (typeof INSPECT_SECTIONS)[number];

/** Entry-scan caps so a pathological transcript cannot stall a readout. */
const MAX_SCAN_PAGES = 8;
const ENTRIES_PER_PAGE = 500;
const MAX_ENTRY_PAGES_PER_CONV = 4;

/** A.5: the excerpt window is the same cap the summary scan uses (≤ 2,000 entries). */
export const CONV_ENTRY_SCAN_CAP = MAX_ENTRY_PAGES_PER_CONV * ENTRIES_PER_PAGE;

/** A.5: per-entry text/tool-input bound, so one pathological tool result cannot own the wire. */
export const CONV_ENTRY_TEXT_CAP = 4_096;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `paths` is the host control root; task source and task diffs are never read
 * from it here. M1-P01 step (g): the root is canonicalized ONCE per readout and
 * handed to every file read below (never a path re-resolution per read).
 */
export async function readout(paths: ProjectPaths, opts: ReadoutOptions = {}): Promise<KitReadout> {
	const root = await requireSafeReadRoot(paths.root);
	if (opts.loop) return storageReadout(paths, root, opts.loop);
	return sidecarReadout(paths, root, opts.sidecarReason);
}

/** One tolerant side-car payload read through the boundary; absent/corrupt = undefined, refused throws. */
async function readSidecarJson<T>(root: string, path: string): Promise<T | undefined> {
	const read = await readSafeText({ root, path });
	if (read.kind === "absent") return undefined;
	if (read.kind === "refused") throw new SafeReadRefusalError(read);
	try {
		return JSON.parse(read.value) as T;
	} catch {
		return undefined; // corrupt side-car reads as absent; the engine re-writes it
	}
}

/** The Harness/Session instance openProjectHarness hands out (a pi-durable Session). */
type HarnessType = LoopAndLock["loop"]["harness"];

// ---------------------------------------------------------------------------
// Storage mode
// ---------------------------------------------------------------------------

async function storageReadout(paths: ProjectPaths, root: string, loop: LoopAndLock): Promise<KitReadout> {
	const at = Date.now();
	const harness = loop.loop.harness;
	const config = loop.loop.config;
	// The side-car is still the freshest source for live elapsed time even when
	// storage is open (A.3) — the wave-start flush happens before the request is
	// submitted, so it carries startedAt while the run is mid-wave.
	const [state, sessionUsage, payload, receiptDoc] = await Promise.all([
		readSessionState(harness),
		loop.loop.sessionUsage(),
		readSidecarJson<StatusPayloads>(root, ".orch/status.json"),
		harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT),
	]);

	const rates = buildRateMap(config);
	const conversations = await collectConversations(harness, state.router.tasks, rates);
	const timeline = buildTimeline(state.rows);
	const artifacts = await listArtifacts(root);

	const byModel: KitUsage["byModel"] = {};
	let sessionUsd = 0;
	let tokens = 0;
	for (const [key, usage] of Object.entries(sessionUsage.byModel)) {
		const usd = usageUsd(usage, rates[key]);
		tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		sessionUsd += usd;
		byModel[key] = { usage, usd };
	}
	const byTask = buildByTask(conversations, timeline);
	const wavesExecuted = timeline.length;
	const current = state.router.tasks.find((t) => t.status === "in_progress");
	const revision = state.router.identity?.planRevision;
	const receiptValues = receiptDoc ?? { version: 1 as const, events: [] };
	const currentCheckpoint = current && revision
		? receiptValues.events.filter((event): event is Extract<ReceiptEvent, { kind: "checkpoint" }> =>
			event.kind === "checkpoint" && event.value.planRevision === revision && event.value.taskId === current.id,
		).at(-1)?.value
		: undefined;
	const currentWave = current
		? currentCheckpoint && currentCheckpoint.stage !== "terminal" ? currentCheckpoint.wave : current.waveCount + 1
		: undefined;

	const readout: KitReadout = {
		at,
		...(revision ? { planRevision: revision } : {}),
		...(revision ? { receiptStates: latestReceiptStates(receiptValues, revision) } : {}),
		...(revision ? { checkpoint: latestFrozenCheckpoint(receiptValues, revision) } : {}),
		seam: 1,
		live: liveFromPayload(payload),
		degraded: false,
		identity: { kit: state.runStatus.kitVersion || KIT_VERSION, piDurable: config.engine.piDurable, root: paths.root, lockedByPid: process.pid, at },
		phase: state.router.phase,
		current: current && currentWave !== undefined ? { task: current.id, wave: currentWave } : undefined,
		tasks: taskViews(state.router.tasks, (t) => ({
			dependsOn: t.dependsOn,
			targetPaths: t.targetPaths,
			priority: t.priority,
			baselineTreeSha: t.baselineTreeSha,
			lastGateHash: t.lastGateHash,
			feedback: t.feedback.length,
		})),
		rows: state.rows,
		usage: {
			sessionUsd,
			tokens,
			ceilingUsd: config.budgets.sessionUsd,
			warnUsdPerWave: config.budgets.waveUsdWarn,
			wavesExecuted,
			spendRateUsdPerWave: sessionUsd / Math.max(1, wavesExecuted),
			byModel,
			byTask,
			source: "storage",
		},
		timeline,
		delivery: deliveryView(config.delivery.mode, state.rows),
		artifacts,
		health: [],
		storage: { router: state.router, runStatus: state.runStatus, conversations, reports: loop.loop.reports.slice(-20) },
	};
	readout.tasks = await attachDiffRefs(readout.tasks, root, artifacts, revision);
	readout.health = await healthChecks(root, {
		degraded: false,
		state,
		payload,
		artifacts,
		rows: state.rows,
		config,
		harness,
	});
	return readout;
}

// ---------------------------------------------------------------------------
// Side-car mode (lock held elsewhere; never opens storage)
// ---------------------------------------------------------------------------

/**
 * A.6 in side-car mode: the config file is a static read (not the owned
 * storage), so the configured mode is still available while a run holds the
 * lock — unless the config itself is unreadable, in which case mode is
 * omitted and the reader says so rather than guessing.
 */
function sidecarDeliveryMode(root: string): Promise<string | undefined> {
	return loadConfig(root).then(
		(config) => config.delivery.mode,
		() => undefined,
	);
}

async function sidecarReadout(paths: ProjectPaths, root: string, reason?: string): Promise<KitReadout> {
	const at = Date.now();
	const payload = await readSidecarJson<StatusPayloads>(root, ".orch/status.json");
	const rows = await readWaveLogRows(root);
	const timeline = buildTimeline(rows);
	const artifacts = await listArtifacts(root);

	// Spend estimate in degraded mode: status.json budget is authoritative for
	// the session number; per-row cost fields (planner/… rows carry them) give
	// whatever splits the side-car preserves.
	let sessionUsd = payload?.budget.spentUsd ?? 0;
	let tokens = 0;
	const byModel: KitUsage["byModel"] = {};
	const byTask: KitUsage["byTask"] = {};
	for (const row of rows) {
		tokens += typeof row.tokens === "number" ? row.tokens : 0;
		if (typeof row.costUsd !== "number" || row.costUsd <= 0) continue;
		if (row.provider && row.modelId) {
			const key = `${row.provider}/${row.modelId}`;
			const slot = (byModel[key] ??= { usage: zeroUsage(), usd: 0 });
			slot.usd += row.costUsd;
		}
		const task = row.task === "session" ? (row.verb === "planned" ? "planner" : undefined) : row.task;
		if (task) {
			const slot = (byTask[task] ??= { usd: 0, totalTokens: 0 });
			slot.usd += row.costUsd;
			slot.totalTokens += typeof row.tokens === "number" ? row.tokens : 0;
		}
	}

	const readout: KitReadout = {
		at,
		...(payload?.planRevision ? { planRevision: payload.planRevision } : {}),
		...(payload?.receiptStates ? { receiptStates: payload.receiptStates } : {}),
		...(payload?.checkpoint ? { checkpoint: payload.checkpoint } : {}),
		seam: 1,
		live: liveFromPayload(payload),
		degraded: true,
		degradedReason: reason ?? "storage is owned by another process — showing side-cars only",
		identity: {
			kit: payload?.kit ?? KIT_VERSION,
			piDurable: payload?.piDurable ?? readInstalledPiDurableVersion(),
			root: paths.root,
			lockedByPid: payload?.lockedByPid,
			at,
		},
		phase: payload?.phase ?? "unknown",
		current:
			payload?.phase === "wave-running" && payload.task
				? { task: payload.task.id, wave: payload.task.wave }
				: payload?.receiptStates && payload.tasks.some((task) => task.id === payload.receiptStates!.taskId && task.status === "in_progress")
					? { task: payload.receiptStates.taskId, wave: payload.receiptStates.wave }
					: undefined,
		tasks: (payload?.tasks ?? []).map((t) => ({
			id: t.id,
			title: t.title,
			status: t.status as TaskStatus,
			waveCount: t.waveCount,
			dependsOn: [],
			targetPaths: [],
			priority: 0,
			feedback: 0,
		})),
		rows,
		usage: {
			sessionUsd,
			tokens,
			ceilingUsd: payload?.budget.sessionCeilingUsd ?? 0,
			warnUsdPerWave: payload?.budget.waveWarnUsd ?? 0,
			wavesExecuted: timeline.length,
			spendRateUsdPerWave: sessionUsd / Math.max(1, timeline.length),
			byModel,
			byTask,
			source: "sidecars",
		},
		timeline,
		delivery: deliveryView(await sidecarDeliveryMode(root), rows),
		artifacts,
		health: [],
	};
	readout.tasks = await attachDiffRefs(readout.tasks, root, artifacts, payload?.planRevision);
	readout.health = await healthChecks(root, { degraded: true, payload, artifacts, rows, config: undefined, harness: undefined });
	return readout;
}

// ---------------------------------------------------------------------------
// Conversation summaries (storage mode)
// ---------------------------------------------------------------------------

interface ConvScan {
	id: number;
	entries: number;
	resets: number;
	compactions: number;
	byKind: Record<string, number>;
	entriesTruncated: boolean;
}

/** Gated table scan: one commit that only reads (`scanConversations`/`scanEntries`, no writes). */
async function collectConversations(harness: HarnessType, tasks: RouterTask[], rates: Record<string, CostRates>): Promise<ConvSummary[]> {
	const scans: ConvScan[] = await harness.commit(async (tx) => {
		const records: { id: number }[] = [];
		let cursor: Cursor | undefined;
		for (let page = 0; page < MAX_SCAN_PAGES; page++) {
			const found = await tx.scanConversations({ order: "ascending" }, 200, cursor);
			for (const record of found.items) records.push({ id: record.id as unknown as number });
			if (!found.next) break;
			cursor = found.next;
		}

		const out: ConvScan[] = [];
		for (const record of records) {
			const scan: ConvScan = { id: record.id, entries: 0, resets: 0, compactions: 0, byKind: {}, entriesTruncated: false };
			let entryCursor: Cursor | undefined;
			for (let page = 0; page < MAX_ENTRY_PAGES_PER_CONV; page++) {
				const found = await tx.scanEntries({ conversationId: convId(record.id), order: "ascending" }, ENTRIES_PER_PAGE, entryCursor);
				for (const entry of found.items) {
					scan.entries += 1;
					scan.byKind[entry.kind] = (scan.byKind[entry.kind] ?? 0) + 1;
					if (entry.kind === "pi.reset") scan.resets += 1;
					if (entry.kind === "pi.compaction") scan.compactions += 1;
				}
				if (!found.next) break;
				if (page === MAX_ENTRY_PAGES_PER_CONV - 1) scan.entriesTruncated = true;
				entryCursor = found.next;
			}
			out.push(scan);
		}
		return out;
	}, BACKGROUND_CONTEXT);

	const summaries: ConvSummary[] = [];
	for (const scan of scans) {
		// Documents attach OUTSIDE the commit: snapshot() is a pure read.
		const guard = await harness.snapshot(LoopGuardDoc, convId(scan.id), BACKGROUND_CONTEXT).catch(() => undefined);
		const usageState = await harness.snapshot(UsageDoc, convId(scan.id), BACKGROUND_CONTEXT).catch(() => undefined);
		let usd = 0;
		let totalTokens = 0;
		for (const [key, record] of Object.entries(usageState?.models ?? {})) {
			usd += estimateUsageUsd(record, rates[key]);
			totalTokens += Number((record as { totalTokens?: number }).totalTokens ?? 0);
		}
		for (const record of Object.values(usageState?.tools ?? {})) {
			totalTokens += Number((record as { totalTokens?: number }).totalTokens ?? 0);
		}
		const task = guard?.role === "implementer"
			? tasks.find((entry) => entry.convId === scan.id)
				?? (guard.execution ? tasks.find((candidate) => candidate.id === guard.execution!.taskId) : undefined)
			: tasks.find((entry) => entry.convId === scan.id);
		const role = guard?.role === "verifier" ? "verifier" as const : task ? "implementer" as const : (guard?.role ?? "none");
		summaries.push({
			id: scan.id,
			role,
			...(task ? { task: task.id, targetPaths: task.targetPaths } : {}),
			entries: scan.entries,
			resets: scan.resets,
			compactions: scan.compactions,
			toolRounds: scan.byKind["pi.tool-result"] ?? 0,
			byKind: scan.byKind,
			entriesTruncated: scan.entriesTruncated,
			usage: { usd, totalTokens },
		});
	}
	return summaries;
}

// ---------------------------------------------------------------------------
// A.5: transcript excerpts (storage mode; same gated scan as the summaries)
// ---------------------------------------------------------------------------

/**
 * A.5: bounded, read-only transcript excerpt for one conversation. Same gated
 * table-scan pattern as `collectConversations` — a single commit that only
 * reads (`scanEntries`), BACKGROUND_CONTEXT, never writes. The returned
 * shapes are plain JSON: ids/timestamps as numbers, content as strings; no
 * pi-durable types cross the module boundary (the UI server never imports
 * kit.ts). Returns undefined for a conversation id that does not exist.
 */
export async function conversationEntries(loop: LoopAndLock, conversationId: number, opts: ConversationEntriesOptions = {}): Promise<ConvEntriesView | undefined> {
	const harness = loop.loop.harness;
	const existing = await harness.conversation(convId(conversationId), BACKGROUND_CONTEXT).catch(() => undefined);
	if (!existing) return undefined;
	const order = opts.order ?? "newest";
	const scan = await harness.commit(async (tx) => {
		const records: EntryRecord[] = [];
		let truncated = false;
		let cursor: Cursor | undefined;
		for (let page = 0; page < MAX_ENTRY_PAGES_PER_CONV; page++) {
			const found = await tx.scanEntries({ conversationId: convId(conversationId), order: order === "oldest" ? "ascending" : "descending" }, ENTRIES_PER_PAGE, cursor);
			records.push(...found.items);
			if (!found.next) break;
			if (page === MAX_ENTRY_PAGES_PER_CONV - 1) truncated = true;
			cursor = found.next;
		}
		return { records, truncated };
	}, BACKGROUND_CONTEXT);
	const entries = scan.records.map(convEntryView);
	if (order === "newest") entries.reverse(); // chronological inside the window
	return { conversation: conversationId, entries, truncated: scan.truncated };
}

/** A.5 shaping: one EntryRecord → a plain view. Content blocks become strings. */
function convEntryView(record: EntryRecord): ConvEntryView {
	const view: ConvEntryView = { id: record.id as unknown as number, kind: record.kind, text: "" };
	const message = record.model?.[0] as
		| { role?: string; timestamp?: number; content?: unknown; stopReason?: string; isError?: boolean }
		| undefined;
	// Display/bookkeeping entries without model context (plain resets, system
	// markers): the kind is the whole story.
	if (!message) return view;
	if (typeof message.timestamp === "number") view.ts = message.timestamp;
	if (typeof message.role === "string") view.role = message.role;
	const text = capEntryText(entryText(message.content));
	view.text = text.value;
	let capped = text.capped;
	if (message.role === "assistant") {
		const calls = entryToolCalls(message.content);
		if (calls.list.length > 0) view.toolCalls = calls.list;
		capped = capped || calls.capped;
		if (typeof message.stopReason === "string") view.stopReason = message.stopReason;
	}
	if (message.role === "toolResult" && message.isError === true) view.isError = true;
	if (capped) view.textCapped = true;
	return view;
}

/** Join a message's text blocks into one string; thinking is model-internal and stays out. */
function entryText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as { type?: string; text?: string }[]) {
		if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

/** Extract assistant tool calls as plain { name, input } pairs (input JSON-bounded). */
function entryToolCalls(content: unknown): { list: ConvEntryToolCall[]; capped: boolean } {
	if (!Array.isArray(content)) return { list: [], capped: false };
	const list: ConvEntryToolCall[] = [];
	let capped = false;
	for (const block of content as { type?: string; name?: string; arguments?: unknown }[]) {
		if (block === null || typeof block !== "object" || block.type !== "toolCall") continue;
		const input = capEntryText(JSON.stringify(block.arguments ?? {}));
		if (input.capped) capped = true;
		list.push({ name: typeof block.name === "string" ? block.name : "?", input: input.value });
	}
	return { list, capped };
}

/** A.5 per-entry bound; the " …" marker makes the cut visible in the UI. */
function capEntryText(text: string): { value: string; capped: boolean } {
	if (text.length <= CONV_ENTRY_TEXT_CAP) return { value: text, capped: false };
	return { value: `${text.slice(0, CONV_ENTRY_TEXT_CAP)} …`, capped: true };
}

function buildRateMap(config: KitConfig): Record<string, CostRates> {
	const rates: Record<string, CostRates> = {};
	for (const role of Object.values(config.roles)) {
		rates[`${role.provider}/${role.modelId}`] = { costPerMillionInput: role.costPerMillionInput, costPerMillionOutput: role.costPerMillionOutput };
	}
	return rates;
}

function buildByTask(conversations: ConvSummary[], timeline: WaveSpan[]): KitUsage["byTask"] {
	const byTask: KitUsage["byTask"] = {};
	const wavesFor = (taskId: string) => timeline.filter((s) => s.task === taskId).length || undefined;
	for (const conv of conversations) {
		if (conv.usage.usd === 0 && conv.usage.totalTokens === 0) continue;
		const key = conv.role === "implementer" && conv.task ? conv.task : conv.role === "none" ? `conv-${conv.id}` : conv.role;
		const slot = (byTask[key] ??= { usd: 0, totalTokens: 0 });
		slot.usd += conv.usage.usd;
		slot.totalTokens += conv.usage.totalTokens;
		if (key === conv.task) slot.waves = wavesFor(key);
	}
	return byTask;
}

// ---------------------------------------------------------------------------
// Timeline + tasks (both modes)
// ---------------------------------------------------------------------------

function buildTimeline(rows: readonly WaveRow[]): WaveSpan[] {
	const spans = new Map<string, { task: string; wave: number; startedMs: number; lastMs: number; rowsCount: number; outcome: string }>();
	const firstWaveOf = new Map<string, number>();
	// UI seam A.1: wave start/end rows carry the real span boundaries and outcome.
	// When they are absent (older rows, or a run killed mid-wave) the compute
	// falls back to the classic min/max over all rows for the (task, wave) pair.
	const starts = new Map<string, { ts: number; treeSha?: string }>();
	const ends = new Map<string, { ts: number; detail?: string; treeSha?: string }>();
	for (const row of rows) {
		if (row.kind === "wave" && (row.verb === "start" || row.verb === "end") && row.wave !== undefined) {
			const key = `${row.task}\u0000${row.wave}`;
			if (row.verb === "start" && !starts.has(key)) starts.set(key, { ts: row.ts, ...(row.treeSha ? { treeSha: row.treeSha } : {}) });
			else if (row.verb === "end") ends.set(key, { ts: row.ts, detail: row.detail, ...(row.treeSha ? { treeSha: row.treeSha } : {}) });
		}
	}
	for (const row of rows) {
		if (row.task === "session") continue;
		if (row.wave === undefined && !firstWaveOf.has(row.task)) {
			const later = rows.find((r) => r.task === row.task && r.wave !== undefined);
			firstWaveOf.set(row.task, later?.wave ?? 1);
		}
	}
	for (const row of rows) {
		if (row.task === "session") continue;
		const wave = row.wave ?? firstWaveOf.get(row.task) ?? 1;
		const key = `${row.task}\u0000${wave}`;
		const span = spans.get(key) ?? { task: row.task, wave, startedMs: row.ts, lastMs: row.ts, rowsCount: 0, outcome: "" };
		if (row.ts < span.startedMs) span.startedMs = row.ts;
		if (row.ts > span.lastMs) span.lastMs = row.ts;
		span.rowsCount += 1;
		span.outcome = spanOutcome(row);
		spans.set(key, span);
	}
	return [...spans.entries()]
		.map(([key, s]) => {
			const out: WaveSpan = {
				task: s.task,
				wave: s.wave,
				startedMs: s.startedMs,
				durationMs: Math.max(0, s.lastMs - s.startedMs),
				rowsCount: s.rowsCount,
				outcome: s.outcome,
			};
			const start = starts.get(key);
			if (start !== undefined) {
				out.startedMs = start.ts;
				const end = ends.get(key);
				if (end) {
					out.durationMs = Math.max(0, end.ts - start.ts);
					if (end.detail) out.outcome = end.detail;
				} else {
					out.durationMs = Math.max(0, s.lastMs - start.ts);
				}
				// A.7: the wave's own trees ride the span (plain JSON-able echo).
				if (start.treeSha) out.startTreeSha = start.treeSha;
				if (end?.treeSha) out.endTreeSha = end.treeSha;
			}
			return out;
		})
		.sort((a, b) => a.startedMs - b.startedMs);
}

function spanOutcome(row: WaveRow): string {
	if (row.kind === "task" && row.verb === "done") return row.verdict === "approve" ? "approved" : "done";
	if (row.verb === "quarantined") return `quarantined${row.reason ? `: ${row.reason}` : ""}`;
	if (row.kind === "gate") return row.verb === "pass" ? "gate pass" : `gate fail${row.reason ? ` (${row.reason})` : ""}`;
	if (row.kind === "verdict") return `verifier ${row.verdict ?? row.verb}`;
	if (row.kind === "engine") return row.verb;
	if (row.kind === "governor") return row.verb;
	if (row.kind === "delivery") return row.verb;
	return `${row.kind}/${row.verb}`;
}

function taskViews(tasks: RouterTask[], extra: (t: RouterTask) => Pick<KitTaskView, "dependsOn" | "targetPaths" | "priority" | "baselineTreeSha" | "lastGateHash" | "feedback">): KitTaskView[] {
	return tasks.map((t) => ({
		id: t.id,
		title: t.title,
		status: t.status,
		waveCount: t.waveCount,
		...extra(t),
	}));
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/**
 * Revision-qualified per-wave candidate patches are display only. A terminal
 * task points at its newest candidate artifact for the current plan revision.
 * The stats side-car is read through the same boundary (absent/corrupt = no
 * truncation flag; a refusal throws rather than reading a link target).
 */
async function attachDiffRefs(tasks: KitTaskView[], root: string, artifacts: readonly ArtifactFile[], revision?: string): Promise<KitTaskView[]> {
	const byName = new Map(artifacts.map((a) => [a.name, a]));
	return Promise.all(
		tasks.map(async (task) => {
			let patchName: string | undefined;
			if (revision && (task.status === "done" || task.status === "quarantined")) {
				const prefix = `candidate-${revision}-${task.id}-w`;
				const waves = artifacts
					.filter((artifact) => artifact.name.startsWith(prefix) && artifact.name.endsWith(".patch"))
					.map((artifact) => Number(/-w(\d+)\.patch$/.exec(artifact.name)?.[1]))
					.filter((wave): wave is number => Number.isSafeInteger(wave) && wave > 0);
				const wave = Math.max(...waves, 0);
				patchName = wave > 0 ? `${prefix}${wave}.patch` : undefined;
			}
			if (!patchName) return task;
			const patchMeta = byName.get(patchName);
			if (!patchMeta) return task; // listing says the patch is gone (or never landed)
			const statsName = patchName.replace(/\.patch$/, ".json");
			let truncated = false;
			if (byName.has(statsName)) {
				const stats = await readSidecarJson<{ truncated?: boolean }>(root, `.orch/artifacts/${statsName}`);
				if (typeof stats?.truncated === "boolean") truncated = stats.truncated;
			}
			return {
				...task,
				diff: {
					task: task.id,
					patch: patchName,
					...(byName.has(statsName) ? { stats: statsName } : {}),
					bytes: patchMeta.bytes,
					truncated,
				} satisfies DiffArtifactRef,
			};
		}),
	);
}

/**
 * `.orch/artifacts` listing through the pinned no-follow directory handle:
 * absence is the defined "no artifacts yet" state; a symlink/special entry or
 * a refused directory throws instead of listing a link target's metadata.
 * Nested directories are not artifacts and are skipped, never walked.
 */
async function listArtifacts(root: string): Promise<ArtifactFile[]> {
	const opened = await openSafeDirectory({ root, path: ".orch/artifacts" });
	if (opened.kind === "absent") return [];
	if (opened.kind === "refused") throw new SafeReadRefusalError(opened);
	const directory: SafeDirectory = opened.value;
	try {
		const listed = await directory.list();
		if (listed.kind === "absent") return [];
		if (listed.kind === "refused") throw new SafeReadRefusalError(listed);
		const files: ArtifactFile[] = [];
		for (const entry of listed.value) {
			if (entry.kind === "directory") continue;
			if (entry.kind !== "file") {
				throw new SafeReadRefusalError({
					code: entry.kind === "symlink" ? "symlink" : "not-regular",
					path: `.orch/artifacts/${entry.name}`,
					message:
						entry.kind === "symlink"
							? `.orch/artifacts/${entry.name} is a symbolic link; host reads never follow links`
							: `.orch/artifacts/${entry.name} is not a regular file`,
				});
			}
			const file = await directory.openFile(entry.name);
			if (file.kind === "absent") continue; // vanished between list and open
			if (file.kind === "refused") throw new SafeReadRefusalError(file);
			try {
				const kind: ArtifactFile["kind"] = entry.name.startsWith("gate-") ? "gate" : entry.name.startsWith("quarantined-") ? "quarantine" : entry.name.startsWith("task-") || entry.name.startsWith("candidate-") ? "diff" : "other";
				files.push({ name: entry.name, bytes: file.value.size, mtimeMs: file.value.mtimeMs, kind });
			} finally {
				await file.value.close();
			}
		}
		return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	} finally {
		await directory.close();
	}
}

// ---------------------------------------------------------------------------
// Side-car row reader (tolerant JSONL)
// ---------------------------------------------------------------------------

/** Tolerant JSONL rows from `.orch/wave-log.jsonl`; absent = no rows, refused throws. */
async function readWaveLogRows(root: string): Promise<WaveRow[]> {
	const read = await readSafeText({ root, path: ".orch/wave-log.jsonl" });
	if (read.kind === "absent") return [];
	if (read.kind === "refused") throw new SafeReadRefusalError(read);
	return read.value
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			try {
				return JSON.parse(line) as WaveRow;
			} catch {
				return undefined;
			}
		})
		.filter((row): row is WaveRow => row !== undefined);
}

function zeroUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

interface HealthInput {
	degraded: boolean;
	payload?: StatusPayloads;
	state?: SessionState;
	rows: readonly WaveRow[];
	artifacts: readonly ArtifactFile[];
	config: KitConfig | undefined;
	harness: LoopAndLock["loop"]["harness"] | undefined;
}

/** Every check reports; storage-bound ones degrade to a skip line, never crash. */
async function healthChecks(root: string, input: HealthInput): Promise<HealthCheck[]> {
	const checks: HealthCheck[] = [];
	const { degraded, payload, state } = input;

	// pin — installed pi-durable vs the tested pin (and the claimed config pin).
	const installed = readInstalledPiDurableVersion();
	if (installed !== PD_VERSION) {
		checks.push({ id: "pin", ok: false, severity: "error", detail: `installed pi-durable ${installed} != tested pin ${PD_VERSION} — see docs/api-map.md` });
	} else {
		const claimed = input.config?.engine.piDurable ?? payload?.piDurable;
		checks.push(
			claimed && claimed !== PD_VERSION
				? { id: "pin", ok: false, severity: "error", detail: `config pins piDurable ${claimed} but the kit was built against ${PD_VERSION}` }
				: { id: "pin", ok: true, severity: "info", detail: `pi-durable ${installed} matches the tested pin ${PD_VERSION}` },
		);
	}

	// prd — exists? (and when durable state is readable: drifted after plan?)
	// Read through the canonical-root boundary; a refused PRD (symlink/escape/
	// cap) is an explicit failure, never "missing" and never the link target.
	const prdPath = input.config?.paths.prd;
	if (prdPath) {
		const read = await readSafeText({ root, path: prdPath });
		if (read.kind === "refused") {
			checks.push({ id: "prd", ok: false, severity: "error", detail: `PRD at ${prdPath} is refused (${read.code}): ${read.message}` });
		} else if (read.kind === "absent") {
			checks.push({ id: "prd", ok: false, severity: "warn", detail: `PRD missing at ${prdPath}` });
		} else if (state) {
			if (state.runStatus.prdSha === undefined) {
				checks.push({ id: "prd", ok: true, severity: "info", detail: `PRD at ${prdPath} (no sha recorded yet — run plan first)` });
			} else {
				const drifted = shasum(read.value) !== state.runStatus.prdSha;
				checks.push(
					drifted
						? { id: "prd", ok: false, severity: "warn", detail: `PRD changed since planning (sha drift vs RunStatusDoc) — the router graph may be stale; re-plan or re-approve` }
						: { id: "prd", ok: true, severity: "info", detail: `PRD sha matches the planned digest` },
				);
			}
		} else {
			checks.push({ id: "prd", ok: true, severity: "info", detail: `PRD present at ${prdPath} (sha drift check needs the lock)` });
		}
	}

	// status-sidecar — parseable in both modes; task parity in storage mode.
	if (payload === undefined) {
		checks.push({ id: "status-sidecar", ok: true, severity: "info", detail: ".orch/status.json not written yet (a run/plan will create it)" });
	} else if (state) {
		const live = state.router.tasks.map((t) => `${t.id}:${t.status}`);
		const side = payload.tasks.map((t) => `${t.id}:${t.status}`);
		checks.push(
			JSON.stringify(live) === JSON.stringify(side)
				? { id: "status-sidecar", ok: true, severity: "info", detail: "status.json task statuses match the RouterDoc" }
				: { id: "status-sidecar", ok: false, severity: "warn", detail: `status.json is stale vs the RouterDoc (${side.join(", ")} vs ${live.join(", ")})` },
		);
	} else {
		checks.push({ id: "status-sidecar", ok: true, severity: "info", detail: "status.json parses (degraded read)" });
	}

	// mirrors — wave-log.jsonl + router.md bytes vs what the engine would render (storage mode only).
	if (state) {
		if (state.rows.length === 0 && state.router.phase === "empty" && state.router.tasks.length === 0) {
			// Fresh project: template placeholder bytes are expected — the engine syncs on the first commit.
			checks.push({ id: "mirrors", ok: true, severity: "info", detail: "mirrors not written yet (no state committed; the engine syncs them on commit)" });
		} else {
			const expectedRouter = renderRouterMd(state.router.tasks, state.router.phase, state.runStatus.prdPath, state.router.identity, state.router.archived);
			const expectedLog = renderWaveLogJsonl(state.rows);
			// Both mirrors are read through the same boundary: absent = the stated
			// drift line; refused = an explicit error, never the link target's bytes.
			const readMirror = async (relPath: string): Promise<string | { refused: string } | undefined> => {
				const read = await readSafeText({ root, path: relPath });
				if (read.kind === "ok") return read.value;
				if (read.kind === "absent") return undefined;
				return { refused: `refused (${read.code}): ${read.message}` };
			};
			const diskRouter = await readMirror("router.md");
			const diskLog = await readMirror(".orch/wave-log.jsonl");
			const drifts: string[] = [];
			if (diskRouter === undefined) drifts.push("router.md absent");
			else if (typeof diskRouter !== "string") drifts.push(`router.md ${diskRouter.refused}`);
			else if (diskRouter !== expectedRouter) drifts.push("router.md bytes differ from the RouterDoc render");
			if (diskLog === undefined) drifts.push(".orch/wave-log.jsonl absent");
			else if (typeof diskLog !== "string") drifts.push(`.orch/wave-log.jsonl ${diskLog.refused}`);
			else if (diskLog !== expectedLog) drifts.push(".orch/wave-log.jsonl bytes differ from the WaveLogDoc render");
			const refusedMirror = typeof diskRouter !== "string" && diskRouter !== undefined || (typeof diskLog !== "string" && diskLog !== undefined);
			checks.push(
				drifts.length
					? { id: "mirrors", ok: false, severity: refusedMirror ? "error" : "warn", detail: drifts.join("; ") }
					: { id: "mirrors", ok: true, severity: "info", detail: "router.md and wave-log.jsonl match the durable docs byte-for-byte" },
			);
		}
	} else {
		checks.push({ id: "mirrors", ok: true, severity: "info", detail: "skipped: mirror parity needs the lock" });
	}

	// storage-skip (degraded marker, first so readers see why sections are absent)
	if (degraded) {
		checks.push({ id: "storage-skip", ok: true, severity: "info", detail: "storage-bound aspects skipped: conversation detail, per-task usage joins, sleep-task state (lock busy)" });
	}

	// orphan — in_progress tasks while no run is live (storage mode implies the run is over).
	if (state) {
		const orphans = state.router.tasks.filter((t) => t.status === "in_progress");
		checks.push(
			orphans.length === 0
				? { id: "orphan", ok: true, severity: "info", detail: "no in_progress tasks" }
				: { id: "orphan", ok: false, severity: "warn", detail: `in_progress without a live run: ${orphans.map((t) => t.id).join(", ")} — rerun \`run --approve\` to resume` },
		);
	}

	// pending-sleep — the governor's durable sleep task.
	if (state && input.harness) {
		const sleepId = state.runStatus.sleepTaskId;
		if (sleepId === undefined) {
			checks.push({ id: "pending-sleep", ok: true, severity: "info", detail: "no durable sleep armed" });
		} else {
			const record = await input.harness.getTask(sleepId as unknown as never, BACKGROUND_CONTEXT).catch(() => undefined);
			const until = state.runStatus.sleepUntil;
			if (!record) {
				checks.push({ id: "pending-sleep", ok: false, severity: "warn", detail: `sleep task #${sleepId} missing from storage — stale RunStatusDoc pointer` });
			} else if (record.state.status === "terminal") {
				checks.push({ id: "pending-sleep", ok: true, severity: "info", detail: `sleep task #${sleepId} already terminal; clears on the next run` });
			} else {
				checks.push({ id: "pending-sleep", ok: true, severity: "info", detail: `sleep task #${sleepId} armed${until ? ` until ${new Date(until).toISOString()}` : ""} (rerun \`run\` to wait it out)` });
			}
			const cycles = state.runStatus.sleepCycleCount;
			if (input.config && cycles >= input.config.budgets.maxSleepCycles) {
				checks.push({ id: "pending-sleep", ok: false, severity: "warn", detail: `sleep cycles ${cycles} >= budgets.maxSleepCycles ${input.config.budgets.maxSleepCycles} — the task will quarantine on the next rate limit` });
			}
		}
	}

	// patches — quarantined tasks that MOVED the tree should have a saved patch;
	// zero-progress quarantines revert an empty diff (legitimately no patch file).
	const patchNames = input.artifacts.filter((a) => a.kind === "quarantine").map((a) => a.name);
	const zeroProgress = new Set(
		(state?.router.tasks ?? []).filter((t) => t.feedback.some((fb) => fb.text.includes("zero progress"))).map((t) => t.id),
	);
	const quarantined = (state ? state.router.tasks.filter((t) => t.status === "quarantined") : (payload?.tasks ?? []).filter((t) => t.status === "quarantined")).map((t) => t.id);
	const missing: string[] = [];
	for (const taskId of quarantined) {
		if (zeroProgress.has(taskId)) continue;
		if (!patchNames.some((name) => name.startsWith(`quarantined-${taskId}-w`))) missing.push(taskId);
	}
	checks.push(
		missing.length
			? { id: "patches", ok: false, severity: "warn", detail: `quarantined task(s) without a patch artifact: ${missing.join(", ")} — the wave diff may not have been saved` }
			: quarantined.length > 0
				? { id: "patches", ok: true, severity: "info", detail: `${quarantined.length} quarantined task(s) with saved patches (zero-progress quarantines exempt)` }
				: { id: "patches", ok: true, severity: "info", detail: "nothing quarantined" },
	);

	// alert + consecutive errors (governor state surfaced).
	const alert = state?.runStatus.activeAlert ?? payload?.alert;
	if (alert) checks.push({ id: "alert", ok: false, severity: "warn", detail: `active alert: ${alert}` });
	if (state && input.config && state.runStatus.consecutiveErrors >= input.config.budgets.maxConsecutiveErrors) {
		checks.push({ id: "consecutive-errors", ok: false, severity: "warn", detail: `${state.runStatus.consecutiveErrors} consecutive run failures ≥ cap ${input.config.budgets.maxConsecutiveErrors}` });
	}

	// seam — the readout schema version this kit publishes (A.3); always present.
	checks.push({ id: "seam", ok: true, severity: "info", detail: "UI seam available (readout.seam = 1: live wave state, timeline spans)" });

	// live — the side-car's wave must be plausible while the lock is held (A.3):
	// a future startedAt means clock skew; an ancient one means a killed run left
	// a stale wave-running flush behind.
	const liveTask = payload?.phase === "wave-running" ? payload.task : undefined;
	if (!liveTask?.id) {
		checks.push({ id: "live", ok: true, severity: "info", detail: "no live wave reported" });
	} else if (liveTask.startedAt === undefined) {
		checks.push({ id: "live", ok: true, severity: "info", detail: `live wave ${liveTask.id} #w${liveTask.wave} without startedAt (older kit flush)` });
	} else if (liveTask.startedAt - Date.now() > 5_000) {
		checks.push({ id: "live", ok: false, severity: "warn", detail: `wave-running startedAt is ${Math.round((liveTask.startedAt - Date.now()) / 1000)}s in the future — clock skew between the writer and this reader?` });
	} else if (Date.now() - liveTask.startedAt > 24 * 60 * 60 * 1000) {
		checks.push({ id: "live", ok: false, severity: "warn", detail: `wave-running side-car is stale: wave ${liveTask.id} #w${liveTask.wave} claims to run since ${new Date(liveTask.startedAt).toISOString()} (>24h)` });
	} else {
		checks.push({ id: "live", ok: true, severity: "info", detail: `live wave ${liveTask.id} #w${liveTask.wave} since ${new Date(liveTask.startedAt).toISOString()}` });
	}

	return checks;
}

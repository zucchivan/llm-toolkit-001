/**
 * The kit's own durable state: three pi-durable `defineDoc` documents plus the
 * git-tracked markdown/JSONL side-cars that make up the committed paper trail:
 *
 *   RouterDoc  (kind "loop.router", session-scoped)    → mirrored to router.md
 *   WaveLogDoc (kind "loop.wavelog", session-scoped)   → mirrored to .orch/wave-log.jsonl
 *   RunStatusDoc (kind "loop.run", session-scoped)     → flushed to .orch/status.json
 *
 * Expressions of the same state in three media: storage (durable truth),
 * git-tracked side-cars (the human+CI paper trail), and atomic JSON for the
 * live cross-process status view.
 *
 * All pi-durable surface reaches this module through `./kit.ts` — the pinned,
 * mechanically enforced seam (M0-P02). This module never imports the SDK.
 */
import type { JsonValue } from "@earendil-works/chord";
import { defineDoc } from "./kit.ts";
import type { JsonObject, SessionDocToken } from "./kit.ts";
import { KIT_VERSION } from "../config.ts";
import { shasum } from "../util/git.ts";
import { atomicWrite, atomicWriteJson } from "../util/fsx.ts";
import type { ArchivedPlanRef, PlanIdentity } from "./plans.ts";

// ---------------------------------------------------------------------------
// RouterDoc
// ---------------------------------------------------------------------------

export type TaskStatus = "todo" | "in_progress" | "done" | "quarantined";
export const TASK_STATUS_ORDER: readonly TaskStatus[] = ["todo", "in_progress", "done", "quarantined"];

export type TaskFeedback = {
	wave: number;
	from: "gate" | "verifier" | "handoff";
	text: string;
	ts: number;
}

export type RouterTask = {
	id: string;
	title: string;
	/** ≤10-line spec written by the planner. */
	spec: string;
	/** IDs of tasks that must be done before this one (DAG). */
	dependsOn: string[];
	/** 1–5 checkable EARS-style criteria ("When X, the system shall Y"). */
	acceptance: string[];
	/** Globs/paths the task owns; gate scope enforcement + verifier diff cutoff. */
	targetPaths: string[];
	/** Higher first at equal DAG position. */
	priority: number;
	status: TaskStatus;
	waveCount: number;
	/** Durable conversation id of this task's implementer conversation. */
	convId?: number;
	/** Tree SHA captured before Wave 1 (§4.2.3). */
	baselineTreeSha?: string;
	/** SHA of the last failing gate output — duplicate-error breaker. */
	lastGateHash?: string;
	feedback: TaskFeedback[];
}

export type RouterDocValue = {
	version: 2;
	/** empty → planned (review point) → running → complete. */
	phase: "empty" | "planned" | "running" | "complete";
	tasks: RouterTask[];
	/** Identity of the CURRENT plan. Absent only on plans created before v2:
	 *  legacy plans stay readable but are never executed (replan to migrate). */
	identity?: PlanIdentity;
	/** References to REPLACED plans, most recent first. References only —
	 *  never receipts. Legacy (v1) plans had no identity, so replacing one
	 *  archives nothing (the wave-log row records the replacement). */
	archived: ArchivedPlanRef[];
}

export const RouterDoc: SessionDocToken<RouterDocValue> = defineDoc({
	kind: "loop.router",
	version: 2,
	scope: "session",
	initial: (): RouterDocValue => ({ version: 2, phase: "empty", tasks: [], archived: [] }),
	migrate: migrateRouterDoc,
	checkpointWhen: () => true, // tiny doc; store every change as a full base
});

/**
 * RouterDoc v1 → v2 (pure; the pinned `defineDoc` migrate contract).
 *
 * Old rows stay readable with their historical task statuses. The migration
 * invents NOTHING: no identity/planRevision is synthesized for legacy plans
 * (an unmigrated plan never runs — the operator replans), no receipts are
 * reconstructed from markdown or row prose, and `archived` starts empty.
 */
export function migrateRouterDoc(value: JsonObject, fromVersion: number): RouterDocValue {
	if (fromVersion !== 1) throw new Error(`loop.router has no migration from version ${fromVersion}`);
	const v1 = value as unknown as {
		phase?: RouterDocValue["phase"];
		tasks?: RouterTask[];
	};
	return {
		version: 2,
		phase: v1.phase ?? "empty",
		tasks: Array.isArray(v1.tasks) ? v1.tasks : [],
		archived: [],
	};
}

// ---------------------------------------------------------------------------
// WaveLogDoc — synchronized append-only JSONL side-car
// ---------------------------------------------------------------------------

export type WaveRowKind = "wave" | "gate" | "verdict" | "task" | "governor" | "handoff" | "delivery" | "engine";
export type WaveRow = {
	ts: number;
	kind: WaveRowKind;
	/** Task id or "session". */
	task: string;
	wave?: number;
	verb: string;
	detail?: string;
	/** UI seam A.7: the wave's own git tree, captured for `wave` start/end rows
	 *  (throwaway-index capture inside the engine's windows). Optional: rows that
	 *  predate the seam, or a failed capture, carry no tree — those waves are
	 *  simply not isolatable, never a failed run. */
	treeSha?: string;
	costUsd?: number;
	tokens?: number;
	verdict?: string;
	provider?: string;
	modelId?: string;
	reason?: string;
	/** M0-P11 (additive): the `loop.receipts` pass receipt id this verdict row
	 *  was committed with. Journal-stage latest pointers live in ReceiptsDoc,
	 *  not in display rows. Absent on legacy rows and diagnostic verifies. */
	receipt?: string;
}

type WaveLogDocValue = {
	version: 1;
	rows: WaveRow[];
}

export const WaveLogDoc: SessionDocToken<WaveLogDocValue> = defineDoc({
	kind: "loop.wavelog",
	version: 1,
	scope: "session",
	initial: () => ({ version: 1, rows: [] }),
	checkpointWhen: () => true,
});

// ---------------------------------------------------------------------------
// RunStatusDoc
// ---------------------------------------------------------------------------

export type RunStatusDocValue = {
	version: 2;
	prdPath?: string;
	prdSha?: string;
	/** v2: the plan revision the current approval stamp belongs to. Approval
	 *  authorizes a run only when this names the RouterDoc's CURRENT
	 *  planRevision — a timestamp alone (v1 legacy stamps included) authorizes
	 *  nothing, and a successful replan clears the pair atomically. */
	approvedPlanRevision?: string;
	/** v2 (M0-P05): the granted task ids (sorted, unique) of the approval stamp.
	 *  The grant is the ADR 01 triple — {planRevision: approvedPlanRevision,
	 *  selected: approvedSelected, humanApprovedAt} — and it authorizes a run
	 *  only when ALL three are present and the revision names the RouterDoc's
	 *  CURRENT planRevision. Stamps without the selection (pre-grant v2 rows
	 *  and migrated v1 stamps alike) authorize nothing, and a successful
	 *  replan clears the whole triple atomically. */
	approvedSelected?: string[];
	/** Epoch ms when a human stamped approval for `approvedPlanRevision`
	 *  (plan --approve or run --approve). A v1-legacy stamp without the
	 *  revision pair is historical and never authorizes a run. */
	humanApprovedAt?: number;
	/** Cumulative estimated spend, USD. */
	budgetSpentUsd: number;
	activeAlert?: string;
	/** Live sleep task (rate-limit breaker) the next run waits for before resuming. */
	sleepTaskId?: number;
	sleepUntil?: number;
	sleepCycleCount: number;
	consecutiveErrors: number;
	kitVersion: string;
}

export const RunStatusDoc: SessionDocToken<RunStatusDocValue> = defineDoc({
	kind: "loop.run",
	version: 2,
	scope: "session",
	// New stores record the CREATING kit's identity; the package version is the
	// single source (config.ts reads package.json). Values recorded by older
	// kits are historical state and are never rewritten.
	initial: (): RunStatusDocValue => ({ version: 2, budgetSpentUsd: 0, sleepCycleCount: 0, consecutiveErrors: 0, kitVersion: KIT_VERSION }),
	migrate: migrateRunStatusDoc,
	checkpointWhen: () => true,
});

/**
 * RunStatusDoc v1 → v2 (pure; the pinned `defineDoc` migrate contract).
 *
 * Every historical field survives readable — including the v1
 * `humanApprovedAt` stamp. The migration does NOT translate that stamp into a
 * v2 approval: `approvedPlanRevision` stays ABSENT, so the legacy timestamp
 * alone authorizes no run (only a stamp naming the current plan revision
 * does). Recorded kitVersion/spend/sleep state are never rewritten.
 */
export function migrateRunStatusDoc(value: JsonObject, fromVersion: number): RunStatusDocValue {
	if (fromVersion !== 1) throw new Error(`loop.run has no migration from version ${fromVersion}`);
	return { ...(value as unknown as RunStatusDocValue), version: 2 };
}

// ---------------------------------------------------------------------------
// Side-car renderers (best-effort; storage stays the truth)
// ---------------------------------------------------------------------------

export function renderRouterMd(
	tasks: RouterTask[],
	phase: RouterDocValue["phase"],
	prd?: string,
	identity?: PlanIdentity,
	archived: readonly ArchivedPlanRef[] = [],
): string {
	const lines: string[] = [
		"# router — implementation plan of record",
		"",
		"> Mirror of the RouterDoc kept in durable storage; the engine rewrites this file.",
		phase === "planned"
			? "> STATUS: PLANNED — human review pending (`llm-toolkit-001 run --approve` to start)."
			: phase === "complete"
				? "> STATUS: COMPLETE — task queue drained."
				: "> STATUS: RUNNING/COMPLETE.",
	];
	// The durable review identity (M0-P04): a fresh revision per plan — NOT the
	// storage schema version. Legacy plans (no identity) render without these
	// lines so migrated mirrors stay byte-identical to their v1 renders.
	if (identity) {
		lines.push(`> PLAN REVISION: ${identity.planRevision}`);
		lines.push(`> DEFINITION SHA256: ${identity.definitionSha256}`);
		if (identity.controlsSha256) lines.push(`> CONTROLS SHA256: ${identity.controlsSha256}`);
	}
	lines.push("");
	if (prd) lines.push(`PRD: ${prd}`, "");
	let i = 0;
	for (const task of tasks) {
		i += 1;
		lines.push(`## ${i}. ${task.id} — ${task.title}`, "", `- STATUS: ${task.status}`, `- WAVES: ${task.waveCount}`);
		if (task.dependsOn.length) lines.push(`- DEPENDS ON: ${task.dependsOn.join(", ")}`);
		if (task.targetPaths.length) lines.push(`- TARGET PATHS: ${task.targetPaths.join(", ")}`);
		if (task.baselineTreeSha) lines.push(`- BASELINE TREE: ${task.baselineTreeSha}`);
		if (task.lastGateHash) lines.push(`- LAST GATE HASH: ${task.lastGateHash}`);
		lines.push("", "**spec:**", "", task.spec.replace(/^\s*<10-line spec>?.*$/m, "").trim());
		lines.push("", "**acceptance criteria:**", "");
		task.acceptance.forEach((a, j) => lines.push(`${j + 1}. ${a}`));
		if (task.feedback.length) {
			lines.push("", "**feedback (cooldowns not all shown here — see wave-log):**", "");
			for (const fb of task.feedback.slice(-5)) lines.push(`- wave ${fb.wave} [${fb.from}] ${fb.text.replaceAll("\n", " ⏎ ")}`);
		}
		lines.push("");
	}
	if (archived.length) {
		lines.push("## archived plan revisions", "");
		for (const ref of archived) {
			lines.push(`- ${ref.planRevision} (archived ${new Date(ref.archivedAt).toISOString()}; definition sha256 ${ref.definitionSha256.slice(0, 12)})`);
		}
		lines.push("");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

function jsonl(rows: readonly WaveRow[]): string {
	return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** The exact bytes the engine mirrors into .orch/wave-log.jsonl (visibility parity checks). */
export function renderWaveLogJsonl(rows: readonly WaveRow[]): string {
	return jsonl(rows);
}

export interface MirrorTargets {
	routerMd: string;
	waveLogJsonl: string;
}

/** After a commit that changed Router/WaveLog docs, sync both side-cars. */
export async function syncSideCars(
	ctx: { tasks: RouterTask[]; phase: RouterDocValue["phase"]; rows: WaveRow[]; identity?: PlanIdentity; archived?: readonly ArchivedPlanRef[] },
	targets: MirrorTargets,
	prd?: string,
): Promise<void> {
	await Promise.all([
		atomicWrite(targets.routerMd, renderRouterMd(ctx.tasks, ctx.phase, prd, ctx.identity, ctx.archived)).catch(() => {}),
		atomicWrite(targets.waveLogJsonl, jsonl(ctx.rows)).catch(() => {}),
	]);
}

/** PRD content SHA for RunStatusDoc.prdSha. */
export const prdSha = (text: string): string => shasum(text);

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
 * `pi-durable` is imported ONLY here and in harness.ts (API encapsulation, §3.10).
 */
import type { JsonValue } from "@earendil-works/chord";
import type { SessionDocToken } from "@earendil-works/pi-durable";
import { defineDoc } from "./kit.ts";
import { shasum } from "../util/git.ts";
import { atomicWrite, atomicWriteJson } from "../util/fsx.ts";

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
	/** Tree SHA captured before Wave 1 (§4.2.3). */
	baselineTreeSha?: string;
	/** SHA of the last failing gate output — duplicate-error breaker. */
	lastGateHash?: string;
	feedback: TaskFeedback[];
}

export type RouterDocValue = {
	version: 1;
	/** "empty" | "planned" — plan stops on "planned", waiting for --approve / humanApprovedAt. */
	phase: "empty" | "planned";
	tasks: RouterTask[];
}

export const RouterDoc: SessionDocToken<RouterDocValue> = defineDoc({
	kind: "loop.router",
	version: 1,
	scope: "session",
	initial: () => ({ version: 1, phase: "empty", tasks: [] }),
	checkpointWhen: () => true, // tiny doc; store every change as a full base
});

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
	costUsd?: number;
	tokens?: number;
	verdict?: string;
	provider?: string;
	modelId?: string;
	reason?: string;
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
	version: 1;
	prdPath?: string;
	prdSha?: string;
	/** Epoch ms when a human stamped approval (plan --approve or run --approve). */
	humanApprovedAt?: number;
	/** Cumulative estimated spend, USD. */
	budgetSpentUsd: number;
	activeAlert?: string;
	/** Live sleep task (rate-limit breaker) the next run waits for before resuming. */
	sleepTaskId?: string;
	sleepUntil?: number;
	sleepCycleCount: number;
	consecutiveErrors: number;
	kitVersion: string;
}

export const RunStatusDoc: SessionDocToken<RunStatusDocValue> = defineDoc({
	kind: "loop.run",
	version: 1,
	scope: "session",
	initial: () => ({ version: 1, budgetSpentUsd: 0, sleepCycleCount: 0, consecutiveErrors: 0, kitVersion: "0.1.0" }),
	checkpointWhen: () => true,
});

// ---------------------------------------------------------------------------
// Side-car renderers (best-effort; storage stays the truth)
// ---------------------------------------------------------------------------

export function renderRouterMd(tasks: RouterTask[], phase: RouterDocValue["phase"], prd?: string): string {
	const lines: string[] = [
		"# router — implementation plan of record",
		"",
		"> Mirror of the RouterDoc kept in durable storage; the engine rewrites this file.",
		phase === "planned"
			? "> STATUS: PLANNED — human review pending (`llm-toolkit-001 run --approve` to start)."
			: "> STATUS: RUNNING/COMPLETE.",
		"",
	];
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
	return `${lines.join("\n").trimEnd()}\n`;
}

function jsonl(rows: readonly WaveRow[]): string {
	return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

export interface MirrorTargets {
	routerMd: string;
	waveLogJsonl: string;
}

/** After a commit that changed Router/WaveLog docs, sync both side-cars. */
export async function syncSideCars(
	ctx: { tasks: RouterTask[]; phase: RouterDocValue["phase"]; rows: WaveRow[] },
	targets: MirrorTargets,
	prd?: string,
): Promise<void> {
	await Promise.all([
		atomicWrite(targets.routerMd, renderRouterMd(ctx.tasks, ctx.phase, prd)).catch(() => {}),
		atomicWrite(targets.waveLogJsonl, jsonl(ctx.rows)).catch(() => {}),
	]);
}

/** PRD content SHA for RunStatusDoc.prdSha. */
export const prdSha = (text: string): string => shasum(text);

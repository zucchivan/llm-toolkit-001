/**
 * Governor (§4.5): budget ceilings, zero-progress / duplicate-failure circuit
 * breakers, consecutive-error breaker, and the rate-limit durable sleep.
 *
 * The sleep is a durably committed task (`kit.sleep`) using runtime.sleepUntil:
 * it survives restarts, is woken by the harness clock when due, and any later
 * `run` that opens the storage waits for it before picking work back up.
 * Exit-code 42 = "sleeping until provider reset"; rerun `<kit> run` to resume.
 */
import { defineTask, BACKGROUND_CONTEXT } from "./kit.ts";
import type { LoopAndLock, LoopHarness } from "./harness.ts";
import { commitState, readSessionState } from "./state.ts";
import { usageUsd } from "../util/budget.ts";
import { convId } from "./kit.ts";
import type { UsageLike } from "../util/budget.ts";
import type { CostRates } from "../util/budget.ts";
import type { WaveRow } from "./infos.ts";

// ---------------------------------------------------------------------------
// Budget accounting
// ---------------------------------------------------------------------------

export interface BudgetView {
	spentUsd: number;
	sessionUsd: number;
	waveWarnUsd: number;
	remainingUsd: number;
}

export function budgetView(kit: LoopAndLock, spentUsd: number): BudgetView {
	const { sessionUsd, waveUsdWarn } = kit.loop.config.budgets;
	return { spentUsd, sessionUsd, waveWarnUsd: waveUsdWarn, remainingUsd: Math.max(0, sessionUsd - spentUsd) };
}

/** Session spend in USD, provider cost when reported, else role rates, else 0. */
export function sessionSpentEstimate(kit: LoopAndLock, usage: Awaited<ReturnType<LoopHarness["sessionUsage"]>>): number {
	const rates: Record<string, CostRates> = {};
	for (const role of Object.values(kit.loop.config.roles)) {
		rates[`${role.provider}/${role.modelId}`] = {
			costPerMillionInput: (role as { costPerMillionInput?: number }).costPerMillionInput,
			costPerMillionOutput: (role as { costPerMillionOutput?: number }).costPerMillionOutput,
		};
	}
	let total = 0;
	for (const [key, u] of Object.entries(usage.byModel)) {
		total += usageUsd(u as unknown as UsageLike, rates[key]);
	}
	return total;
}

/** Estimated USD of ONE wave conversation readout (before/after delta). */
export function waveUsd(before: { usd: number }, after: { usd: number }): number {
	return Math.max(0, after.usd - before.usd);
}

export { budgetView as budgetsView, sessionSpentEstimate as sessionUsdEstimate };

// ---------------------------------------------------------------------------
// Rate-limit reasons / sleep decision
// ---------------------------------------------------------------------------

const RATE_LIMIT_MARKERS = [
	"rate limit",
	"rate_limit",
	"ratelimit",
	"429",
	"too many requests",
	"resets at",
	"try again in",
	"quota",
	"billing period",
];

export function looksLikeRateLimit(detail: unknown): boolean {
	const text = String(detail ?? "").toLowerCase();
	return RATE_LIMIT_MARKERS.some((m) => text.includes(m));
}

/** Seconds until reset parsed from common provider phrasing ("resets in 90m"). */
export function parseResetDelay(detail: unknown): number | undefined {
	const text = String(detail ?? "");
	const minutes = text.toLowerCase().match(/(?:resets? in|try again in|retry after)\s+(\d+)\s*m/);
	if (minutes?.[1]) return Number(minutes[1]) * 60;
	const seconds = text.toLowerCase().match(/(?:resets? in|try again in|retry after)\s+(\d+)\s*s/);
	if (seconds?.[1]) return Number(seconds[1]);
	const hours = text.toLowerCase().match(/(?:resets? in|try again in|retry after)\s+(\d+)\s*h/);
	if (hours?.[1]) return Number(hours[1]) * 3600;
	return undefined;
}

// ---------------------------------------------------------------------------
// Rate-limit durable sleep task
// ---------------------------------------------------------------------------

export { GovernorSleep } from "./tasks.ts";
import { GovernorSleep } from "./tasks.ts";

/**
 * Arm the rate-limit sleep: create (or reuse) the durable sleep task, record it
 * in RunStatusDoc, append governor rows, and let the caller close/exit 42.
 */
export async function armRateLimitSleep(
	kit: LoopAndLock,
	params: { until: number; reason: string; taskId: string; wave: number; conversationId: number },
): Promise<number> {
	const harness = kit.loop.harness;
	const sleepingUntil = params.until;
	const sleepTaskId = await harness.commit(async (tx: unknown) => {
		const created = await (tx as { createTask: (t: unknown, i: unknown, o: unknown) => Promise<unknown> }).createTask(
			GovernorSleep,
			{ until: sleepingUntil, reason: params.reason },
			{ ownership: { kind: "conversation" }, conversationId: convId(params.conversationId) },
		);
		return created as unknown as number;
	}, BACKGROUND_CONTEXT);

	await commitState(kit, {
		runStatus: (d) => {
			d.sleepTaskId = sleepTaskId;
			d.sleepUntil = sleepingUntil;
			d.sleepCycleCount += 1;
			d.activeAlert = `rate limit: ${params.reason} — sleeping until ${new Date(sleepingUntil).toISOString()}`;
			d.consecutiveErrors += 1;
		},
		rows: sleepRows(params, sleepingUntil, sleepTaskId),
		statusPhase: { phase: "idle", message: `sleeping until ${new Date(sleepingUntil).toISOString()} (rate limit)` },
	});
	return sleepTaskId;
}

function sleepRows(
	params: { until: number; reason: string; taskId: string; wave: number },
	sleepingUntil: number,
	sleepTaskId: number,
): WaveRow[] {
	return [
		{
			ts: Date.now(),
			kind: "governor",
			task: params.taskId,
			wave: params.wave,
			verb: "rate-limit-sleep",
			reason: params.reason,
			detail: `durable sleep task #${sleepTaskId} until ${new Date(sleepingUntil).toISOString()}`,
		},
	];
}

/** A live sleep from a previous run: wait for it (timers wake it when due). */
export async function waitOutSleep(kit: LoopAndLock): Promise<boolean> {
	const state = await readSessionState(kit.loop.harness);
	const id = state.runStatus.sleepTaskId;
	if (id === undefined) return false;
	const record = await kit.loop.harness.getTask(id as unknown as never, BACKGROUND_CONTEXT).catch(() => undefined);
	if (!record || record.state.status === "terminal") {
		// Stale sleep id (task already finished before close): clear and continue.
		await commitState(kit, {
			runStatus: (d) => {
				delete d.sleepTaskId;
				delete d.sleepUntil;
				delete d.activeAlert;
				d.consecutiveErrors = 0;
			},
			rows: [{ ts: Date.now(), kind: "governor", task: "session", verb: "sleep-clear", detail: "sleep task already terminal" }],
		});
		return false;
	}
	kit.loop.harness.resume();
	await kit.loop.harness.waitForTask(record.id as never, BACKGROUND_CONTEXT);
	await commitState(kit, {
		runStatus: (d) => {
			delete d.sleepTaskId;
			delete d.sleepUntil;
			delete d.activeAlert;
			d.sleepCycleCount = 0;
		},
		rows: [{ ts: Date.now(), kind: "governor", task: "session", verb: "sleep-woke", detail: "resumed after rate-limit sleep" }],
	});
	return true;
}

// ---------------------------------------------------------------------------
// Breaker verdicts the driver checks after each wave (§4.5)
// ---------------------------------------------------------------------------

export interface WaveBreakerInput {
	/** files changed in the wave (diff vs pre-wave tree) */
	filesChanged: string[];
	/** hash of failing gate output this wave */
	gateFailHash?: string;
	/** task.currentTargets.wave <= retryLimit? handled by caller */
	lastGateHash?: string | null;
	retryLimit: number;
	waveCount: number;
}

export function duplicateFailureAhead(wave: WaveBreakerInput): boolean {
	return wave.gateFailHash !== undefined && wave.gateFailHash === wave.lastGateHash;
}

// A wave that changed no files is a zero-progress wave: quarantine immediately.
export function zeroProgressThreshold(crossed: { filesChanged: string[] }): boolean {
	return crossed.filesChanged.length === 0;
}

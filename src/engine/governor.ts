/**
 * Governor (§4.5): budget ceilings, zero-progress / duplicate-failure circuit
 * breakers, consecutive-error breaker, and the BOUNDED rate-limit durable
 * sleep (M0-P17).
 *
 * The sleep is a durably committed task (`kit.sleep`) using runtime.sleepUntil:
 * it survives restarts, is woken by the harness clock when due, and any later
 * `run` that opens the storage waits for it before picking work back up.
 * Exit-code 42 = "sleeping until provider reset"; rerun `<kit> run` to resume.
 *
 * M0-P17 bounding: each task owns a durable sleep counter (RouterTask
 * .sleepCycles) checked BEFORE a timer is created and incremented atomically
 * with it. `budgets.maxSleepCycles` (incl. 0) exhausted means no new timer is
 * ever created for that task — the wave stops once (quarantine) instead.
 * Waking the timer resets nothing: the consecutive-error streak clears only on
 * a successful answered submission, and the sleep counter clears for the next
 * task or an explicitly granted human retry.
 */
import { defineTask, BACKGROUND_CONTEXT } from "./kit.ts";
import type { LoopAndLock, LoopHarness } from "./harness.ts";
import { commitState, readSessionState } from "./state.ts";

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

/**
 * Session spend in USD — the priced total of a `sessionUsage()` account
 * (reported cost, then config rates, then catalog, then the faux
 * simulated-zero exemption; unpriced classes are excluded and listed in
 * `usage.unpriced`, never labeled free).
 */
export function sessionSpentEstimate(kit: LoopAndLock, usage: Awaited<ReturnType<LoopHarness["sessionUsage"]>>): number {
	void kit;
	return usage.totalUsd;
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
// Rate-limit durable sleep task (M0-P17: bounded per-task sleeps)
// ---------------------------------------------------------------------------

export { GovernorSleep } from "./tasks.ts";
import { GovernorSleep } from "./tasks.ts";

/**
 * The per-task durable-sleep budget (M0-P17): `RouterTask.sleepCycles` counts
 * the sleep timers THIS task has consumed across restarts; the cap is
 * `budgets.maxSleepCycles`. Exhausting it means no NEW timer is ever created —
 * the caller stops the task once (quarantine) instead of arming again.
 */
export interface SleepBudget {
	used: number;
	cap: number;
	exhausted: boolean;
}

export async function sleepBudgetState(kit: LoopAndLock, taskId: string): Promise<SleepBudget> {
	const state = await readSessionState(kit.loop.harness);
	const used = state.router.tasks.find((entry) => entry.id === taskId)?.sleepCycles ?? 0;
	const cap = kit.loop.config.budgets.maxSleepCycles;
	return { used, cap, exhausted: used >= cap };
}

/**
 * Arm the rate-limit sleep: create the durable sleep task and record its id,
 * deadline, and the per-task counter in ONE atomic commit — but ONLY after
 * checking the per-task sleep budget first. When the budget is exhausted (cap
 * reached, including a zero cap), NO new timer is created and `undefined` is
 * returned: the caller stops the task once (quarantine/blocked) instead of
 * arming again. The counter is never reset because a timer woke; it clears for
 * the next task (each task starts at 0) or an explicitly granted human retry.
 */
export async function armRateLimitSleep(
	kit: LoopAndLock,
	params: { until: number; reason: string; taskId: string; wave: number; conversationId: number },
): Promise<number | undefined> {
	const budget = await sleepBudgetState(kit, params.taskId);
	if (budget.exhausted) return undefined; // cap reached — no new timer, ever
	const sleepingUntil = params.until;
	const result = await commitState(kit, {
		runStatus: (d) => {
			d.activeAlert = `rate limit: ${params.reason} — sleeping until ${new Date(sleepingUntil).toISOString()}`;
			d.consecutiveErrors += 1;
		},
		sleepTask: {
			input: { until: sleepingUntil, reason: params.reason },
			conversationId: params.conversationId,
			taskId: params.taskId,
			wave: params.wave,
			reason: params.reason,
		},
		statusPhase: { phase: "idle", message: `sleeping until ${new Date(sleepingUntil).toISOString()} (rate limit)` },
	});
	return result.sleepTaskId;
}

/**
 * A live sleep from a previous run: wait for it (timers wake it when due).
 * M0-P17: waking the timer does NOT reset the consecutive-error streak (only a
 * successful answered submission does) and does NOT reset the per-task sleep
 * counter (it clears for the next task or an explicitly granted human retry).
 */
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

/**
 * Model admission (M0-P16, §3 per-request budget seam): ONE gate,
 * `admitSubmission(stage, checkpoint)`, guards EVERY paid submission —
 * planner, every implementer retry, primary, skeptic, and one-off verify —
 * before any provider call is made. It reads the FRESH session spend
 * high-water and refuses at `>=` (a zero ceiling refuses everything), records
 * the stop (governor row + status), and makes no call. A stop is a budget
 * PAUSE, never a reject: the paused stage checkpoint stays pending, the
 * verified candidate is preserved, and raising `budgets.sessionUsd` resumes
 * the same pass without a second charge.
 *
 * Two more layers make the boundary airtight:
 *
 *  - The `Models` dispatch guard (`guardModelsDispatch`) wraps the session's
 *    Models object before delegation, so EVERY provider dispatch — the first
 *    request of a submission, every tool follow-up, SDK-level transport
 *    retries, and compaction calls — passes the same high-water check. A
 *    denial is a distinctive, non-retryable error message the driver maps
 *    back to a budget pause (never a model failure, never a sleep).
 *  - The afterResponse budget hook (`budgetGuardExtension`) folds each
 *    finished provider turn's priced usage into the high-water snapshot, so a
 *    submission that spends its allowance mid-flight is denied BEFORE its
 *    next dispatch (tool follow-up, retry, or compaction) instead of after.
 *
 * Pricing never labels unknown spend free: `priceUsage` (util/budget.ts)
 * refuses unpriced cache deltas (no flat-input approximation) and unknown
 * prices on previously used nonzero classes; fixture/faux providers may
 * legitimately report simulated zero.
 *
 * Disclosed limits: hidden transport retries and external service calls made
 * BY a provider implementation are invisible until their usage is recorded;
 * the guard sees the session high-water, not a provider's internal bill. One
 * admitted in-flight request can overrun the ceiling — this is not a hard
 * bill cap, and there is no speculative cost reservation.
 */
import { defineExtension, GenerationTask, hook } from "./kit.ts";
import type { Extension, Models } from "./kit.ts";
import type { LoopAndLock } from "./harness.ts";
import { commitState, readSessionState } from "./state.ts";
import type { UsageLike } from "../util/budget.ts";
import { priceUsage, type CatalogClassRates, type CostRates, type UsagePricing } from "../util/budget.ts";

/** Distinctive, non-retryable denial text (kept free of rate-limit/retryable wording and bare status codes). */
export const BUDGET_DENIAL_MARKER = "kit budget admission: paid model dispatch paused";

export class BudgetAdmissionError extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(reason);
		this.name = "BudgetAdmissionError";
		this.reason = reason;
	}
}

/** True when a settled run failure/detail carries the budget-denial marker. */
export function isBudgetDenial(detail: unknown): boolean {
	return String(detail ?? "").includes(BUDGET_DENIAL_MARKER);
}

// ---------------------------------------------------------------------------
// Dispatch guard state
// ---------------------------------------------------------------------------

/**
 * The high-water snapshot every dispatch is checked against. Refreshed from
 * fresh session usage at each admission and at every run boundary, and folded
 * forward turn-by-turn by the afterResponse hook. `unpriced` classes pause
 * dispatch just like a breached ceiling (never labeled free).
 */
export interface BudgetGuardState {
	ceilingUsd: number;
	spentUsd: number;
	unpriced: string[];
}

export function createBudgetGuardState(ceilingUsd: number): BudgetGuardState {
	return { ceilingUsd, spentUsd: 0, unpriced: [] };
}

export function guardDenies(state: BudgetGuardState): boolean {
	return state.unpriced.length > 0 || state.spentUsd >= state.ceilingUsd;
}

/** Sync the snapshot from a fresh session read. */
export function syncGuardState(state: BudgetGuardState, ceilingUsd: number, spentUsd: number, unpriced: string[]): void {
	state.ceilingUsd = ceilingUsd;
	state.spentUsd = Math.max(state.spentUsd, spentUsd);
	state.unpriced = unpriced;
}

export type UsagePricer = (key: string, usage: UsageLike) => UsagePricing;

/**
 * A denied dispatch's stand-in: an async setup-error stream (built at the kit
 * seam by `modelStreamSetupError`). The stream settles `unanswered` with the
 * denial detail, which the driver maps back to a budget pause.
 */
export type DeniedModelStream = (model: { provider: string; id: string }, error: Error) => unknown;

/**
 * Wrap a Models object so every chat/deferred dispatch passes the high-water
 * check first: the initial request of a submission, every tool follow-up,
 * SDK-level transport retries, and compaction calls. Read accessors and
 * image/classifier operations pass through untouched — the kit dispatches
 * none of them.
 */
export function guardModelsDispatch(models: Models, state: BudgetGuardState, deniedStream: DeniedModelStream): Models {
	const deny = (model: { provider: string; id: string }): Error => {
		const detail = state.unpriced.length
			? `observed spend is unpriceable (${state.unpriced.join("; ")}) — set rates or use a priced model`
			: "the session spend high-water reached the configured ceiling — raise budgets.sessionUsd and rerun";
		return new BudgetAdmissionError(`${BUDGET_DENIAL_MARKER} — ${detail} [${model.provider}/${model.id}]`);
	};
	return new Proxy(models, {
		get(target, prop, receiver) {
			if (prop === "stream" || prop === "streamSimple" || prop === "streamDeferred") {
				return (model: { provider: string; id: string }, ...rest: unknown[]) => {
					if (guardDenies(state)) return deniedStream(model, deny(model));
					return (target as unknown as Record<string, (...args: unknown[]) => unknown>)[prop as string]!.call(target, model, ...rest);
				};
			}
			if (prop === "complete" || prop === "completeSimple" || prop === "fetchDeferred") {
				return async (model: { provider: string; id: string }, ...rest: unknown[]) => {
					// The async completions resolve with the denial message
					// (stopReason "error", marker detail) so compaction and poll
					// callers classify it like a provider error instead of
					// faulting their task on a synchronous throw.
					if (guardDenies(state)) return (deniedStream(model, deny(model)) as { result: () => Promise<unknown> }).result();
					return (target as unknown as Record<string, (...args: unknown[]) => unknown>)[prop as string]!.call(target, model, ...rest);
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(receiver) : value;
		},
	}) as Models;
}

/**
 * The afterResponse budget hook: fold each finished provider turn's priced
 * usage into the high-water snapshot so the NEXT dispatch of the submission
 * (tool follow-up, SDK retry, compaction) is checked against spend that
 * includes the turn that just landed. Synchronous; reads nothing — it only
 * mutates the in-memory snapshot, and the next admission re-syncs it from
 * fresh session usage anyway.
 */
export function budgetGuardExtension(state: BudgetGuardState, price: UsagePricer): Extension<never> {
	return defineExtension({
		name: "kit-budget-guard",
		hooks: [
			hook(GenerationTask, {
				afterResponse: (message) => {
					const assistant = message as unknown as {
						provider?: string;
						model?: string;
						usage?: UsageLike;
					};
					if (!assistant.usage || !assistant.provider || !assistant.model) return;
					const key = `${assistant.provider}/${assistant.model}`;
					const priced = price(key, assistant.usage);
					if (priced.kind === "priced") {
						state.spentUsd += priced.usd;
					} else if (!state.unpriced.includes(`${key}: ${priced.reason}`)) {
						state.unpriced.push(`${key}: ${priced.reason}`);
					}
				},
			}),
		],
	}) as Extension<never>;
}

// ---------------------------------------------------------------------------
// admitSubmission — the single paid-submission gate
// ---------------------------------------------------------------------------

export type SubmissionStage = "planner" | "implement" | "primary" | "skeptic" | "verify";

/** Where the refused submission belongs (wave context when there is one). */
export interface AdmissionCheckpoint {
	planRevision?: string;
	taskId?: string;
	wave?: number;
}

export type Admission =
	| { admitted: true; spentUsd: number }
	| { admitted: false; reason: string };

/**
 * The single gate in front of every paid submission. Refuses at `>=` —
 * including a zero ceiling — and when the observed spend is unpriceable;
 * records the stop (governor row + alert + status message) and makes no
 * call. Callers turn a refusal into their stop shape (driver "budget" exit,
 * CLI exit 2, or a thrown BudgetAdmissionError on standalone commands).
 */
export async function admitSubmission(
	kit: LoopAndLock,
	stage: SubmissionStage,
	checkpoint: AdmissionCheckpoint = {},
): Promise<Admission> {
	const ceiling = kit.loop.config.budgets.sessionUsd;
	const [usage, sessionState] = await Promise.all([
		kit.loop.sessionUsage(),
		readSessionState(kit.loop.harness),
	]);
	// Session high-water: the recorded accumulator (prior usage is always
	// counted) and the fresh priced session total agree by taking the max.
	const spent = Math.max(usage.totalUsd, sessionState.runStatus.budgetSpentUsd);
	syncGuardState(kit.loop.budgetGuard, ceiling, spent, usage.unpriced);
	if (usage.unpriced.length > 0) {
		return {
			admitted: false,
			reason: await recordBudgetStop(kit, stage, checkpoint, `observed spend is unpriceable — ${usage.unpriced.join("; ")}`),
		};
	}
	if (spent >= ceiling) {
		return {
			admitted: false,
			reason: await recordBudgetStop(kit, stage, checkpoint, `session spend $${spent.toFixed(4)} is at or above the ceiling $${ceiling.toFixed(4)} — no further paid submissions`),
		};
	}
	return { admitted: true, spentUsd: spent };
}

/**
 * Record the committed stop: a governor row naming the stage, the alert, and
 * the status message. Returns the reason for the caller's refusal text.
 */
export async function recordBudgetStop(
	kit: LoopAndLock,
	stage: SubmissionStage,
	checkpoint: AdmissionCheckpoint,
	reason: string,
): Promise<string> {
	const message = `budget pause at ${stage}: ${reason} — raise budgets.sessionUsd in .orch/config.toml (or price the roles) and rerun to resume`;
	await commitState(kit, {
		runStatus: (d) => {
			d.activeAlert = message.slice(0, 300);
		},
		rows: [{
			ts: Date.now(),
			kind: "governor",
			task: checkpoint.taskId ?? "session",
			...(checkpoint.wave !== undefined ? { wave: checkpoint.wave } : {}),
			verb: "budget-stop",
			reason: stage,
			detail: reason,
			...(checkpoint.planRevision !== undefined ? { planRevision: checkpoint.planRevision } : {}),
		}],
		statusPhase: { phase: "idle", message },
	});
	return reason;
}

/**
 * Refresh the guard snapshot from fresh session usage WITHOUT refusing —
 * used at run boundaries (loop top, sleep wake) so the transport guard sees
 * current numbers even between admissions. Returns the fresh account.
 */
export async function refreshAdmissionHighWater(kit: LoopAndLock): Promise<{ spentUsd: number; unpriced: string[] }> {
	const [usage, sessionState] = await Promise.all([
		kit.loop.sessionUsage(),
		readSessionState(kit.loop.harness),
	]);
	const spent = Math.max(usage.totalUsd, sessionState.runStatus.budgetSpentUsd);
	syncGuardState(kit.loop.budgetGuard, kit.loop.config.budgets.sessionUsd, spent, usage.unpriced);
	return { spentUsd: spent, unpriced: usage.unpriced };
}

/** Build a UsagePricer from config rates plus the session's Models catalog. */
export function usagePricerFor(
	configRatesFor: (key: string) => CostRates | undefined,
	catalogRatesFor: (key: string) => CatalogClassRates | undefined,
): UsagePricer {
	return (key, usage) => {
		const slash = key.indexOf("/");
		const providerId = slash > 0 ? key.slice(0, slash) : key;
		return priceUsage(usage, {
			providerId,
			configRates: configRatesFor(key),
			catalogRates: catalogRatesFor(key),
		});
	};
}

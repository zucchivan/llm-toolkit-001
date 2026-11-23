/**
 * Serial wave driver (§4.2): selection remains grant/dependency driven while
 * each implementation runs in an owned private lease and settles on one frozen
 * candidate. Receipts and stage checkpoints gate acceptance, integration,
 * workspace recovery, and publication; the operator checkout is never a wave
 * input or restore target.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, atomicWriteJson, readJson } from "../util/fsx.ts";
import { BACKGROUND_CONTEXT } from "./kit.ts";
import type { Conversation } from "./kit.ts";
import { ConversationKit } from "./conversations.ts";
import type { LoopAndLock } from "./harness.ts";
import {
	commitState, readSessionState, grantRefusal, readGrant, approvalMirrorRefusal, resolveGrantSelection,
} from "./state.ts";
import type { Grant, SessionState } from "./state.ts";
import type { RouterTask, RunStatusDocValue, WaveRow, TaskFeedback } from "./infos.ts";
import { recipeBundleFromTree, runGates } from "./gates.ts";
import type { GateOutcome, GateResult } from "./gates.ts";
import { renderRouterMd } from "./infos.ts";
import { runVerify, gateSummaryText } from "./verifier.ts";
import type { VerifyResult } from "./verifier.ts";
import { gateCheckFromResult, gateReceiptEvent, latestCheckpoint, latestCheckpointForWave, receiptStatesForWave, ReceiptsDoc } from "./receipts.ts";
import type { Checkpoint, CheckpointStage, GateCheck, GateReceipt, ReceiptEvent, ReceiptsDocValue, WaveKey } from "./receipts.ts";
import {
	assessFailureTriage, persistFailureTriageAssessment, type FailureTriageEvidence,
} from "./failure-triage.ts";
import { armRateLimitSleep, looksLikeRateLimit, parseResetDelay, waitOutSleep } from "./governor.ts";
import { diffDisplayTrees } from "../util/git.ts";
import { readCommit, readRef, resolveTree } from "../util/git-objects.ts";
import { hostExecArgv } from "./recipe-runner.ts";
import { createTaskControls } from "./controls.ts";
import {
	acceptCandidate, discardCandidateWorkspace, integrateAcceptedCandidate, preflightPullRequest,
	publishLocalResult, publishPullRequest, RecoveryRequiredError,
} from "./delivery.ts";
import type { PrPublicationOptions } from "./delivery.ts";
import type { ProgressEvent } from "./driver-events.ts";
import type { JudgmentClient } from "../judgment/types.ts";
import {
	createTaskExecutionContext, discard as discardWorkspace, fenceWorkspace, freeze, materializeRead, openTask,
	resumeTask, diffTaskTrees,
} from "./workspace.ts";
import type { FencedWorkspace, ReadWorkspace, TaskExecutionContext, TaskWorkspaceLease } from "./workspace.ts";
import type { FrozenCheckpointView } from "./receipts.ts";

export class DriverStateError extends Error {}

const IMPLEMENTER_BRIEF = `You are the implementer of an implementation-loop kit. One wave = one task. Edit real files with the write/edit tools and bash.

Discipline:
- work ONLY inside the task's targetPaths (the harness enforces this).
- implement the SPEC; run the gate commands yourself when it helps (lint/typecheck/test live in evals/recipes.toml form).
- do not touch .orch/**, evals/**, router.md, PROMPT.md — the harness blocks them.
- do not run interactive commands; keep the working tree compilable.
- END the wave by printing exactly one status line: STATUS: COMPLETE when the task is done and every criterion is satisfied, or STATUS: BLOCKED with one line saying what blocks you.`;

// ---------------------------------------------------------------------------
// Task selection (topological, priority, id tie-break)
// ---------------------------------------------------------------------------

export function pickNextTask(tasks: readonly RouterTask[]): RouterTask | undefined {
	return pickNextTaskInSelection(tasks, tasks.map((t) => t.id));
}

/**
 * Candidate selection INSIDE a grant (M0-P05): candidates come only from the
 * granted ids, while dependency satisfaction is looked up against ALL plan
 * tasks (a dependency done outside the grant counts as satisfied; a selected
 * task's unsatisfied dependency outside the selection was already refused at
 * approval). Priority then id breaks ties.
 */
export function pickNextTaskInSelection(tasks: readonly RouterTask[], selected: readonly string[]): RouterTask | undefined {
	const selectedSet = new Set(selected);
	const doneOrGone = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
	// UI seam A.1: waves set their task in_progress while running (and reset it at
	// every wave end), so a run killed mid-wave leaves exactly one in_progress
	// task behind. Resuming it is durability as before — the grant's run picks it
	// up; omitting in_progress here would turn every crashed wave into a dead end.
	const candidates = tasks.filter(
		(t) => selectedSet.has(t.id) && (t.status === "todo" || t.status === "in_progress") && t.dependsOn.every((d) => doneOrGone.has(d)),
	);
	if (candidates.length === 0) return undefined;
	candidates.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
	return candidates[0];
}

export function pickNextTaskForOrder(tasks: readonly RouterTask[]): RouterTask | undefined {
	return pickNextTask(tasks);
}

/** Snapshot of one grant's position in the plan (selection facts, M0-P05). */
export interface SelectionFacts {
	/** Granted tasks still owed work (todo or in_progress). */
	outstanding: RouterTask[];
	/** Granted tasks that ended quarantined. */
	quarantined: string[];
	/** Plan task ids not done (inside or outside the grant). */
	remainingPlanIds: string[];
	/** True iff EVERY plan task is done (whole-plan fulfillment). */
	allDone: boolean;
}

export function selectionFacts(tasks: readonly RouterTask[], selected: readonly string[]): SelectionFacts {
	const selectedSet = new Set(selected);
	const selectedTasks = tasks.filter((t) => selectedSet.has(t.id));
	return {
		outstanding: selectedTasks.filter((t) => t.status === "todo" || t.status === "in_progress"),
		quarantined: selectedTasks.filter((t) => t.status === "quarantined").map((t) => t.id),
		remainingPlanIds: tasks.filter((t) => t.status !== "done").map((t) => t.id),
		allDone: tasks.length > 0 && tasks.every((t) => t.status === "done"),
	};
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export type DriverFaultPoint =
	| "after-implementer-submit" | "after-freeze" | "after-gates"
	| "after-primary" | "after-skeptic" | "after-review-before-delivery"
	| "after-acceptance" | "after-integration" | "before-publication" | "after-publication"
	| "after-workspace-discard";

export interface RunOptions {
	/** A NEW grant (the review point): approve exactly this plan revision —
	 *  the CLI's `run --approve --revision <uuid>`. Validation (revision,
	 *  subset, mirror) happens in `approveGrant` before any dispatch.
	 *  Absent approve = bare resume of the stored grant. */
	approve?: { planRevision: string };
	/** The `--tasks` ids, repeated once per id. With `approve`: the granted
	 *  subset (absent/empty = every plan id, stored explicitly — the full list
	 *  is not a wildcard). Without `approve`: an explicit set that must EQUAL
	 *  the stored grant (a bare resume inherits it unchanged). */
	tasksFilter?: string[];
	deliverExplicit?: boolean;
	/** Optional Jev injection for tests/embedders; disabled unless explicitly configured. */
	judgmentClient?: JudgmentClient;
	/** Narrow fake transport/host seams for offline PR-publication tests. */
	prPublication?: Omit<PrPublicationOptions, "deliverExplicit">;
	/** Deterministic crash injection for interrupted-stage tests only. */
	driverFaultInjector?: (point: DriverFaultPoint) => void | Promise<void>;
}

/**
 * §3 transition-5 exits: `plan-complete`/`selection-complete` are the two
 * distinct fulfillment strings (both exit 0); `blocked`, `recovery-required`,
 * and `budget` are policy stops (exit 2); `sleeping` is the rate-limit wait
 * (exit 42). Hard errors throw (exit 1); SIGINT is the CLI's 130.
 */
export type DriverExit = "plan-complete" | "selection-complete" | "blocked" | "recovery-required" | "budget" | "sleeping";

export interface RunSummaryInfo {
	exit: DriverExit;
	ranWaves: number[];
	/** True iff EVERY plan task is done (whole-plan fulfillment — the only
	 *  thing that flips the router phase to complete). A satisfied subset is
	 *  selection-complete with complete=false. */
	complete: boolean;
	/** The exact grant this run executed (ADR 01). */
	grant: Grant;
	/** Plan task ids not done when the run ended. */
	remainingPlanIds: string[];
	/** Granted task ids that ended quarantined at the stop. */
	quarantined: string[];
	/** Granted task ids the run stopped on (quarantined, dependency-blocked,
	 *  or awaiting reconciliation). */
	blockedIds: string[];
	alert?: string;
}

/** A new grant cannot bypass an unresolved P14 stage/effect checkpoint. */
async function activeCheckpointConflict(kit: LoopAndLock, state: SessionState): Promise<string | undefined> {
	const revision = state.router.identity?.planRevision;
	if (!revision) return undefined;
	const receipts = await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
	if (!receipts) return undefined;
	const latestByWave = new Map<string, Checkpoint>();
	for (const event of receipts.events) {
		if (event.kind !== "checkpoint" || event.value.planRevision !== revision) continue;
		latestByWave.set(`${event.value.taskId}/${event.value.wave}`, event.value);
	}
	for (const checkpoint of latestByWave.values()) {
		if (checkpoint.stage === "terminal" && checkpoint.state === "complete") continue;
		return `task ${checkpoint.taskId} wave ${checkpoint.wave} has an unresolved ${checkpoint.stage} checkpoint (${checkpoint.state}) — resume or reconcile it before changing the grant`;
	}
	return undefined;
}

export interface ApprovalRequest {
	/** The plan revision being approved (the CLI's --revision). */
	planRevision: string;
	/** Explicit subset (repeated --tasks); absent or empty = every plan id. */
	tasks?: string[];
}

/**
 * ADR 01's approval act — the ONLY path that mints a grant. Validates the
 * request against the durable state and the canonical router.md mirror
 * under the host lock, then persists the grant `{planRevision, selected,
 * humanApprovedAt}` + the phase flip + the review row in ONE state commit.
 * The CLI's `run --approve --revision`, the in-process driver and the test
 * fixtures all go through it, so no stamp can exist without a
 * revision-qualified, mirror-matched human review.
 */
export async function approveGrant(kit: LoopAndLock, request: ApprovalRequest): Promise<Grant> {
	const state = await readSessionState(kit.loop.harness);
	if (!state.router.tasks.length) throw new DriverStateError("no tasks — run `plan` first (or migrate a router.md)");
	const refusal = grantRefusal(state, { approve: { planRevision: request.planRevision, tasks: request.tasks } });
	if (refusal) throw new DriverStateError(refusal);
	const checkpointConflict = await activeCheckpointConflict(kit, state);
	if (checkpointConflict) throw new DriverStateError(checkpointConflict);
	// The grant binds the human to what they reviewed: the mirror must exist
	// and match the canonical durable render (edited/missing → replan).
	const mirrorRefusal = await approvalMirrorRefusal(kit, state);
	if (mirrorRefusal) throw new DriverStateError(mirrorRefusal);
	const selected = resolveGrantSelection(state, request.tasks);
	const at = Date.now();
	await commitState(kit, {
		router: (d) => {
			if (d.phase === "planned") d.phase = "running";
		},
		runStatus: (d) => {
			d.approvedPlanRevision = request.planRevision;
			d.approvedSelected = selected;
			d.humanApprovedAt = at;
		},
		rows: [{
			ts: at,
			kind: "wave",
			task: "session",
			verb: "approved",
			detail: `plan revision ${request.planRevision} — grant: ${selected.join(", ")}`,
		}],
		statusPhase: { phase: "idle", message: `plan revision ${request.planRevision} approved — grant: ${selected.join(", ")}` },
	});
	return { planRevision: request.planRevision, selected, humanApprovedAt: at };
}

/** The committed stop-short row: the paper trail names the policy stop. */
function stoppedRow(detail: string): WaveRow {
	return { ts: Date.now(), kind: "wave", task: "session", verb: "stopped", detail };
}

function stopShortStatus(facts: SelectionFacts): { phase: "idle"; message: string } {
	return { phase: "idle", message: `stopped short — ${facts.quarantined.length} task(s) quarantined: ${facts.quarantined.join(", ")}` };
}

export async function runWaves(
	kit: LoopAndLock,
	options: RunOptions,
	onProgress?: (event: ProgressEvent) => void,
): Promise<RunSummaryInfo> {
	const emit = (event: ProgressEvent) => onProgress?.(event);
	const initial = await readSessionState(kit.loop.harness);

	// Grant admission (M0-P05, ADR 01) — BEFORE any handoff ingestion, sleep
	// wait, budget read or wave: no tool/model dispatch happens on an
	// unvalidated grant, and a refusal never mutates state.
	if (!initial.router.tasks.length) throw new DriverStateError("no tasks — run `plan` first (or migrate a router.md)");
	// PR consent and destination authority are preflighted before approving a grant
	// or dispatching a model; delivery cannot become a surprise after review.
	if (kit.loop.config.delivery.mode === "pr" && initial.router.tasks.some((task) => task.status === "todo" || task.status === "in_progress")) {
		try {
			await preflightPullRequest(kit, {
				deliverExplicit: options.deliverExplicit === true,
				...(options.prPublication?.profilePath ? { profilePath: options.prPublication.profilePath } : {}),
			});
		} catch (error) {
			throw new DriverStateError((error as Error).message);
		}
	}
	// An empty tasksFilter means "no explicit set" (never an empty grant).
	const explicitTasks = options.tasksFilter?.length ? options.tasksFilter : undefined;
	let grant: Grant;
	if (options.approve) {
		grant = await approveGrant(kit, { planRevision: options.approve.planRevision, tasks: explicitTasks });
	} else {
		const refusal = grantRefusal(initial, { tasks: explicitTasks });
		if (refusal) throw new DriverStateError(refusal);
		grant = readGrant(initial.runStatus)!; // grantRefusal refuses an incomplete grant
	}

	// Ingest a queued user handoff note (§3.1) before the next wave starts.
	// The CLI writes {ts, notes: string[]} (multi-note queue); read both shapes.
	const handoffRaw = await readJson<{ ts: number; notes: string[]; note?: string }>(kit.loop.paths.pendingHandoff);
	const handoff = handoffRaw
		? { note: (handoffRaw.notes?.length ? handoffRaw.notes.join("; ") : (handoffRaw.note ?? "")).slice(0, 3000), ts: handoffRaw.ts }
		: undefined;
	if (handoff?.note) {
		await commitState(kit, {
			rows: [{ ts: Date.now(), kind: "handoff", task: "session", verb: "handoff-ingested", detail: handoff.note }],
		});
		await import("node:fs/promises").then((fs) => fs.rm(kit.loop.paths.pendingHandoff, { force: true }));
	}

	// Resume a live rate-limit sleep from a previous run, if any.
	await recomputeSpent(kit);
	const slept = await waitOutSleep(kit);
	if (slept) await recomputeSpent(kit);

	const summary: RunSummaryInfo = {
		exit: "plan-complete",
		ranWaves: [],
		complete: false,
		grant,
		remainingPlanIds: [],
		quarantined: [],
		blockedIds: [],
	};

	for (;;) {
		// Latest state before every selection (§3 transition 5); the selection
		// facts are recomputed against the durable doc, never a stale array.
		const stateNow = await readSessionState(kit.loop.harness);
		const facts = selectionFacts(stateNow.router.tasks, grant.selected);
		summary.quarantined = facts.quarantined;
		summary.remainingPlanIds = facts.remainingPlanIds;

		if (facts.outstanding.length === 0) {
			if (facts.allDone) {
				// Whole-plan fulfillment: the ONLY thing that flips the router phase
				// to complete — recorded once (a re-run on a complete plan writes
				// nothing and does no additional work).
				if (stateNow.router.phase !== "complete") {
					await commitState(kit, {
						router: (d) => {
							d.phase = "complete";
						},
						statusPhase: { phase: "idle", message: "complete — every task in the plan is done" },
						rows: [{ ts: Date.now(), kind: "wave", task: "session", verb: "complete", detail: "whole plan fulfilled: every task done" }],
					});
				}
				summary.exit = "plan-complete";
				summary.complete = true;
				emit({ kind: "complete", message: "STATUS: COMPLETE — every task in the plan is done" });
				break;
			}
			if (facts.quarantined.length) {
				// A quarantined member stops the selection: policy stop with ids,
				// never 0/complete (also the reopen path after an earlier stop).
				summary.exit = "blocked";
				summary.blockedIds = facts.quarantined;
				emit({ kind: "quarantine-stop", quarantined: facts.quarantined, message: `selection stopped short: ${facts.quarantined.length} task(s) quarantined: ${facts.quarantined.join(", ")}` });
				await commitState(kit, { statusPhase: stopShortStatus(facts), rows: [stoppedRow(`quarantined: ${facts.quarantined.join(", ")}`)] });
				break;
			}
			// The granted subset is fulfilled while the plan still has work
			// OUTSIDE the grant: selection success, phase stays open.
			summary.exit = "selection-complete";
			emit({
				kind: "selection-complete",
				selected: grant.selected,
				remainingPlanIds: facts.remainingPlanIds,
				message: `selection complete — the granted task(s) are fulfilled; ${facts.remainingPlanIds.length} plan task(s) remain outside the grant`,
			});
			break;
		}

		// Budget ceiling first (§4.5): stop the loop before starting another wave.
		const spent = await recomputeSpent(kit);
		if (process.env["KIT_DEBUG"]) console.error(`[kit-debug] budget spent=$${spent.toFixed(6)} ceiling=$${kit.loop.config.budgets.sessionUsd}`);
		if (spent > kit.loop.config.budgets.sessionUsd) {
			summary.exit = "budget";
			emit({ kind: "budget-stop", message: `budget reached at $${spent.toFixed(2)} of $${kit.loop.config.budgets.sessionUsd} — resume with \`run\`` });
			await commitState(kit, {
				rows: [{ ts: Date.now(), kind: "governor", task: "session", verb: "budget-stop", detail: `spent $${spent.toFixed(2)}` }],
				statusPhase: { phase: "idle", message: "budget ceiling" },
			});
			break;
		}

		const task = pickNextTaskInSelection(stateNow.router.tasks, grant.selected);
		if (!task) {
			// Outstanding granted tasks are blocked: their dependencies ended
			// quarantined (this run or a previous one). Policy stop with ids.
			summary.exit = "blocked";
			summary.blockedIds = [...new Set([...facts.quarantined, ...facts.outstanding.map((t) => t.id)])];
			emit({ kind: "blocked", message: `remaining granted tasks are blocked by quarantined dependencies — no runnable task (blocked: ${summary.blockedIds.join(", ")})`, blockedIds: summary.blockedIds });
			await commitState(kit, {
				statusPhase: { phase: "idle", message: `blocked by quarantined dependencies: ${summary.blockedIds.join(", ")}` },
				rows: [stoppedRow(`blocked by quarantined dependencies: ${summary.blockedIds.join(", ")}`)],
			});
			break;
		}

		// ---- Per-task wave loop
		let outcome: DriverExit | "done" | "quarantined" | "recovery-required";
		try {
			outcome = await driveTaskWaves(kit, task, {
				handoffNote: handoff?.note,
				onEvent: emit,
				deliverExplicit: options.deliverExplicit,
				judgmentClient: options.judgmentClient,
				grant,
				prPublication: options.prPublication,
				driverFaultInjector: options.driverFaultInjector,
			});
		} catch (error) {
			if (!(error instanceof RecoveryRequiredError)) throw error;
			if (process.env["KIT_DEBUG"]) console.error(`[kit-debug] recovery required: ${(error as Error).message}`);
			const latest = await readSessionState(kit.loop.harness);
			const stopped = selectionFacts(latest.router.tasks, grant.selected);
			summary.remainingPlanIds = stopped.remainingPlanIds;
			summary.quarantined = stopped.quarantined;
			summary.exit = "recovery-required";
			summary.blockedIds = [task.id];
			const message = `recovery required for ${task.id}: ${error.message}`;
			await commitState(kit, { statusPhase: { phase: "idle", message } });
			emit({ kind: "recovery-required", taskId: task.id, message });
			break;
		}
		if (outcome === "sleeping") {
			summary.exit = "sleeping";
			break;
		}
		if (outcome === "budget") {
			summary.exit = "budget";
			break;
		}
		if (outcome === "quarantined") {
			// §3 transition 5: stop the selection on its first quarantine — a
			// policy stop with ids, never a drained-queue success.
			const stopped = await readSessionState(kit.loop.harness);
			const stopFacts = selectionFacts(stopped.router.tasks, grant.selected);
			summary.quarantined = stopFacts.quarantined;
			summary.remainingPlanIds = stopFacts.remainingPlanIds;
			summary.exit = "blocked";
			summary.blockedIds = [...new Set([task.id, ...stopFacts.quarantined])];
			emit({ kind: "quarantine-stop", quarantined: stopFacts.quarantined, message: `selection stopped short: ${task.id} quarantined` });
			await commitState(kit, { statusPhase: stopShortStatus(stopFacts), rows: [stoppedRow(`selection stopped on quarantined: ${stopFacts.quarantined.join(", ")}`)] });
			break;
		}
		const settledTask = (await readSessionState(kit.loop.harness)).router.tasks.find((entry) => entry.id === task.id);
		summary.ranWaves.push(settledTask?.waveCount ?? task.waveCount);
	}
	return summary;
}

async function recomputeSpent(kit: LoopAndLock): Promise<number> {
	const usage = await kit.loop.sessionUsage();
	const state = await readSessionState(kit.loop.harness);
	// spend = max(session usage estimate, last recorded accumulator) — usage is
	// cumulative per storage; the accumulator adds throttled deltas.
	return Math.max(usage.totalUsd, state.runStatus.budgetSpentUsd + usage.totalUsd - state.runStatus.budgetSpentUsd);
}

// ---------------------------------------------------------------------------
// Task wave loop (waves 1..retryLimit, gates, verifier, quarantine)
// ---------------------------------------------------------------------------

export interface TaskWavesOptions {
	handoffNote?: string;
	onEvent?: (e: ProgressEvent) => void;
	deliverExplicit?: boolean;
	judgmentClient?: JudgmentClient;
	grant: Grant;
	prPublication?: Omit<PrPublicationOptions, "deliverExplicit">;
	driverFaultInjector?: (point: DriverFaultPoint) => void | Promise<void>;
}

export interface TaskWavesResult {
	outcome: "done" | "quarantined" | "sleeping" | "budget" | "recovery-required";
}

function acceptedRef(planRevision: string): string {
	return `refs/kit/${planRevision}/accepted`;
}

function latestTaskCheckpoint(doc: ReceiptsDocValue, planRevision: string, taskId: string): Checkpoint | undefined {
	return doc.events.filter((event): event is Extract<ReceiptEvent, { kind: "checkpoint" }> => event.kind === "checkpoint"
		&& event.value.planRevision === planRevision && event.value.taskId === taskId)
		.at(-1)?.value;
}

function gateReceiptForWave(doc: ReceiptsDocValue, wave: WaveKey): Extract<ReceiptEvent, { kind: "gate" }> | undefined {
	return doc.events.filter((event): event is Extract<ReceiptEvent, { kind: "gate" }> =>
		event.kind === "gate" && event.value.planRevision === wave.planRevision
			&& event.value.taskId === wave.taskId && event.value.wave === wave.wave,
	).at(-1);
}

function passReceiptForWave(
	doc: ReceiptsDocValue,
	wave: WaveKey,
	pass: "primary" | "skeptic",
	tree: string,
	gateId: string,
): Extract<ReceiptEvent, { kind: "pass" }> | undefined {
	return doc.events.filter((event): event is Extract<ReceiptEvent, { kind: "pass" }> =>
		event.kind === "pass" && event.value.planRevision === wave.planRevision
			&& event.value.taskId === wave.taskId && event.value.wave === wave.wave
			&& event.value.tree === tree && event.value.gateId === gateId && event.value.review.pass === pass,
	).at(-1);
}

function checkpointValue(
	wave: WaveKey,
	stage: CheckpointStage,
	state: Checkpoint["state"],
	input: {
		parent: string;
		startTree: string;
		candidate?: string;
		conversationId?: number;
		submissionKey?: string;
		leaseId?: string;
		grantedFeedbackIds: string[];
		outcome?: Checkpoint["outcome"];
		code?: string;
	},
): Checkpoint {
	return {
		...wave,
		stage,
		state,
		parent: input.parent,
		startTree: input.startTree,
		grantedFeedbackIds: [...input.grantedFeedbackIds],
		...(input.candidate !== undefined ? { candidate: input.candidate } : {}),
		...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
		...(input.submissionKey !== undefined ? { submissionKey: input.submissionKey } : {}),
		...(input.leaseId !== undefined ? { leaseId: input.leaseId } : {}),
		...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
		...(input.code !== undefined ? { code: input.code } : {}),
	};
}

function submissionKey(wave: WaveKey, stage: "implement" | "primary" | "skeptic"): string {
	return `kit:${wave.planRevision}:${wave.taskId}:w${wave.wave}:${stage}`;
}

function checkpointView(wave: number, startTree: string, candidate: string): FrozenCheckpointView {
	return { wave, baseTree: startTree, candidateTree: candidate, asOf: Date.now() };
}

function receiptSnapshot(kit: LoopAndLock): Promise<ReceiptsDocValue> {
	return kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT).then((doc) => doc ?? { version: 1, events: [] });
}

function gateOutcomeFromReceipt(receipt: GateReceipt): GateOutcome {
	const results: GateResult[] = receipt.checks.map((check) => ({
		name: check.id,
		...(check.outcome === "skip" ? { skipped: "recorded skip" } : {}),
		passed: check.outcome === "pass" || check.outcome === "skip",
		exit: check.exit,
		tail: "",
		matched: check.outcome === "pass" || check.outcome === "skip",
		durationMs: check.ms,
		...(check.outcome === "error" ? { reason: "[error] gate outcome was recorded before interruption" } : {}),
	}));
	const failed = receipt.checks.filter((check) => check.outcome === "fail" || check.outcome === "error");
	const scope = receipt.checks.find((check) => check.kind === "scope");
	return {
		allPassed: failed.length === 0,
		scopeOK: scope?.outcome === "pass",
		scopeBody: "",
		results,
		feedbackText: failed.length ? `GATES FAILED: ${failed.map((check) => check.id).join(", ")}\nFix the named failure; stay within the task's targetPaths.` : "",
		failHash: receipt.failureHash,
		logFile: "",
	};
}

async function driverFault(options: TaskWavesOptions, point: DriverFaultPoint): Promise<void> {
	await options.driverFaultInjector?.(point);
}

function feedbackIdentity(task: RouterTask): string[] {
	return task.feedback.map((feedback) => `${feedback.wave}:${feedback.from}:${feedback.ts}`);
}

async function writeCandidateArtifacts(
	kit: LoopAndLock,
	wave: WaveKey,
	startTree: string,
	candidateTree: string,
): Promise<void> {
	const prefix = `candidate-${wave.planRevision}-${wave.taskId}-w${wave.wave}`;
	try {
		const display = await diffDisplayTrees(kit.loop.paths.root, startTree, candidateTree);
		if (!display.ok || display.stats.files.length === 0) return;
		await mkdir(kit.loop.paths.artifacts, { recursive: true });
		await atomicWrite(join(kit.loop.paths.artifacts, `${prefix}.patch`), display.text);
		await atomicWriteJson(join(kit.loop.paths.artifacts, `${prefix}.json`), {
			task: wave.taskId,
			planRevision: wave.planRevision,
			wave: wave.wave,
			baselineTreeSha: startTree,
			candidateTreeSha: candidateTree,
			generatedAt: Date.now(),
			files: display.stats.files,
			totalInsertions: display.stats.totalInsertions,
			totalDeletions: display.stats.totalDeletions,
			bytes: display.bytes,
			truncated: display.truncated,
		});
	} catch {
		/* Display evidence is best-effort; the frozen tree and receipts are authoritative. */
	}
}

async function finishFailedCandidate(input: {
	kit: LoopAndLock;
	task: RouterTask;
	wave: WaveKey;
	parent: string;
	startTree: string;
	candidate: string;
	fencedWorkspace: FencedWorkspace;
	feedbackIds: string[];
	outcome: "retry" | "quarantined";
	cause: string;
	feedback?: TaskFeedback;
	rows?: WaveRow[];
	opts: TaskWavesOptions;
}): Promise<"retry" | "quarantined"> {
	const { kit, task, wave, parent, startTree, candidate, fencedWorkspace, feedbackIds, outcome, cause, opts } = input;
	const checkpoint = await latestCheckpointForWave(await receiptSnapshot(kit), wave);
	if (checkpoint?.value.stage !== "rollback" || checkpoint.value.state !== "pending" || checkpoint.value.outcome !== outcome) {
		await commitState(kit, {
			checkpoints: [checkpointValue(wave, "rollback", "pending", {
				parent, startTree, candidate, leaseId: fencedWorkspace.lease.id,
				grantedFeedbackIds: feedbackIds, outcome,
			})],
		});
	}
	try {
		const acceptedHead = await readRef(kit.loop.paths.root, acceptedRef(wave.planRevision));
		if (acceptedHead !== undefined && acceptedHead !== parent) {
			throw new RecoveryRequiredError(`rollback integration head moved from ${parent} to ${acceptedHead}`);
		}
		await discardCandidateWorkspace(kit, {
			...wave,
			fencedWorkspace,
			baseTree: startTree,
			producedTree: candidate,
			expectedIntegrationCommit: acceptedHead ?? null,
		}, opts.prPublication ?? {});
	} catch (error) {
		await commitState(kit, {
			checkpoints: [checkpointValue(wave, "rollback", "unknown", {
				parent, startTree, candidate, leaseId: fencedWorkspace.lease.id,
				grantedFeedbackIds: feedbackIds, outcome, code: "workspace-disposal-uncertain",
			})],
			statusPhase: { phase: "idle", message: `recovery required: workspace disposal for ${task.id} wave ${wave.wave}` },
		});
		throw error instanceof RecoveryRequiredError
			? error
			: new RecoveryRequiredError(`workspace disposal for ${task.id} wave ${wave.wave} is uncertain: ${(error as Error).message}`);
	}
	await driverFault(opts, "after-workspace-discard");
	const receipts = await receiptSnapshot(kit);
	const receiptStates = receiptStatesForWave(receipts, wave);
	const at = Date.now();
	const rows: WaveRow[] = [
		...(input.rows ?? []),
		...(outcome === "quarantined" ? [{
			ts: at,
			kind: "task" as const,
			task: task.id,
			wave: wave.wave,
			verb: "quarantined",
			reason: cause,
			detail: `frozen candidate retained: ${candidate}`,
			planRevision: wave.planRevision,
			receiptStates,
			checkpoint: checkpointView(wave.wave, startTree, candidate),
		}] : []),
		waveEndRow(task.id, wave.wave, `${outcome}: ${cause}`, candidate, {
			planRevision: wave.planRevision,
			receiptStates,
			checkpoint: checkpointView(wave.wave, startTree, candidate),
		}),
	];
	await commitState(kit, {
		router: (draft) => {
			const current = draft.tasks.find((entry) => entry.id === task.id)!;
			current.waveCount = Math.max(current.waveCount, wave.wave);
			current.status = outcome === "retry" ? "todo" : "quarantined";
			if (input.feedback && !current.feedback.some((entry) => entry.wave === wave.wave && entry.from === input.feedback!.from)) {
				current.feedback.push(input.feedback);
			}
			if (outcome === "quarantined" && !current.feedback.some((entry) => entry.wave === wave.wave && entry.text === `quarantined: ${cause}`)) {
				current.feedback.push({ wave: wave.wave, from: "gate", text: `quarantined: ${cause}`, ts: at } satisfies TaskFeedback);
			}
		},
		checkpoints: [
			checkpointValue(wave, "rollback", "complete", {
				parent, startTree, candidate, leaseId: fencedWorkspace.lease.id,
				grantedFeedbackIds: feedbackIds, outcome: "discarded",
			}),
			checkpointValue(wave, "terminal", "complete", {
				parent, startTree, candidate, leaseId: fencedWorkspace.lease.id,
				grantedFeedbackIds: feedbackIds, outcome,
			}),
		],
		rows,
		statusPhase: { phase: "idle", message: `${task.id} wave ${wave.wave} ${outcome}: ${cause}` },
	});
	if (outcome === "quarantined") emitQuarantine(opts, task.id, wave.wave, cause);
	return outcome;
}

function emitQuarantine(opts: TaskWavesOptions, taskId: string, wave: number, cause: string): void {
	opts.onEvent?.({ kind: "task-quarantined", taskId, wave, message: cause });
}

export async function driveTaskWaves(
	kit: LoopAndLock,
	task: RouterTask,
	opts: TaskWavesOptions,
): Promise<DriverExit | "done" | "quarantined"> {
	const root = kit.loop.paths.root;
	const emit = (event: ProgressEvent) => opts.onEvent?.(event);
	const convKit = new ConversationKit(kit, kit.loop.toolBox);

	for (;;) {
		const state = await readSessionState(kit.loop.harness);
		const current = state.router.tasks.find((entry) => entry.id === task.id);
		if (!current) throw new DriverStateError(`task ${task.id} vanished from the router doc`);
		if (current.status === "done") return "done";
		if (current.status === "quarantined") return "quarantined";
		const identity = state.router.identity;
		if (!identity || identity.planRevision !== opts.grant.planRevision) {
			throw new DriverStateError("task execution requires the current reviewed plan revision");
		}
		if (!identity.baseCommit) throw new DriverStateError("task execution requires a reviewed base commit; create the project seed commit and replan first");

		const receipts = await receiptSnapshot(kit);
		const previousCheckpoint = latestTaskCheckpoint(receipts, identity.planRevision, current.id);
		const active = previousCheckpoint && !(previousCheckpoint.stage === "terminal" && previousCheckpoint.state === "complete")
			? previousCheckpoint
			: undefined;
		if (active?.stage === "terminal") throw new RecoveryRequiredError(`task ${task.id} has a nonterminal terminal checkpoint`);
		if (active?.state === "unknown" && active.stage !== "rollback") {
			throw new RecoveryRequiredError(`task ${task.id} wave ${active.wave} has an unknown ${active.stage} checkpoint`);
		}
		if (current.status === "in_progress" && !active) {
			throw new RecoveryRequiredError(`task ${task.id} is in progress without a P14 checkpoint; refusing to replay legacy work`);
		}
		if (!active && current.waveCount > 0
			&& !(previousCheckpoint?.stage === "terminal" && previousCheckpoint.outcome === "retry")) {
			throw new RecoveryRequiredError(`task ${task.id} has legacy wave history without a terminal P14 checkpoint; replan or reconcile it before replay`);
		}

		const wave = active?.wave ?? current.waveCount + 1;
		const waveKey: WaveKey = { planRevision: identity.planRevision, taskId: current.id, wave };
		const parent = active?.parent ?? (await readRef(root, acceptedRef(identity.planRevision))) ?? identity.baseCommit;
		await readCommit(root, parent);
		let startTree = active?.startTree;
		if (!startTree) {
			if (previousCheckpoint?.stage === "terminal" && previousCheckpoint.outcome === "retry" && previousCheckpoint.candidate) {
				startTree = previousCheckpoint.candidate;
			} else {
				startTree = await resolveTree(root, parent);
			}
		}
		startTree = await resolveTree(root, startTree);
		const baseForTask = current.baselineTreeSha ?? await resolveTree(root, parent);
		const controls = createTaskControls({ root, targetPaths: current.targetPaths });
		let lease: TaskWorkspaceLease;
		try {
			if (active) {
				if (!active.leaseId) throw new Error("active checkpoint is missing its owned workspace identity");
				lease = await resumeTask({ root, oid: startTree }, identity, current.id, active.leaseId, { scopeBaseOid: parent });
			} else {
				lease = await openTask({ root, oid: startTree }, identity, current.id, { scopeBaseOid: parent });
			}
		} catch (error) {
			throw new RecoveryRequiredError(`cannot reattach task ${task.id} wave ${wave} workspace: ${(error as Error).message}`);
		}
		if (active?.candidate && lease.frozenCandidateTree !== active.candidate) {
			throw new RecoveryRequiredError(`candidate pin for ${task.id} wave ${wave} does not match its durable checkpoint`);
		}
		let candidate = active?.candidate ?? lease.frozenCandidateTree;
		let fencedWorkspace: FencedWorkspace | undefined = candidate ? fenceWorkspace(lease, controls) : undefined;
		const feedbackIds = feedbackIdentity(current);
		const bundle = await recipeBundleFromTree(root, startTree);
		const stageCheckpoint = (stage: CheckpointStage, checkpointState: Checkpoint["state"], values: {
			candidate?: string;
			conversationId?: number;
			submissionKey?: string;
			outcome?: Checkpoint["outcome"];
			code?: string;
		} = {}) => checkpointValue(waveKey, stage, checkpointState, {
			parent,
			startTree,
			candidate: values.candidate ?? candidate,
			leaseId: lease.id,
			conversationId: values.conversationId,
			submissionKey: values.submissionKey,
			grantedFeedbackIds: feedbackIds,
			outcome: values.outcome,
			code: values.code,
		});

		let implementationOutcome: Awaited<ReturnType<ConversationKit["submitAndAwait"]>> | undefined;
		const resumeImplement = active?.stage === "implement" && active.state === "pending";
		const startImplement = !active;
		if (startImplement || resumeImplement) {
			let conversation: Conversation;
			let requestId: string;
			if (resumeImplement) {
				if (active.conversationId === undefined || !active.submissionKey) {
					throw new RecoveryRequiredError(`task ${task.id} wave ${wave} implement checkpoint is missing its submission identity`);
				}
				const foundConversation = await convKit.find(active.conversationId);
				if (!foundConversation) throw new RecoveryRequiredError(`task ${task.id} wave ${wave} implementer conversation ${active.conversationId} is unavailable`);
				conversation = foundConversation;
				requestId = active.submissionKey;
			} else {
				const initialView = await materializeRead({ root, oid: startTree }, controls);
				const initialContext = await createTaskExecutionContext({
					controlPaths: kit.loop.paths,
					grant: { planRevision: opts.grant.planRevision, selectedTaskIds: opts.grant.selected },
					taskId: current.id,
					parentOid: parent,
					startOid: startTree,
					candidateOid: startTree,
					writableWorkspace: lease,
					frozenReadView: initialView,
					recipeBundle: bundle,
					execArgv: hostExecArgv,
				});
				conversation = await openTaskConversation(kit, convKit, current, initialContext);
				requestId = submissionKey(waveKey, "implement");
				const startedAt = Date.now();
				await commitState(kit, {
					router: (draft) => {
						const row = draft.tasks.find((entry) => entry.id === current.id)!;
						row.status = "in_progress";
						row.convId = conversation.id as unknown as number;
						if (!row.baselineTreeSha) row.baselineTreeSha = baseForTask;
					},
					checkpoints: [stageCheckpoint("implement", "pending", {
						conversationId: Number(conversation.id), submissionKey: requestId, outcome: "submitted",
					})],
					rows: [{
						ts: startedAt,
						kind: "wave",
						task: current.id,
						wave,
						verb: "start",
						treeSha: startTree,
						planRevision: identity.planRevision,
				}],
					statusPhase: { phase: "wave-running", task: current.id, wave, startedAt },
				});
				emit({ kind: "wave-start", taskId: current.id, wave, message: `wave ${wave} starting for ${current.id}` });
				await discardWorkspace(initialView).catch(() => {});
			}
			let promptMd = await readFile(join(lease.workspacePath, "PROMPT.md"), "utf8").catch(() => undefined);
			if (promptMd === undefined && !candidate) {
				const promptView = await materializeRead({ root, oid: startTree }, controls);
				promptMd = await readFile(join(promptView.viewPath, "PROMPT.md"), "utf8").catch(() => undefined);
				await discardWorkspace(promptView).catch(() => {});
			}
			const waveInput = await assembleWaveInput(current, wave, opts.handoffNote, promptMd);
			implementationOutcome = await convKit.submitAndAwait(conversation, requestId, waveInput);
			await driverFault(opts, "after-implementer-submit");
			if (implementationOutcome.status === "unanswered"
				&& (looksLikeRateLimit(implementationOutcome.detail) || looksLikeRateLimit(implementationOutcome.reason))) {
				const reason = implementationOutcome.reason ?? "rate limit";
				const delay = parseResetDelay(implementationOutcome.detail) ?? parseResetDelay(reason) ?? 30 * 60;
				await armRateLimitSleep(kit, {
					until: Date.now() + delay * 1000,
					reason: String(implementationOutcome.detail ?? reason).slice(0, 120),
					taskId: current.id,
					wave,
					conversationId: Number(conversation.id),
				});
				await commitState(kit, {
					runStatus: (draft) => { draft.budgetSpentUsd = Math.max(draft.budgetSpentUsd, implementationOutcome!.usage.usd); },
					rows: [
						{ ts: Date.now(), kind: "engine", task: current.id, wave, verb: "run-failed:rate-limit", detail: String(implementationOutcome.detail ?? reason).slice(0, 200), planRevision: identity.planRevision },
						waveEndRow(current.id, wave, "sleeping", startTree, { planRevision: identity.planRevision }),
					],
					statusPhase: { phase: "idle", message: `${current.id} wave ${wave}: rate limit — durable sleep armed; rerun \`run\` to resume` },
				});
				emit({ kind: "sleeping", taskId: current.id, wave, message: "rate limit — durable sleep armed; rerun `run` to resume (exit 42)" });
				return "sleeping";
			}
		}

		if (!candidate) {
			if (!fencedWorkspace) fencedWorkspace = fenceWorkspace(lease, controls);
			try {
				candidate = (await freeze(fencedWorkspace)).tree;
			} catch (error) {
				await commitState(kit, {
					checkpoints: [stageCheckpoint("implement", "unknown", { code: "candidate-freeze-failed" })],
					statusPhase: { phase: "idle", message: `recovery required: ${current.id} wave ${wave} candidate could not be frozen` },
				});
				throw new RecoveryRequiredError(`candidate freeze for ${current.id} wave ${wave} failed: ${(error as Error).message}`);
			}
		}
		if (!candidate) throw new RecoveryRequiredError(`task ${current.id} wave ${wave} has no frozen candidate`);
		if (!fencedWorkspace) fencedWorkspace = fenceWorkspace(lease, controls);
		await writeCandidateArtifacts(kit, waveKey, startTree, candidate);

		const unfinishedImplementation = startImplement || resumeImplement;
		let implementationFailure: "retry" | "quarantined" | undefined;
		let runFailureText: string | undefined;
		let runFailureRows: WaveRow[] = [];
		let runStatusUpdate: ((draft: RunStatusDocValue) => void) | undefined;
		if (unfinishedImplementation) {
			if (!implementationOutcome) throw new RecoveryRequiredError(`task ${current.id} wave ${wave} has no reconciled implementation result`);
			if (implementationOutcome.status === "unanswered") {
				const latestState = await readSessionState(kit.loop.harness);
				const nextErrors = latestState.runStatus.consecutiveErrors + 1;
				implementationFailure = nextErrors >= kit.loop.config.budgets.maxConsecutiveErrors ? "quarantined" : "retry";
				runFailureText = `run failed: ${implementationOutcome.reason ?? "unanswered"}`;
				runStatusUpdate = (draft) => {
					draft.consecutiveErrors = nextErrors;
					draft.budgetSpentUsd = Math.max(draft.budgetSpentUsd, implementationOutcome!.usage.usd);
					if (implementationFailure === "quarantined") draft.activeAlert = `${kit.loop.config.budgets.maxConsecutiveErrors} consecutive run failures — quarantining ${current.id}`;
				};
				runFailureRows = [{ ts: Date.now(), kind: "engine", task: current.id, wave, verb: `run-failed:${implementationOutcome.reason ?? "unanswered"}`, detail: String(implementationOutcome.detail ?? "").slice(0, 200), planRevision: identity.planRevision }];
			} else {
				runStatusUpdate = (draft) => { draft.budgetSpentUsd = Math.max(draft.budgetSpentUsd, implementationOutcome!.usage.usd); };
				if (implementationOutcome.usage.usd > kit.loop.config.budgets.waveUsdWarn) {
					runFailureRows.push({ ts: Date.now(), kind: "governor", task: current.id, wave, verb: "wave-usd-warn", detail: `$${implementationOutcome.usage.usd.toFixed(2)} > $${kit.loop.config.budgets.waveUsdWarn}`, planRevision: identity.planRevision });
				}
			}
			await commitState(kit, {
				router: (draft) => {
					const row = draft.tasks.find((entry) => entry.id === current.id)!;
					row.waveCount = Math.max(row.waveCount, wave);
					if (!row.baselineTreeSha) row.baselineTreeSha = baseForTask;
				},
				runStatus: runStatusUpdate,
				checkpoints: [stageCheckpoint("implement", "complete", {
					candidate,
					conversationId: active?.conversationId ?? (current.convId !== undefined ? current.convId : undefined),
					submissionKey: active?.submissionKey ?? (startImplement ? submissionKey(waveKey, "implement") : undefined),
					outcome: implementationFailure === "retry" ? "unanswered-retry"
						: implementationFailure === "quarantined" ? "unanswered-quarantine" : "answered",
				})],
				rows: runFailureRows,
			});
			await driverFault(opts, "after-freeze");
		} else if (!active?.candidate && !lease.frozenCandidateTree) {
			throw new RecoveryRequiredError(`task ${current.id} wave ${wave} candidate pin is absent`);
		}

		const latestAfterFreeze = await latestCheckpointForWave(await receiptSnapshot(kit), waveKey);
		const implementationStage = latestAfterFreeze?.value.stage === "implement" ? latestAfterFreeze.value : undefined;
		const failedImplementOutcome = implementationStage?.outcome === "unanswered-retry" ? "retry"
			: implementationStage?.outcome === "unanswered-quarantine" ? "quarantined" : undefined;
		if (implementationFailure || failedImplementOutcome) {
			const failure = implementationFailure ?? failedImplementOutcome!;
			const finished = await finishFailedCandidate({
				kit, task: current, wave: waveKey, parent, startTree, candidate, fencedWorkspace,
				feedbackIds, outcome: failure, cause: runFailureText ?? "implementation submission failed",
				feedback: { wave, from: "gate", text: runFailureText ?? "implementation submission failed", ts: Date.now() }, opts,
			});
			if (finished === "retry") continue;
			return "quarantined";
		}

		// A durable rollback stage is replayed before reclassifying its candidate.
		// In particular, an unchanged candidate after an unanswered submission may
		// still be a retry; zero-progress must not rewrite that recorded outcome.
		if (active?.stage === "rollback") {
			if (!candidate || (active.outcome !== "retry" && active.outcome !== "quarantined")) {
				throw new RecoveryRequiredError(`task ${current.id} wave ${wave} has an invalid rollback checkpoint`);
			}
			const finished = await finishFailedCandidate({
				kit, task: current, wave: waveKey, parent, startTree, candidate, fencedWorkspace,
				feedbackIds, outcome: active.outcome, cause: active.code ?? "resuming workspace disposal",
				opts,
			});
			if (finished === "retry") continue;
			return "quarantined";
		}

		const candidateChanges = await diffTaskTrees({ root, oid: startTree }, startTree, candidate);
		const existingGate = gateReceiptForWave(await receiptSnapshot(kit), waveKey);
		if (candidateChanges.length === 0 && !existingGate) {
			await commitState(kit, {
				checkpoints: [stageCheckpoint("implement", "complete", { candidate, outcome: "zero-progress" })],
			});
			await finishFailedCandidate({
				kit, task: current, wave: waveKey, parent, startTree, candidate, fencedWorkspace,
				feedbackIds, outcome: "quarantined", cause: "zero progress: no file changes from the start-of-wave tree",
				rows: [{ ts: Date.now(), kind: "governor", task: current.id, wave, verb: "zero-progress-quarantine", detail: "wave made no progress from its own start tree", planRevision: identity.planRevision }],
				opts,
			});
			return "quarantined";
		}

		let readView: ReadWorkspace | undefined;
		let executionContext: TaskExecutionContext | undefined;
		const taskContext = async (): Promise<TaskExecutionContext> => {
			if (executionContext) return executionContext;
			readView = await materializeRead({ root, oid: candidate! }, controls);
			executionContext = await createTaskExecutionContext({
				controlPaths: kit.loop.paths,
				grant: { planRevision: opts.grant.planRevision, selectedTaskIds: opts.grant.selected },
				taskId: current.id,
				parentOid: parent,
				startOid: startTree,
				candidateOid: candidate!,
				writableWorkspace: lease,
				frozenReadView: readView,
				recipeBundle: bundle,
				execArgv: hostExecArgv,
			});
			return executionContext;
		};

		try {
		let gateReceipt = existingGate;
		let gateRun: GateOutcome | undefined;
		if (active?.stage === "gates" && active.state !== "pending" && !gateReceipt) {
			throw new RecoveryRequiredError(`gate checkpoint for ${current.id} wave ${wave} has no matching durable gate receipt`);
		}
		if (active?.stage === "gates" && active.state === "pending" && !gateReceipt) {
			throw new RecoveryRequiredError(`gate execution for ${current.id} wave ${wave} is uncertain and has no durable gate receipt`);
		}
		if (!gateReceipt) {
			if (active && ["primary", "skeptic", "integrate", "publish"].includes(active.stage)) {
				throw new RecoveryRequiredError(`task ${current.id} wave ${wave} advanced beyond gates without a gate receipt`);
			}
			const context = await taskContext();
			await commitState(kit, { checkpoints: [stageCheckpoint("gates", "pending", { candidate })] });
			const stateAtGate = await readSessionState(kit.loop.harness);
			const mirrorText = renderRouterMd(
				stateAtGate.router.tasks,
				stateAtGate.router.phase,
				stateAtGate.runStatus.prdPath,
				stateAtGate.router.identity,
				stateAtGate.router.archived,
			);
			gateRun = await runGates(kit, {
				id: current.id, targetPaths: current.targetPaths, baselineTreeSha: startTree,
				planRevision: identity.planRevision, wave,
			}, { "router.md": mirrorText }, { context });
			const gateChecks = gateRun.results.map(gateCheckFromResult);
			const duplicate = !!gateRun.failHash && gateRun.failHash === current.lastGateHash;
			gateReceipt = gateReceiptEvent(waveKey, {
				tree: candidate,
				...(identity.controlsSha256 !== undefined ? { controlsSha256: identity.controlsSha256 } : {}),
				...(gateRun.failHash ? { failureHash: gateRun.failHash } : {}),
				checks: gateChecks,
			});
			const gatePassed = gateRun.allPassed;
			const gateRow: WaveRow = {
				ts: Date.now(),
				kind: "gate",
				task: current.id,
				wave,
				verb: gatePassed ? "pass" : "fail",
				detail: gateRun.results.map((result) => `${result.name}:${result.passed}`).join(","),
				...(gateRun.scopeBody ? { reason: gateRun.scopeBody } : {}),
				planRevision: identity.planRevision,
				receiptStates: { ...waveKey, gate: gatePassed ? "pass" : "fail" },
				checkpoint: checkpointView(wave, startTree, candidate),
			};
			await commitState(kit, {
				receipts: [gateReceipt],
				checkpoints: [stageCheckpoint("gates", "complete", { candidate, outcome: duplicate ? "gate-duplicate" : gatePassed ? "gate-pass" : "gate-fail" })],
				router: (draft) => {
					if (gatePassed) return;
					const row = draft.tasks.find((entry) => entry.id === current.id)!;
					row.lastGateHash = gateRun!.failHash;
					if (!row.feedback.some((feedback) => feedback.wave === wave && feedback.from === "gate")) {
						row.feedback.push({ wave, from: "gate", text: gateRun!.feedbackText, ts: Date.now() } satisfies TaskFeedback);
					}
				},
				rows: [...(gatePassed ? [] : [gateRow]), ...(duplicate ? [{ ts: Date.now(), kind: "governor" as const, task: current.id, wave, verb: "duplicate-gate-hash-quarantine", detail: gateRun.failHash?.slice(0, 12) ?? "", planRevision: identity.planRevision }] : [])],
			});
			await driverFault(opts, "after-gates");
			emit({ kind: "gate-result", taskId: current.id, wave, passed: gatePassed, message: gatePassed ? "gates pass" : gateRun.feedbackText.slice(0, 160) });
		}
		if (!gateReceipt) throw new RecoveryRequiredError(`task ${current.id} wave ${wave} has no gate receipt after gate execution`);
		const gateOutcome = gateRun ?? gateOutcomeFromReceipt(gateReceipt.value);
		const gateCheckpoint = latestCheckpoint(await receiptSnapshot(kit), { ...waveKey, stage: "gates" })?.value;
		const duplicateGate = gateCheckpoint?.outcome === "gate-duplicate";
		if (!gateOutcome.allPassed) {
			if (gateRun) await runFailureTriageShadow(kit, current, startTree, wave, candidateChanges.map((change) => change.path), { source: "gate", gate: gateRun }, opts.judgmentClient);
			const retry = wave <= kit.loop.config.engine.retryLimit && !duplicateGate;
			const feedback = current.feedback.find((entry) => entry.wave === wave && entry.from === "gate");
			const finish = await finishFailedCandidate({
				kit, task: current, wave: waveKey, parent, startTree, candidate, fencedWorkspace,
				feedbackIds,
				outcome: retry ? "retry" : "quarantined",
				cause: duplicateGate ? "duplicate failure: identical gate failure on consecutive waves" : retry ? "gates failed" : "gate failures exhausted the wave retry limit",
				...(feedback ? { feedback } : {}),
				rows: duplicateGate ? [{ ts: Date.now(), kind: "governor", task: current.id, wave, verb: "duplicate-gate-hash-quarantine", detail: gateOutcome.failHash?.slice(0, 12), planRevision: identity.planRevision }] : [],
				opts,
			});
			if (retry && finish === "retry") continue;
			return "quarantined";
		}

		const afterGateReceipts = await receiptSnapshot(kit);
		const primaryEvent = passReceiptForWave(afterGateReceipts, waveKey, "primary", candidate, gateReceipt.value.id);
		const skepticEvent = passReceiptForWave(afterGateReceipts, waveKey, "skeptic", candidate, gateReceipt.value.id);
		const skepticRequired = kit.loop.config.gates.skepticSecondPass;
		const acceptanceExists = afterGateReceipts.events.some((event) => event.kind === "acceptance"
			&& event.value.planRevision === waveKey.planRevision && event.value.taskId === waveKey.taskId
			&& event.value.wave === waveKey.wave && event.value.tree === candidate);
		let verdict: VerifyResult | undefined;
		if (acceptanceExists || active?.stage === "integrate" || active?.stage === "publish") {
			if (!primaryEvent || primaryEvent.value.review.verdict !== "approve" || (skepticRequired && (!skepticEvent || skepticEvent.value.review.verdict !== "approve"))) {
				throw new RecoveryRequiredError(`integration checkpoint for ${current.id} wave ${wave} is missing its approving pass receipts`);
			}
			verdict = { verdict: "approve", criteria: [], notes: "reusing receipted approval" };
		} else {
			const completePassSet = !!primaryEvent && (primaryEvent.value.review.verdict !== "approve" || !skepticRequired || !!skepticEvent);
			if (completePassSet) {
				const primaryReview = primaryEvent!.value.review;
				verdict = {
					verdict: primaryReview.verdict,
					criteria: primaryReview.criteria.map((criterion) => ({ ...criterion, malformed: false })),
					notes: primaryReview.notes,
				};
				if (primaryReview.verdict === "approve" && skepticRequired && skepticEvent) {
					const skepticReview = skepticEvent.value.review;
					verdict = skepticReview.verdict === "approve" ? verdict : {
						verdict: skepticReview.verdict,
						criteria: skepticReview.criteria.map((criterion) => ({ ...criterion, malformed: false })),
						notes: `skeptic pass: ${skepticReview.notes}`.slice(0, 300),
					};
				}
			}
			if (!verdict) {
				const context = await taskContext();
				const receiptsNow = await receiptSnapshot(kit);
				const primaryCheckpoint = latestCheckpoint(receiptsNow, { ...waveKey, stage: "primary" })?.value;
				const skepticCheckpoint = latestCheckpoint(receiptsNow, { ...waveKey, stage: "skeptic" })?.value;
				if (primaryCheckpoint?.state === "complete" && !primaryEvent) throw new RecoveryRequiredError(`primary checkpoint for ${current.id} wave ${wave} has no pass receipt`);
				if (skepticCheckpoint?.state === "complete" && !skepticEvent) throw new RecoveryRequiredError(`skeptic checkpoint for ${current.id} wave ${wave} has no pass receipt`);
				if (primaryCheckpoint?.state === "pending" && (primaryCheckpoint.conversationId === undefined || !primaryCheckpoint.submissionKey)) {
					throw new RecoveryRequiredError(`primary checkpoint for ${current.id} wave ${wave} is missing its submission identity`);
				}
				if (skepticCheckpoint?.state === "pending" && (skepticCheckpoint.conversationId === undefined || !skepticCheckpoint.submissionKey)) {
					throw new RecoveryRequiredError(`skeptic checkpoint for ${current.id} wave ${wave} is missing its submission identity`);
				}
				const submissionRecovery = {
					...(primaryCheckpoint?.state === "pending" && primaryCheckpoint.conversationId !== undefined && primaryCheckpoint.submissionKey
						? { primary: { conversationId: primaryCheckpoint.conversationId, submissionKey: primaryCheckpoint.submissionKey } } : {}),
					...(skepticCheckpoint?.state === "pending" && skepticCheckpoint.conversationId !== undefined && skepticCheckpoint.submissionKey
						? { skeptic: { conversationId: skepticCheckpoint.conversationId, submissionKey: skepticCheckpoint.submissionKey } } : {}),
				};
				verdict = await runVerify(kit, {
					id: current.id,
					title: current.title,
					spec: current.spec,
					acceptance: current.acceptance,
					baselineTreeSha: startTree,
					targetPaths: current.targetPaths,
				}, gateSummaryText(gateOutcome.results), {
					skepticSecondPass: skepticRequired,
					jevShadow: { enabled: kit.loop.config.gates.jevVerifierShadow, client: opts.judgmentClient },
					executionContext: context,
					gateEvidence: { tree: candidate, gateId: gateReceipt.value.id, checks: gateReceipt.value.checks },
					waveIdentity: { planRevision: identity.planRevision, wave },
					existingPasses: {
						...(primaryEvent ? { primary: primaryEvent.value.review } : {}),
						...(skepticEvent ? { skeptic: skepticEvent.value.review } : {}),
					},
					submissionRecovery,
					submissionKeys: { primary: submissionKey(waveKey, "primary"), skeptic: submissionKey(waveKey, "skeptic") },
					onSubmissionPrepared: async (pass, conversationId, key) => {
						await commitState(kit, { checkpoints: [stageCheckpoint(pass, "pending", { candidate, conversationId, submissionKey: key, outcome: "submitted" })] });
					},
					checkpointForPass: (pass, conversationId, key, result) => stageCheckpoint(pass, "complete", {
						candidate, conversationId, submissionKey: key, outcome: result.verdict,
					}),
					afterPassCommitted: (pass) => driverFault(opts, pass === "primary" ? "after-primary" : "after-skeptic"),
				});
			}
		}
		if (!verdict) throw new RecoveryRequiredError(`task ${current.id} wave ${wave} has no reconciled verifier result`);
		if (verdict.verdict === "approve") await driverFault(opts, "after-review-before-delivery");
		if (verdict.verdict !== "approve") {
			const retry = verdict.verdict === "reject" && wave <= kit.loop.config.engine.retryLimit;
			await runFailureTriageShadow(kit, current, startTree, wave, candidateChanges.map((change) => change.path), { source: "verifier", verifier: verdict }, opts.judgmentClient);
			emit({ kind: "verifier-verdict", taskId: current.id, wave, verdict: verdict.verdict, message: verdict.notes || "(no notes)" });
			const feedback: TaskFeedback | undefined = retry ? { wave, from: "verifier", text: verdict.notes, ts: Date.now() } : undefined;
			const finish = await finishFailedCandidate({
				kit, task: current, wave: waveKey, parent, startTree, candidate, fencedWorkspace,
				feedbackIds, outcome: retry ? "retry" : "quarantined",
				cause: verdict.verdict === "needs_human" ? "verifier needs a human" : retry ? "verifier rejected" : "verifier rejects exhausted the wave retry limit",
				...(feedback ? { feedback } : {}),
				rows: [{ ts: Date.now(), kind: "verdict", task: current.id, wave, verb: `reject:${wave}`, verdict: verdict.verdict, detail: verdict.notes, planRevision: identity.planRevision }],
				opts,
			});
			if (finish === "retry") continue;
			return "quarantined";
		}

		const policy = skepticRequired ? "always" : "never";
		const required = skepticRequired ? ["primary", "skeptic"] as const : ["primary"] as const;
		await commitState(kit, { checkpoints: [stageCheckpoint("integrate", "pending", { candidate, outcome: "accepted" })] });
		await acceptCandidate(kit, {
			...waveKey,
			parent,
			tree: candidate,
			policy,
			required: [...required],
			...(identity.controlsSha256 !== undefined ? { controlsSha256: identity.controlsSha256 } : {}),
		}, opts.prPublication ?? {});
		await driverFault(opts, "after-acceptance");
		const integrated = await integrateAcceptedCandidate(kit, waveKey, opts.prPublication ?? {});
		await commitState(kit, {
			checkpoints: [stageCheckpoint("integrate", "complete", { candidate, outcome: "integrated" })],
			rows: [{ ts: Date.now(), kind: "engine", task: current.id, wave, verb: "integrated", detail: integrated.receipt.commit, planRevision: identity.planRevision }],
		});
		await driverFault(opts, "after-integration");

		const mode = kit.loop.config.delivery.mode;
		if (mode === "pr" && !opts.deliverExplicit) throw new DriverStateError('delivery.mode="pr" requires explicit --deliver consent before the run starts');
		const publishStage = latestCheckpoint(await receiptSnapshot(kit), { ...waveKey, stage: "publish" })?.value;
		if (publishStage?.state !== "pending") {
			await commitState(kit, { checkpoints: [stageCheckpoint("publish", "pending", { candidate })] });
		}
		await driverFault(opts, "before-publication");
		let delivery;
		try {
			delivery = mode === "pr"
				? await publishPullRequest(kit, waveKey, { ...(opts.prPublication ?? {}), deliverExplicit: opts.deliverExplicit === true })
				: await publishLocalResult(kit, waveKey, mode, opts.prPublication ?? {});
		} catch (error) {
			throw error instanceof RecoveryRequiredError ? error
				: new RecoveryRequiredError(`${mode} publication for ${current.id} wave ${wave} is not confirmed: ${(error as Error).message}`);
		}
		const afterDeliveryReceipts = await receiptSnapshot(kit);
		const receiptStates = receiptStatesForWave(afterDeliveryReceipts, waveKey);
		const publishOutcome = delivery.receipt.state === "not_requested" ? "not-requested" : "published";
		await commitState(kit, {
			checkpoints: [stageCheckpoint("publish", "complete", { candidate, outcome: publishOutcome })],
			rows: [{
				ts: Date.now(),
				kind: "delivery",
				task: current.id,
				wave,
				verb: delivery.receipt.state,
				detail: delivery.receipt.ref ?? delivery.receipt.code ?? delivery.receipt.commit,
				planRevision: identity.planRevision,
				receiptStates,
				checkpoint: checkpointView(wave, startTree, candidate),
			}],
		});
		await driverFault(opts, "after-publication");
		const terminalReceipts = await receiptSnapshot(kit);
		const finalReceiptStates = receiptStatesForWave(terminalReceipts, waveKey);
		const view = checkpointView(wave, startTree, candidate);
		await commitState(kit, {
			router: (draft) => {
				const row = draft.tasks.find((entry) => entry.id === current.id)!;
				row.status = "done";
				row.waveCount = Math.max(row.waveCount, wave);
			},
			checkpoints: [stageCheckpoint("terminal", "complete", { candidate, outcome: "accepted" })],
			rows: [
				{ ts: Date.now(), kind: "task", task: current.id, wave, verb: "done", verdict: "approve", planRevision: identity.planRevision, receiptStates: finalReceiptStates, checkpoint: view },
				waveEndRow(current.id, wave, "approved", candidate, { planRevision: identity.planRevision, receiptStates: finalReceiptStates, checkpoint: view }),
			],
			statusPhase: { phase: "idle", message: `${current.id} accepted and publication confirmed (wave ${wave})` },
		});
		emit({ kind: "task-done", taskId: current.id, wave, message: `${current.id} accepted and publication confirmed` });
		return "done";
		} finally {
			if (readView) await discardWorkspace(readView).catch(() => {});
		}
	}
}

/** Best-effort provenance after failure feedback commits; no result feeds control flow. */
async function runFailureTriageShadow(
	kit: LoopAndLock,
	task: RouterTask,
	baselineTreeSha: string,
	wave: number,
	changedFiles: string[],
	failure: { source: "gate"; gate: GateOutcome } | { source: "verifier"; verifier: VerifyResult },
	client: JudgmentClient | undefined,
): Promise<void> {
	if (!kit.loop.config.gates.jevFailureTriageShadow) return;
	try {
		const evidence = {
			task: {
				id: task.id,
				title: task.title,
				spec: task.spec,
				acceptance: task.acceptance,
				baselineTreeSha,
				targetPaths: task.targetPaths,
			},
			wave,
			changedFiles,
			...failure,
		} as FailureTriageEvidence;
		const assessment = await assessFailureTriage(evidence, {
			enabled: true,
			client,
			apiKey: process.env["TYPESAFE_API_KEY"],
		});
		if (assessment.status === "assessed") {
			await persistFailureTriageAssessment(kit.loop.paths.root, assessment);
		}
	} catch {
		// The existing failure, feedback, retry, and quarantine outcomes stand.
	}
}

/** Open the implementer conversation with role config + guard doc. */
async function openTaskConversation(kit: LoopAndLock, convKit: ConversationKit, task: RouterTask, executionContext: TaskExecutionContext) {
	const role = kit.loop.config.roles.implementer;
	return convKit.createUnit({
		instructions: `${IMPLEMENTER_BRIEF}\n\nKit: ${kit.loop.config.engine.piDurable} · project ${kit.loop.paths.root}`,
		guard: { role: "implementer", targetPaths: task.targetPaths },
		tools: "coding",
		model: { provider: role.provider, modelId: role.modelId, thinkingLevel: role.thinkingLevel },
		maxTurns: kit.loop.config.engine.maxTurns,
		executionContext,
	});
}

/**
 * One wave's user message: PROMPT.md + role brief + spec + criteria + feedback
 * of the previous wave + handoff note.
 */
export async function assembleWaveInput(task: RouterTask, wave: number, handoffNote?: string, promptMd?: string): Promise<string> {
	const spec = [
		`TASK ${task.id} — WAVE ${wave}: ${task.title}`,
		`TARGET PATHS: ${task.targetPaths.length ? task.targetPaths.join(", ") : "(whole repo)"}`,
		`SPEC:`,
		task.spec,
		`ACCEPTANCE CRITERIA (all must hold to end this task):`,
		task.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n"),
	];
	if (task.feedback.length) {
		spec.push(`FEEDBACK FROM PREVIOUS WAVES (address every point):`);
		for (const fb of task.feedback) spec.push(`- wave ${fb.wave} [${fb.from}]: ${fb.text}`);
	}
	if (handoffNote) spec.push(`USER HANDOFF NOTE: ${handoffNote}`);
	if (promptMd) spec.push(`PROMPT.MD (the kit's per-wave discipline — follow it): ${promptMd}`);
	spec.push(`End with a single line: STATUS: COMPLETE or STATUS: BLOCKED <reason>.`);
	return spec.join("\n\n");
}

/** Gate row; empty scopeBody stays absent (strict-JSON drafts hate undefined). */
/** UI seam A.1: the close of one (task, wave) — outcome in `detail` so the
 *  timeline spans keep real start/end times and messages. A.7: `endTree` (when
 *  captured) rides the row so the wave's isolated diff has its end point; a row
 *  without one is a wave that is simply not isolatable, never a failed run. */
function waveEndRow(
	taskId: string,
	wave: number,
	outcome: string,
	endTree?: string,
	facts: { planRevision?: string; receiptStates?: import("./receipts.ts").ReceiptStateView; checkpoint?: FrozenCheckpointView } = {},
): WaveRow {
	return {
		ts: Date.now(),
		kind: "wave",
		task: taskId,
		wave,
		verb: "end",
		detail: outcome,
		...(endTree ? { treeSha: endTree } : {}),
		...(facts.planRevision ? { planRevision: facts.planRevision } : {}),
		...(facts.receiptStates ? { receiptStates: facts.receiptStates } : {}),
		...(facts.checkpoint ? { checkpoint: facts.checkpoint } : {}),
	};
}


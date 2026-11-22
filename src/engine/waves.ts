/**
 * Wave driver (§4.2): the sequential loop that turns a planned RouterDoc into
 * merged code. Per task: baseline tree capture → waves (implementer run →
 * gates → verifier) → done or quarantine (rollback to baseline) → delivery.
 * Resumable at every boundary via RouterDoc commits; permission gated by the
 * human approval stamp; rate-limited runs arm the governor's durable sleep and
 * exit 42 for the next `run` to pick up.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { atomicWriteJson, readJson } from "../util/fsx.ts";
import { BACKGROUND_CONTEXT, convId } from "./kit.ts";
import { ConversationKit } from "./conversations.ts";
import type { LoopAndLock } from "./harness.ts";
import {
	commitState, readSessionState, grantRefusal, readGrant, approvalMirrorRefusal, resolveGrantSelection,
} from "./state.ts";
import type { Grant, SessionState } from "./state.ts";
import type { RouterTask, RouterDocValue, WaveRow, TaskFeedback } from "./infos.ts";
import { runGates } from "./gates.ts";
import { renderRouterMd } from "./infos.ts";
import type { GateOutcome } from "./gates.ts";
import { runVerify, gateSummaryText } from "./verifier.ts";
import type { VerifyResult } from "./verifier.ts";
import { gateCheckFromResult, gateReceiptEvent, passReceiptEvent } from "./receipts.ts";
import type { GateCheck } from "./receipts.ts";
import {
	assessFailureTriage, persistFailureTriageAssessment, type FailureTriageEvidence,
} from "./failure-triage.ts";
import { armRateLimitSleep, looksLikeRateLimit, parseResetDelay, waitOutSleep } from "./governor.ts";
import { captureBaselineTree, restoreTree, saveDisplayPatch, changedFilesVsTree } from "../util/git.ts";
import type { DisplayDiffStats } from "../util/git.ts";
import { runDelivery } from "./delivery.ts";
import type { ProgressEvent } from "./driver-events.ts";
import type { JudgmentClient } from "../judgment/types.ts";
import { trustedCompatibilityContext } from "./workspace.ts";

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
}

/**
 * §3 transition-5 exits: `plan-complete`/`selection-complete` are the two
 * distinct fulfillment strings (both exit 0); `blocked` (quarantine or
 * unsatisfiable selection), `budget` are policy stops (exit 2); `sleeping`
 * is the rate-limit wait (exit 42). Hard errors throw (exit 1); SIGINT is
 * the CLI's 130.
 */
export type DriverExit = "plan-complete" | "selection-complete" | "blocked" | "budget" | "sleeping";

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
	/** Granted task ids the run stopped on (quarantined, or outstanding and
	 *  blocked by quarantined dependencies). */
	blockedIds: string[];
	alert?: string;
}

/**
 * M0-P05 anticipation (§3 transition 5): a new grant must not be minted
 * while a different active checkpoint is unresolved (recovery blocks the
 * queue, and a disjoint grant is possible only after pending effects are
 * reconciled). No checkpoint records exist in this milestone's state model
 * yet (they arrive with the wave-keyed checkpoint/receipt packets), so this
 * refusal is a documented no-op today; it returns the named conflict once
 * durable checkpoints exist.
 */
function activeCheckpointConflict(state: SessionState): string | undefined {
	void state;
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
	const checkpointConflict = activeCheckpointConflict(state);
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
		const outcome = await driveTaskWaves(kit, task, {
			handoffNote: handoff?.note,
			onEvent: emit,
			deliverExplicit: options.deliverExplicit,
			judgmentClient: options.judgmentClient,
			planRevision: grant.planRevision,
		});
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
		summary.ranWaves.push(task.waveCount);
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
	/** The granted plan revision (M0-P11): wave-keyed gate/pass receipts bind
	 *  to the authorized revision this run executes. */
	planRevision: string;
}

export interface TaskWavesResult {
	outcome: "done" | "quarantined" | "sleeping" | "budget";
}

export async function driveTaskWaves(
	kit: LoopAndLock,
	task: RouterTask,
	opts: TaskWavesOptions,
): Promise<DriverExit | "done" | "quarantined"> {
	const paths = kit.loop.paths;
	const emit = (e: ProgressEvent) => opts.onEvent?.(e);
	const convKit = new ConversationKit(kit, kit.loop.toolBox);
	// Explicit pre-cutover bridge: the serial driver still runs trusted fixtures
	// against the operator root until P14; prepared task contexts are not active.
	const executionContext = trustedCompatibilityContext(paths);

	for (;;) {
		const state = await readSessionState(kit.loop.harness);
		const current = state.router.tasks.find((t) => t.id === task.id);
		if (!current) throw new DriverStateError(`task ${task.id} vanished from the router doc`);
		if (current.status === "done") return "done";
		if (current.status === "quarantined") return "quarantined";

		const wave = current.waveCount + 1;

		// Baseline capture before Wave 1 (§4.2.3).
		let baseline = current.baselineTreeSha;
		if (!baseline) {
			baseline = await captureBaselineTree(paths.root);
			await commitState(kit, {
				router: (d) => {
					const t = d.tasks.find((x) => x.id === task.id)!;
					t.baselineTreeSha = baseline;
				},
				rows: [{ ts: Date.now(), kind: "task", task: task.id, verb: "baseline", detail: baseline }],
			});
		}

		emit({ kind: "wave-start", taskId: task.id, wave, message: `wave ${wave} starting for ${task.id}` });

		// Conversation lifecycle (§4.2.4).
		let conv = current.convId !== undefined ? await convKit.find(current.convId) : undefined;
		if (!conv) {
			conv = await openTaskConversation(kit, convKit, current, executionContext);
			current.convId = conv.id as unknown as number;
			await commitState(kit, {
				router: (d) => {
					const t = d.tasks.find((x) => x.id === task.id)!;
					t.convId = conv!.id as unknown as number;
				},
			});
		} else if (wave > 1) {
			// Prior wave failed: reset the context to keep failed debug turns out of the window.
			await conv.reset(undefined, BACKGROUND_CONTEXT);
		}

		const promptMd = await readFile(join(paths.root, "PROMPT.md"), "utf8").catch(() => undefined);
		const waveInput = await assembleWaveInput(current, wave, opts.handoffNote, promptMd);
		// UI seam A.1, at wave start (before the run is submitted): task → in_progress,
		// wave-log start row (`ts` IS startedAt), and a wave-running status.json with
		// task/wave/startedAt so an attached UI shows the live wave without storage.
		const startedAt = Date.now();
		// UI seam A.7: the wave's own tree at start — per-wave isolated diffs read
		// this vs the end row's tree. A failed capture drops the field, never the run.
		const startTree = await waveTreeSoft(paths.root);
		await commitState(kit, {
			router: (d) => {
				const t = d.tasks.find((x) => x.id === task.id)!;
				t.status = "in_progress";
			},
			rows: [{ ts: startedAt, kind: "wave", task: task.id, wave, verb: "start", ...(startTree ? { treeSha: startTree } : {}) }],
			statusPhase: { phase: "wave-running", task: task.id, wave, startedAt },
		});
		const outcomeWave = await convKit.submitAndAwait(conv, `${task.id}-w${wave}`, waveInput);

		const warnRows: WaveRow[] = [];
		if (outcomeWave.usage.usd > kit.loop.config.budgets.waveUsdWarn) {
			warnRows.push({ ts: Date.now(), kind: "governor", task: task.id, wave, verb: "wave-usd-warn", detail: `$${outcomeWave.usage.usd.toFixed(2)} > $${kit.loop.config.budgets.waveUsdWarn}` });
		}
		// Budget accumulation per wave.
		await commitState(kit, {
			runStatus: (d) => {
				d.budgetSpentUsd = Math.max(d.budgetSpentUsd, outcomeWave.usage.usd);
			},
			rows: warnRows,
		});

		// Run failure paths (§4.2.5 / §4.5).
		if (outcomeWave.status === "unanswered") {
			const reason = outcomeWave.reason ?? "unanswered";
			const handled = await handleUnanswered(kit, current, wave, reason, outcomeWave.detail, outcomeWave.usage.usd);
			if (handled === "sleeping") {
				// UI seam A.1 at wave end: close the wave (sleep is a wave outcome — the
				// run resumes at a later `run`, never inside this one).
				await commitState(kit, {
					rows: [waveEndRow(task.id, wave, "sleeping", await waveTreeSoft(paths.root) /* A.7: what the wave left behind */)],
					statusPhase: { phase: "idle", message: `${task.id} wave ${wave}: rate limit — durable sleep armed; rerun \`run\` to resume` },
				});
				emit({ kind: "sleeping", taskId: task.id, wave, message: "rate limit — durable sleep armed; rerun `run` to resume (exit 42)" });
				return "sleeping";
			}
			if (handled === "budget") return "budget";
			if (handled === "faulted") {
				await quarantine(kit, current, wave, `run failed: ${reason}`, baseline);
				continue;
			}
			continue; // retried wave under the retry limit
		}

		// Zero-progress breaker (§4.5): the wave must move the tree. Fires before
		// gates so a stalled implementer cannot burn verifier budget either.
		const filesChangedRaw = await changedFilesVsTree(paths.root, baseline);
		// Engine-owned writes (router.md mirror sync, .orch runtime) are not the
		// wave's output; the zero-progress breaker and scope verdicts use the rest.
		const filesChanged = filesChangedRaw.filter((f) => !f.startsWith(".orch") && f !== "router.md" && f !== "PROMPT.md");
		if (process.env["KIT_DEBUG"]) console.error(`[kit-debug] ${task.id} w${wave} changedRaw=${JSON.stringify(filesChangedRaw)} engineFiles=${JSON.stringify(filesChanged)} baseline=${baseline}`);
		if (filesChanged.length === 0) {
			await commitState(kit, {
				rows: [{ ts: Date.now(), kind: "governor", task: task.id, wave, verb: "zero-progress-quarantine", detail: "wave produced zero file changes" }],
			});
			await quarantine(kit, current, wave, "zero progress: no file changes", baseline);
			continue;
		}

		// Gates (§4.3). Router.md is engine-synced: the expected bytes render from
		// the doc AS OF NOW (the loop-top read is stale across baseline commits).
		const stateAtGate = await readSessionState(kit.loop.harness);
		// Expected mirror bytes render from the durable doc INCLUDING its plan
		// identity — byte-identical to what syncSideCars writes (M0-P04).
		const mirrorText = renderRouterMd(
			stateAtGate.router.tasks,
			stateAtGate.router.phase,
			stateAtGate.runStatus.prdPath,
			stateAtGate.router.identity,
			stateAtGate.router.archived,
		);
		const gate = await runGates(kit, { id: task.id, targetPaths: current.targetPaths, baselineTreeSha: baseline }, { "router.md": mirrorText }, { context: executionContext });

		// M0-P11: the gate receipt binds the checked tree and every check outcome
		// (skipped included) as a durable `loop.receipts` event. The trusted
		// compatibility path captures the wave content the gates just inspected
		// (prepared contexts check the frozen candidate — activated at P14). Pass
		// receipts reference this receipt by id, so a pass can never claim
		// evidence from another tree.
		const checkedTree = await captureBaselineTree(paths.root);
		const gateChecks: GateCheck[] = gate.results.map(gateCheckFromResult);
		const gateReceipt = gateReceiptEvent(
			{ planRevision: opts.planRevision, taskId: task.id, wave },
			{
				tree: checkedTree,
				...(stateAtGate.router.identity?.controlsSha256 !== undefined ? { controlsSha256: stateAtGate.router.identity.controlsSha256 } : {}),
				checks: gateChecks,
			},
		);
		await commitState(kit, { receipts: [gateReceipt] });

		if (gate.failHash && gate.failHash === current.lastGateHash) {
			await commitState(kit, {
				rows: [{ ts: Date.now(), kind: "governor", task: task.id, wave, verb: "duplicate-gate-hash-quarantine", detail: gate.failHash.slice(0, 12) }],
			});
			await runFailureTriageShadow(kit, current, baseline, wave, filesChanged, { source: "gate", gate }, opts.judgmentClient);
			await quarantine(kit, current, wave, "duplicate failure: identical gate failure hash two waves running", baseline);
			continue;
		}

		const underLimit = wave <= kit.loop.config.engine.retryLimit;
		if (!gate.allPassed) {
			await commitState(kit, {
				router: (d) => {
					const t = d.tasks.find((x) => x.id === task.id)!;
					t.lastGateHash = gate.failHash;
					t.waveCount = wave;
					if (underLimit) {
						// Wave ends on retry: back to todo so the next wave-start can set
						// in_progress again (UI seam A.1).
						t.status = "todo";
						t.feedback.push({ wave, from: "gate", text: gate.feedbackText, ts: Date.now() } satisfies TaskFeedback);
					} else {
						t.status = "quarantined";
					}
				},
				rows: underLimit
					? [gateRowFor(task.id, wave, gate), waveEndRow(task.id, wave, "retry: gates failed", await waveTreeSoft(paths.root) /* A.7: a retried wave still ends a span */)]
					: [gateRowFor(task.id, wave, gate)],
				// UI seam A.1 at wave end: on retry the wave window closes here (idle);
				// the next wave's start row re-opens it. Terminal outcomes flush via
				// quarantine() below.
				...(underLimit
					? { statusPhase: { phase: "idle" as const, message: `${task.id} gates failed (wave ${wave}) — retry queued` } }
					: {}),
			});
			await runFailureTriageShadow(kit, current, baseline, wave, filesChanged, { source: "gate", gate }, opts.judgmentClient);
			emit({
				kind: "gate-result",
				taskId: task.id,
				wave,
				passed: gate.allPassed,
				message: gate.allPassed ? "gates pass" : gate.feedbackText.slice(0, 160),
			});
			if (underLimit) continue; // loop to next wave with structured feedback
			await quarantine(kit, current, wave, "gate failures exhausted the wave retry limit", baseline);
			continue;
		}

		// Verifier (§4.4). Both read-only passes receive the checked tree, the gate
		// receipt id and the non-skipped outcomes independently; each pass is
		// validated against the checked tree and committed before the next runs.
		const verdict = await runVerify(kit, {
			id: current.id,
			title: current.title,
			spec: current.spec,
			acceptance: current.acceptance,
			baselineTreeSha: baseline,
			targetPaths: current.targetPaths,
		}, gateSummaryText(gate.results), {
			skepticSecondPass: kit.loop.config.gates.skepticSecondPass,
			jevShadow: { enabled: kit.loop.config.gates.jevVerifierShadow, client: opts.judgmentClient },
			executionContext,
			gateEvidence: { tree: checkedTree, gateId: gateReceipt.value.id, checks: gateChecks },
			waveIdentity: { planRevision: opts.planRevision, wave },
		});

		if (verdict.verdict === "approve") {
			await commitState(kit, {
				router: (d) => {
					const t = d.tasks.find((x) => x.id === task.id)!;
					t.status = "done";
					t.waveCount = wave;
				},
				rows: [
					{ ts: Date.now(), kind: "task", task: task.id, wave, verb: "done", verdict: "approve" },
					// UI seam A.1: the wave ends here — the span outcome stays "approved".
					waveEndRow(task.id, wave, "approved", await waveTreeSoft(paths.root) /* A.7: the approved wave's own end tree */),
				],
				statusPhase: { phase: "idle", message: `${task.id} approved (wave ${wave})` },
			});
			// UI seam A.2: the task's display patch + stats side-car land in
			// .orch/artifacts BEFORE delivery — the tree is the task's final state
			// here (delivery may commit; the patch is cumulative since baseline).
			await writeTaskDiffArtifacts(kit, task.id, wave, baseline);
			emit({ kind: "task-done", taskId: task.id, wave, message: `${task.id} verified + approved` });
			await runDelivery(kit, task.id, wave, { deliverExplicit: opts.deliverExplicit });
			return "done";
		}

		const canRetry = verdict.verdict === "reject" && underLimit;
		await commitState(kit, {
			router: (d) => {
				const t = d.tasks.find((x) => x.id === task.id)!;
				t.waveCount = wave;
				if (canRetry) {
					// Wave ends on retry (UI seam A.1): back to todo.
					t.status = "todo";
					t.feedback.push({ wave, from: "verifier", text: verdict.notes, ts: Date.now() } satisfies TaskFeedback);
				} else {
					t.status = "quarantined";
				}
			},
			rows: [
				{ ts: Date.now(), kind: "verdict", task: task.id, wave, verb: `reject:${wave}`, verdict: verdict.verdict, detail: verdict.notes },
				...(canRetry ? [waveEndRow(task.id, wave, "retry: verifier rejected", await waveTreeSoft(paths.root) /* A.7: retry-scope end tree */)] : []),
			],
			...(canRetry
				? { statusPhase: { phase: "idle" as const, message: `${task.id} verifier rejected (wave ${wave}) — retry queued` } }
				: {}),
		});
		await runFailureTriageShadow(kit, current, baseline, wave, filesChanged, { source: "verifier", verifier: verdict }, opts.judgmentClient);
		emit({ kind: "verifier-verdict", taskId: task.id, wave, verdict: verdict.verdict, message: verdict.notes || "(no notes)" });
		if (canRetry) continue;
		await quarantine(kit, current, wave, verdict.verdict === "needs_human" ? "verifier needs a human" : "verifier rejects exhausted the retry limit", baseline);
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
async function openTaskConversation(kit: LoopAndLock, convKit: ConversationKit, task: RouterTask, executionContext: ReturnType<typeof trustedCompatibilityContext>) {
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
 * UI seam A.2: persist the task's cumulative display patch + stats side-car to
 * .orch/artifacts (task-<id>.patch / task-<id>.json). Retries never reset the
 * tree, so the patch spans every attempt since the baseline; each terminal
 * outcome rewrites both files. Best-effort evidence: a failed write is
 * swallowed — the loop never breaks for the UI.
 */
async function writeTaskDiffArtifacts(kit: LoopAndLock, taskId: string, wave: number, baseline: string | undefined): Promise<void> {
	if (!baseline) return;
	const artifacts = kit.loop.paths.artifacts;
	const patchFile = join(artifacts, `task-${taskId}.patch`);
	try {
		const display = await saveDisplayPatch(kit.loop.paths.root, baseline, patchFile);
		if (!display.ok) return; // nothing displayable — no patch, no stats side-car
		const stats: DisplayDiffStats = {
			task: taskId,
			wave,
			baselineTreeSha: baseline,
			generatedAt: Date.now(),
			files: display.stats.files,
			totalInsertions: display.stats.totalInsertions,
			totalDeletions: display.stats.totalDeletions,
			bytes: display.bytes,
			truncated: display.truncated,
		};
		await atomicWriteJson(join(artifacts, `task-${taskId}.json`), stats);
	} catch {
		/* UI-seam evidence only — the run outcome stands on its own */
	}
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

// ---------------------------------------------------------------------------
// Run-failure handling (governor)
// ---------------------------------------------------------------------------

async function handleUnanswered(
	kit: LoopAndLock,
	task: RouterTask,
	wave: number,
	reason: string,
	detail: unknown,
	waveUsd: number,
): Promise<"sleeping" | "retried" | "faulted" | "budget"> {
	const rows: WaveRow[] = [
		{ ts: Date.now(), kind: "engine", task: task.id, wave, verb: `run-failed:${reason}`, detail: String(detail ?? "").slice(0, 200) },
	];
	if (looksLikeRateLimit(detail) || looksLikeRateLimit(reason)) {
		const delaySec = parseResetDelay(detail) ?? parseResetDelay(reason) ?? 30 * 60;
		const until = Date.now() + delaySec * 1000;
		const convId = task.convId ?? 0;
		if (task.convId === undefined) return "faulted";
		await armRateLimitSleep(kit, { until, reason: String(detail ?? reason).slice(0, 120), taskId: task.id, wave, conversationId: task.convId });
		return "sleeping";
	}
	// Non-rate-limit failure: count it; consecutive errors breaker (§4.5).
	const state = await readSessionState(kit.loop.harness);
	const maxErrors = kit.loop.config.budgets.maxConsecutiveErrors;
	const nextCount = state.runStatus.consecutiveErrors + 1;
	if (nextCount >= maxErrors) {
		await commitState(kit, {
			rows,
			runStatus: (d) => {
				d.consecutiveErrors = nextCount;
				d.activeAlert = `${maxErrors} consecutive run failures — quarantining ${task.id}`;
			},
		});
		return "faulted"; // the driver quarantines once
	}
	await commitState(kit, {
		rows: [...rows, waveEndRow(task.id, wave, `retry: run failed: ${reason.slice(0, 120)}`, await waveTreeSoft(kit.loop.paths.root) /* A.7: what the failed wave left behind */)],
		router: (d) => {
			const t = d.tasks.find((x) => x.id === task.id)!;
			t.waveCount = wave;
			// UI seam A.1 at wave end: back to todo; the next wave sets in_progress.
			t.status = "todo";
			t.feedback.push({ wave, from: "gate", text: `run failed: ${reason}`, ts: Date.now() } satisfies TaskFeedback);
		},
		runStatus: (d) => {
			d.consecutiveErrors = nextCount;
			d.budgetSpentUsd = Math.max(d.budgetSpentUsd, waveUsd);
		},
		statusPhase: { phase: "idle", message: `${task.id} wave ${wave} run failed (${reason.slice(0, 160)}) — retry queued` },
	});
	return "retried";
}

// ---------------------------------------------------------------------------
// Quarantine (§4.2.7): patch the wave's changes, roll back to baseline
// ---------------------------------------------------------------------------

export async function quarantine(kit: LoopAndLock, task: RouterTask, wave: number, cause: string, baselineTreeSha?: string): Promise<void> {
	const paths = kit.loop.paths;
	// The caller's in-scope baseline (captured at wave start) beats the stale
	// task copy: on a wave-1 quarantine the task object predates the capture.
	// Without this, first-wave quarantines never wrote their evidence patch.
	const baseline = baselineTreeSha ?? task.baselineTreeSha;
	// A.7: the quarantined wave's own tree — captured BEFORE the rollback so the
	// isolated wave diff names what the wave produced (the evidence saved below),
	// not the empty post-restore tree. The save below only touches .orch, which
	// the capture skips, so the tree bytes are the wave's final content either way.
	const producedTree = await waveTreeSoft(paths.root);
	let patchFile: string | undefined;
	if (baseline) {
		const artifactName = `quarantined-${task.id}-w${wave}.patch`;
		patchFile = join(paths.artifacts, artifactName);
		try {
			await mkdir(dirname(patchFile), { recursive: true });
			// UI seam A.2: the display wrapper keeps this an evidence artifact
			// (engine paths excluded, 5 MiB cap) and enables the stats side-car;
			// rollback itself stays restoreTree — never the (possibly truncated) patch.
			const saved = await saveDisplayPatch(paths.root, baseline, patchFile);
			if (saved.ok) {
				const stats: DisplayDiffStats = {
					task: task.id,
					wave,
					baselineTreeSha: baseline,
					generatedAt: Date.now(),
					files: saved.stats.files,
					totalInsertions: saved.stats.totalInsertions,
					totalDeletions: saved.stats.totalDeletions,
					bytes: saved.bytes,
					truncated: saved.truncated,
				};
				await atomicWriteJson(join(paths.artifacts, `quarantined-${task.id}-w${wave}.json`), stats);
			} else {
				patchFile = undefined;
			}
		} catch {
			patchFile = undefined;
		}
		await restoreTree(paths.root, baseline).catch(() => {});
	}
	await commitState(kit, {
		router: (d) => {
			const t = d.tasks.find((x) => x.id === task.id)!;
			t.status = "quarantined";
			t.feedback.push({
				wave,
				from: "gate",
				text: `quarantined: ${cause}`,
				ts: Date.now(),
			} satisfies TaskFeedback);
		},
		rows: [
			{
				ts: Date.now(),
				kind: "task",
				task: task.id,
				wave,
				verb: "quarantined",
				reason: cause,
				detail: patchFile ? `working tree rolled back to ${baseline!.slice(0, 12)}; patch at ${artifact(patchFile)}` : "working tree rolled back to baseline",
			},
			// UI seam A.1: the terminal wave outcome closes the span; detail keeps the
			// cause so the timeline leaves no dead-end "wave/end" label.
			waveEndRow(task.id, wave, `quarantined: ${cause.slice(0, 200)}`, producedTree),
		],
		statusPhase: { phase: "idle", message: `${task.id} quarantined: ${cause}` },
	});
}

function artifact(path: string): string {
	return path.split("/").slice(-2).join("/");
}

/** Gate row; empty scopeBody stays absent (strict-JSON drafts hate undefined). */
/** UI seam A.1: the close of one (task, wave) — outcome in `detail` so the
 *  timeline spans keep real start/end times and messages. A.7: `endTree` (when
 *  captured) rides the row so the wave's isolated diff has its end point; a row
 *  without one is a wave that is simply not isolatable, never a failed run. */
function waveEndRow(taskId: string, wave: number, outcome: string, endTree?: string): WaveRow {
	return { ts: Date.now(), kind: "wave", task: taskId, wave, verb: "end", detail: outcome, ...(endTree ? { treeSha: endTree } : {}) };
}

/** A.7's soft capture: the same `captureBaselineTree` throwaway-index snapshot
 *  the baseline path uses, but a failure degrades to `undefined` — a missing
 *  view, not a failed wave (deliberately softer than the baseline path's
 *  throw: a missing baseline is fatal, a missing wave tree is only a view). */
async function waveTreeSoft(root: string): Promise<string | undefined> {
	try {
		return await captureBaselineTree(root);
	} catch {
		return undefined;
	}
}

/** Gate row; empty scopeBody stays absent (strict-JSON drafts hate undefined). */
function gateRowFor(taskId: string, wave: number, gate: GateOutcome): WaveRow {
	const base: WaveRow = {
		ts: Date.now(),
		kind: "gate",
		task: taskId,
		wave,
		verb: gate.allPassed ? "pass" : "fail",
		detail: gate.results.map((r) => `${r.name}:${r.passed}`).join(","),
	};
	if (gate.scopeBody) base.reason = gate.scopeBody;
	return base;
}


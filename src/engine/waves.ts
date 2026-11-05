/**
 * Wave driver (§4.2): the sequential loop that turns a planned RouterDoc into
 * merged code. Per task: baseline tree capture → waves (implementer run →
 * gates → verifier) → done or quarantine (rollback to baseline) → delivery.
 * Resumable at every boundary via RouterDoc commits; permission gated by the
 * human approval stamp; rate-limited runs arm the governor's durable sleep and
 * exit 42 for the next `run` to pick up.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { readJson } from "../util/fsx.ts";
import { BACKGROUND_CONTEXT, convId } from "./kit.ts";
import { ConversationKit } from "./conversations.ts";
import type { LoopAndLock } from "./harness.ts";
import { commitState, readSessionState } from "./state.ts";
import type { RouterTask, RouterDocValue, WaveRow, TaskFeedback } from "./infos.ts";
import { runGates } from "./gates.ts";
import type { GateOutcome } from "./gates.ts";
import { runVerify, gateSummaryText } from "./verifier.ts";
import type { VerifyResult } from "./verifier.ts";
import { armRateLimitSleep, looksLikeRateLimit, parseResetDelay, waitOutSleep } from "./governor.ts";
import { captureBaselineTree, restoreTree, savePatch, changedFilesVsTree } from "../util/git.ts";
import { runDelivery } from "./delivery.ts";
import type { ProgressEvent } from "./driver-events.ts";

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
	const doneOrGone = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
	const candidates = tasks.filter(
		(t) => t.status === "todo" && t.dependsOn.every((d) => doneOrGone.has(d)),
	);
	if (candidates.length === 0) return undefined;
	candidates.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
	return candidates[0];
}

export function pickNextTaskForOrder(tasks: readonly RouterTask[]): RouterTask | undefined {
	return pickNextTask(tasks);
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface RunOptions {
	approve: boolean;
	deliverExplicit?: boolean;
	/** Task ids to run instead of the whole queue (empty = all). */
	tasksFilter: string[];
}

export type DriverExit = "complete" | "budget" | "sleeping" | "arrived-blocked" | "error";

export interface RunSummaryInfo {
	exit: DriverExit;
	ranWaves: number[];
	complete: boolean;
	alert?: string;
}

export async function runWaves(
	kit: LoopAndLock,
	options: RunOptions,
	onProgress?: (event: ProgressEvent) => void,
): Promise<RunSummaryInfo> {
	const emit = (event: ProgressEvent) => onProgress?.(event);
	const state = await readSessionState(kit.loop.harness);

	// Human approval gate (§4.1): plan refuses to start waves until approved.
	if (!state.router.tasks.length) throw new DriverStateError("no tasks — run `plan` first (or migrate a router.md)");
	const approvedByStamp = state.runStatus.humanApprovedAt !== undefined;
	if (!options.approve && !approvedByStamp) {
		throw new DriverStateError(
			'router doc is PLANNED but not human-approved — rerun with --approve after reviewing router.md (this is the plan review point)',
		);
	}

	// Ingest a queued user handoff note (§3.1) before the next wave starts.
	const handoff = await readJson<{ note: string; ts: number }>(kit.loop.paths.pendingHandoff);
	if (handoff) {
		await commitState(kit, {
			rows: [{ ts: Date.now(), kind: "handoff", task: "session", verb: "handoff-ingested", detail: handoff.note }],
		});
		await import("node:fs/promises").then((fs) => fs.rm(kit.loop.paths.pendingHandoff, { force: true }));
	}

		// Resume a live rate-limit sleep from a previous run, if any.
	await recomputeSpent(kit);
	const slept = await waitOutSleep(kit);
	if (slept) await recomputeSpent(kit);

	const summary: RunSummaryInfo = { exit: "complete", ranWaves: [], complete: false };

	for (;;) {
		const stateNow = await readSessionState(kit.loop.harness);
		const routerTasks = stateNow.router.tasks;
		if (!options.tasksFilter.length) {
			const done = routerTasks.every((t) => t.status !== "todo" && t.status !== "in_progress");
			if (done) {
				summary.complete = true;
				summary.exit = "complete";
				emit({ kind: "complete", message: "STATUS: COMPLETE — the task queue is empty" });
				await commitState(kit, {
					statusPhase: { phase: "idle", message: "complete" },
					rows: [{ ts: Date.now(), kind: "wave", task: "session", verb: "complete", detail: "queue empty" }],
				});
				break;
			}
		}

		// Budget ceiling first (§4.5): stop the loop before starting another wave.
		const spent = await recomputeSpent(kit);
		if (spent > kit.loop.config.budgets.sessionUsd) {
			summary.exit = "budget";
			emit({ kind: "budget-stop", message: `budget reached at $${spent.toFixed(2)} of $${kit.loop.config.budgets.sessionUsd} — resume with \`run\`` });
			await commitState(kit, {
				rows: [{ ts: Date.now(), kind: "governor", task: "session", verb: "budget-stop", detail: `spent $${spent.toFixed(2)}` }],
				statusPhase: { phase: "idle", message: "budget ceiling" },
			});
			break;
		}

		const task = pickNextTask(routerTasks);
		if (!task) {
			summary.exit = "arrived-blocked";
			emit({ kind: "blocked", message: "remaining tasks are blocked by quarantined dependencies — no runnable task" });
			await commitState(kit, {
				statusPhase: { phase: "idle", message: "blocked by quarantined dependencies" },
			});
			break;
		}
	
		// ---- Per-task wave loop
		const outcome = await driveTaskWaves(kit, task, {
			handoffNote: handoff?.note,
			onEvent: emit,
			deliverExplicit: options.deliverExplicit,
		});
		if (outcome === "sleeping") {
			summary.exit = "sleeping";
			break;
		}
		if (outcome === "budget") {
			summary.exit = "budget";
			break;
		}
		if (options.tasksFilter.length && routerTasks.length) {
			// filtered mode: stop when the filter set is drained
			const remaining = options.tasksFilter.filter((id) => {
				const t = routerTasks.find((x) => x.id === id);
				return t && t.status === "todo";
			}).length;
			if (remaining === 0) {
				summary.complete = true;
				break;
			}
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
			conv = await openTaskConversation(kit, convKit, current);
			await commitState(kit, {
				router: (d) => {
					const t = d.tasks.find((x) => x.id === task.id)!;
					t.convId = conv!.id;
				},
			});
		} else if (wave > 1) {
			// Prior wave failed: reset the context to keep failed debug turns out of the window.
			await conv.reset(undefined, BACKGROUND_CONTEXT);
		}

		const waveInput = assembleWaveInput(current, wave, opts.handoffNote);
		const outcomeWave = await convKit.submitAndAwait(conv, `${task.id}-w${wave}`, waveInput);

		// Budget accumulation per wave.
		await commitState(kit, {
			runStatus: (d) => {
				d.budgetSpentUsd = Math.max(d.budgetSpentUsd, outcomeWave.usage.usd);
			},
		});

		// Run failure paths (§4.2.5 / §4.5).
		if (outcomeWave.status === "unanswered") {
			const reason = outcomeWave.reason ?? "unanswered";
			const handled = await handleUnanswered(kit, current, wave, reason, outcomeWave.detail, outcomeWave.usage.usd);
			if (handled === "sleeping") {
				emit({ kind: "sleeping", taskId: task.id, wave, message: "rate limit — durable sleep armed; rerun `run` to resume (exit 42)" });
				return "sleeping";
			}
			if (handled === "budget") return "budget";
			if (handled === "faulted") {
				await quarantine(kit, current, wave, `run failed: ${reason}`);
				continue;
			}
			continue; // retried wave under the retry limit
		}

		// Gates (§4.3).
		const gate = await runGates(kit, { id: task.id, targetPaths: current.targetPaths });

		// Zero-progress & duplicate-failure breakers (§4.5).
		const filesChanged = await changedFilesVsTree(paths.root, baseline);
		if (filesChanged.length === 0 && !gate.allPassed) {
			await commitState(kit, {
				rows: [{ ts: Date.now(), kind: "governor", task: task.id, wave, verb: "zero-progress-quarantine", detail: "wave changed no files and gates failed" }],
			});
			await quarantine(kit, current, wave, "zero progress: no file changes while gates fail");
			continue;
		}
		if (gate.failHash && gate.failHash === current.lastGateHash) {
			await commitState(kit, {
				rows: [{ ts: Date.now(), kind: "governor", task: task.id, wave, verb: "duplicate-gate-hash-quarantine", detail: gate.failHash.slice(0, 12) }],
			});
			await quarantine(kit, current, wave, "duplicate failure: identical gate failure hash two waves running");
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
						t.feedback.push({ wave, from: "gate", text: gate.feedbackText, ts: Date.now() } satisfies TaskFeedback);
					} else {
						t.status = "quarantined";
					}
				},
				rows: [
					{ ts: Date.now(), kind: "gate", task: task.id, wave, verb: gate.allPassed ? "pass" : "fail", detail: gate.results.map((r) => `${r.name}:${r.passed}`).join(","), reason: gate.scopeBody || undefined },
				],
			});
			emit({
				kind: "gate-result",
				taskId: task.id,
				wave,
				passed: gate.allPassed,
				message: gate.allPassed ? "gates pass" : gate.feedbackText.slice(0, 160),
			});
			if (underLimit) continue; // loop to next wave with structured feedback
			await quarantine(kit, current, wave, "gate failures exhausted the wave retry limit");
			continue;
		}

		// Verifier (§4.4).
		const verdict = await runVerify(kit, {
			id: current.id,
			title: current.title,
			spec: current.spec,
			acceptance: current.acceptance,
			baselineTreeSha: baseline,
			targetPaths: current.targetPaths,
		}, gateSummaryText(gate.results));

		if (verdict.verdict === "approve") {
			await commitState(kit, {
				router: (d) => {
					const t = d.tasks.find((x) => x.id === task.id)!;
					t.status = "done";
					t.waveCount = wave;
				},
				rows: [{ ts: Date.now(), kind: "task", task: task.id, wave, verb: "done", verdict: "approve" }],
				statusPhase: { phase: "idle", message: `${task.id} approved (wave ${wave})` },
			});
			emit({ kind: "task-done", taskId: task.id, wave, message: `${task.id} verified + approved` });
			await runDelivery(kit, task.id, wave, { deliverExplicit: opts.deliverExplicit });
			return "done";
		}

		const canRetry = verdict.verdict === "reject" && underLimit;
		await commitState(kit, {
			router: (d) => {
				const t = d.tasks.find((x) => x.id === task.id)!;
				t.waveCount = wave;
				if (canRetry) t.feedback.push({ wave, from: "verifier", text: verdict.notes, ts: Date.now() } satisfies TaskFeedback);
				else t.status = "quarantined";
			},
			rows: [{ ts: Date.now(), kind: "verdict", task: task.id, wave, verb: `reject:${wave}`, verdict: verdict.verdict, detail: verdict.notes }],
		});
		emit({ kind: "verifier-verdict", taskId: task.id, wave, verdict: verdict.verdict, message: verdict.notes || "(no notes)" });
		if (canRetry) continue;
		await quarantine(kit, current, wave, verdict.verdict === "needs_human" ? "verifier needs a human" : "verifier rejects exhausted the retry limit");
	}
}

/** Open the implementer conversation with role config + guard doc. */
async function openTaskConversation(kit: LoopAndLock, convKit: ConversationKit, task: RouterTask) {
	const role = kit.loop.config.roles.implementer;
	return convKit.createUnit({
		instructions: `${IMPLEMENTER_BRIEF}\n\nKit: ${kit.loop.config.engine.piDurable} · project ${kit.loop.paths.root}`,
		guard: { role: "implementer", targetPaths: task.targetPaths },
		tools: "coding",
		model: { provider: role.provider, modelId: role.modelId, thinkingLevel: role.thinkingLevel },
		maxTurns: kit.loop.config.engine.maxTurns,
	});
}

/**
 * One wave's user message: PROMPT.md + role brief + spec + criteria + feedback
 * of the previous wave + handoff note.
 */
export function assembleWaveInput(task: RouterTask, wave: number, handoffNote?: string): string {
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
		await quarantine(kit, task, wave, `consecutive run failures (${nextCount}/${maxErrors}): ${reason}`);
		return "faulted";
	}
	await commitState(kit, {
		rows,
		router: (d) => {
			const t = d.tasks.find((x) => x.id === task.id)!;
			t.waveCount = wave;
			t.feedback.push({ wave, from: "gate", text: `run failed: ${reason}`, ts: Date.now() } satisfies TaskFeedback);
		},
		runStatus: (d) => {
			d.consecutiveErrors = nextCount;
			d.budgetSpentUsd = Math.max(d.budgetSpentUsd, waveUsd);
		},
	});
	return "retried";
}

// ---------------------------------------------------------------------------
// Quarantine (§4.2.7): patch the wave's changes, roll back to baseline
// ---------------------------------------------------------------------------

export async function quarantine(kit: LoopAndLock, task: RouterTask, wave: number, cause: string): Promise<void> {
	const paths = kit.loop.paths;
	const baseline = task.baselineTreeSha;
	let patchFile: string | undefined;
	if (baseline) {
		const artifactName = `quarantined-${task.id}-w${wave}.patch`;
		patchFile = join(paths.artifacts, artifactName);
		try {
			await mkdir(dirname(patchFile), { recursive: true });
			const saved = await savePatch(paths.root, baseline, patchFile);
			if (!saved) patchFile = undefined;
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
		],
		statusPhase: { phase: "idle", message: `${task.id} quarantined: ${cause}` },
	});
}

function artifact(path: string): string {
	return path.split("/").slice(-2).join("/");
}

void appendFile;

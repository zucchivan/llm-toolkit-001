/**
 * Verifier (§4.4): one read-only conversation per verdict. Input: task spec +
 * acceptance criteria + diff stat vs the task's baseline tree + the changed
 * file list + the checked tree / gate ids / non-skipped gate outcomes. Output:
 * STRICT JSON verdict, parsed defensively; malformed JSON, prose around the
 * JSON, or an unparseable reply is `needs_human`, never a silent approve.
 * beforeTool guard blocks anything but `read` (belt & suspenders over the
 * `[read]`-only tool selection).
 *
 * M0-P11: criterion evidence is enforced SYMMETRICALLY. An approving verdict —
 * primary or skeptic — must mark every reviewed criterion pass and cite valid
 * evidence against the checked tree (an executed, non-scope, non-skipped
 * passing gate, or an existing line in a safe text blob). Each pass is
 * committed (pass receipt + verdict row) BEFORE the next pass is dispatched.
 */
import { captureBaselineTree, diffStatVsTree, computeDisplayPatch, diffDisplayTrees } from "../util/git.ts";
import { runGit } from "../util/git-objects.ts";
import { ConversationKit } from "./conversations.ts";
import { idOfConversation } from "./kit.ts";
import type { LoopAndLock } from "./harness.ts";
import { commitState } from "./state.ts";
import type { GateResult } from "./gates.ts";
import { passReceiptEvent } from "./receipts.ts";
import type { Checkpoint, GateCheck, ReviewPass, VerifierPolicy } from "./receipts.ts";
import {
	citableGateIds, enforceCriterionEvidence, reviewPass,
	type CriterionEvidenceContext, type CriterionReply,
} from "./review.ts";
import type { WaveRow } from "./infos.ts";
import {
	assessVerifier, persistVerifierAssessment,
	type AssessVerifierOptions, type VerifierObservation,
} from "./verifier-assessment.ts";
import type { ExecutionContext, TaskExecutionContext, TaskReadContext } from "./workspace.ts";
import {
	admitSubmission, BudgetAdmissionError, isBudgetDenial, recordBudgetStop, type AdmissionCheckpoint,
} from "./model-admission.ts";

export type Verdict = "approve" | "reject" | "needs_human";

export interface VerifyResult {
	verdict: Verdict;
	criteria: CriterionReply[];
	notes: string;
}

export const VERIFY_ROLE_BRIEF = `You are the VERIFIER of an implementation-loop kit. You are read-only: you will never edit files.
Judge whether the wave's changes implement the task spec and satisfy every acceptance criterion.

Read files if you need to (you have the read tool). Then reply with ONE JSON object and nothing else:

{
  "verdict": "approve" | "reject" | "needs_human",
  "criteria": [{ "id": "<criterion number, 1-based>", "status": "pass" | "fail" | "unverifiable",
                 "evidence": [{ "kind": "gate", "id": "<citable gate id>" }] or [{ "kind": "line", "path": "<project-relative file>", "line": <1-based line> }] }],
  "notes": "<= 300 chars; concrete blockers when rejecting"
}

approve = every criterion passes, each citing at least one valid evidence reference AGAINST THE CHECKED
TREE: a gate that actually ran, was not skipped, and passed (the scope check alone is never criterion
evidence), or a line that exists in a regular text file on the checked tree. Scope alone is not
criterion evidence. An approval with missing, malformed, duplicated, or invalid references is refused
and degrades to needs_human. reject = a criterion fails and is fixable by another wave; the notes must
say exactly what to change (no evidence required). needs_human = you cannot judge from the diff/spec
(ambiguous spec, design decision, credentials, flaky external). Never approve on partial evidence.`;

export const SKEPTIC_ROLE_BRIEF = `You are the ADVERSARIAL VERIFIER of an implementation-loop kit. You are read-only: you will never edit files.
Assume the primary verifier missed a subtle defect. Try to refute approval rather than repeating its reasoning.

Independently check every acceptance criterion and look for regressions, edge cases, missing tests,
changes outside the task's target paths, and security or data-loss risks. Read any files you need with
the read tool. Then reply with ONE JSON object and nothing else:

{
  "verdict": "approve" | "reject" | "needs_human",
  "criteria": [{ "id": "<criterion number, 1-based>", "status": "pass" | "fail" | "unverifiable",
                 "evidence": [{ "kind": "gate", "id": "<citable gate id>" }] or [{ "kind": "line", "path": "<project-relative file>", "line": <1-based line> }] }],
  "notes": "<= 300 chars; concrete blockers when rejecting"
}

approve only after independently confirming that every acceptance criterion passes — each with valid
evidence against the checked tree (an executed, non-scope, non-skipped passing gate, or an existing
line in a regular text file there) — and finding no refutation. An approval with missing, malformed,
duplicated, or invalid references is refused and degrades to needs_human. reject a fixable defect and
say exactly what to change. needs_human is mandatory when evidence is missing, ambiguous, or
inconclusive. Incomplete or unverifiable criteria can never approve.`;

export interface VerifyTask {
	id: string;
	title: string;
	spec: string;
	acceptance: string[];
	baselineTreeSha: string;
	targetPaths: string[];
}

/** Diff vs baseline (so uncommitted prior waves never bleed into this verdict). */
async function diffVsBaseline(root: string, baseline: string): Promise<{ stat: string; files: string[]; display?: Awaited<ReturnType<typeof diffDisplayTrees>> }> {
	const stat = await diffStatVsTree(root, baseline);
	const list = await runGit(root, ["diff", "--name-only", "--no-ext-diff", "--no-textconv", baseline], { timeoutMs: 30_000 });
	return { stat, files: (list.stdout || "").trim().split("\n").filter(Boolean) };
}

async function diffForTaskContext(context: TaskExecutionContext | TaskReadContext): Promise<{ stat: string; files: string[]; display: Awaited<ReturnType<typeof diffDisplayTrees>> }> {
	const display = await diffDisplayTrees(context.controlPaths.root, context.startOid, context.candidateOid);
	return {
		stat: display.stats.files.map((file) => `${file.path} (+${file.insertions}/-${file.deletions}${file.binary ? ", binary" : ""})`).join("\n"),
		files: display.stats.files.map((file) => file.path),
		display,
	};
}

/** The checked tree + gate receipt binding both read-only passes receive. */
export interface GateEvidenceInput {
	/** The tree the gate receipt recorded (the frozen candidate in the serial driver). */
	tree: string;
	/** The gate receipt id the pass receipts bind to. */
	gateId: string;
	checks: readonly GateCheck[];
}

export type VerifyPassName = "primary" | "skeptic";
export type VerifySubmissionRecovery = { conversationId: number; submissionKey: string };

export interface VerifyOptions {
	skepticSecondPass?: boolean;
	/** Host-issued roots and immutable candidate; omitted only by legacy direct unit callers. */
	executionContext?: ExecutionContext;
	/** The gate receipt's checked tree + checks; omitted on the one-off diagnostic
	 *  path, where no gate receipts exist and no gate reference can be evidence. */
	gateEvidence?: GateEvidenceInput;
	/** Wave identity for durable pass receipts (M0-P11). The one-off diagnostic
	 *  verify owns its operation key and never records a fictitious wave. */
	waveIdentity?: { planRevision: string; wave: number };
	/** Previously committed pass receipts for this exact candidate; these are never dispatched again. */
	existingPasses?: Partial<Record<VerifyPassName, ReviewPass>>;
	/** Checkpointed conversation/request tuples used to reconcile an interrupted submission. */
	submissionRecovery?: Partial<Record<VerifyPassName, VerifySubmissionRecovery>>;
	/** Stable request identities for a new pass; required wave callers derive these from the checkpoint key. */
	submissionKeys?: Partial<Record<VerifyPassName, string>>;
	/** Persist the conversation/request tuple before the first submit call (and
	 *  again with the new key when a terminal failure is resubmitted). */
	onSubmissionPrepared?: (pass: VerifyPassName, conversationId: number, submissionKey: string) => Promise<void>;
	/** Mint the NEW request identity for a resubmitted pass after its checkpointed
	 *  request reconciled to a terminal failure (never reusing that key). */
	resubmitAttemptKey?: (pass: VerifyPassName, baseKey: string) => string;
	/** Atomically checkpoint a committed pass receipt with its reviewed outcome. */
	checkpointForPass?: (pass: VerifyPassName, conversationId: number, submissionKey: string, result: VerifyResult) => Checkpoint;
	/** Runs after the pass receipt commits and before another pass is dispatched. */
	afterPassCommitted?: (pass: VerifyPassName) => Promise<void>;
	/** Optional injection seam; config supplies the default opt-in and env supplies credentials. */
	jevShadow?: Omit<AssessVerifierOptions, "enabled"> & { enabled?: boolean };
}

/**
 * Run the read-only verifier pass(es) for one checked tree.
 *
 * M0-P18: this records REVIEW HISTORY only — pass receipts and verdict rows. It
 * never writes a task status, never clears a `blockReason`, never records an
 * acceptance and never advances the integration ref, so a one-off
 * `verify --task` cannot mark a task done or unblock a dependent. Only the
 * driver (`run`) or an explicit human decision (`resolve`) may do that.
 */
export async function runVerify(kit: LoopAndLock, task: VerifyTask, gateSummary: string, options: VerifyOptions = {}): Promise<VerifyResult> {
	const executionContext = options.executionContext;
	if (executionContext && executionContext.controlPaths.root !== kit.loop.paths.root) throw new Error("execution context control root does not match the open project harness");
	const taskContext = executionContext?.kind === "task-execution" || executionContext?.kind === "task-read" ? executionContext : undefined;
	if (taskContext && taskContext.taskId !== task.id) throw new Error(`verifier task ${task.id} does not match execution context task ${taskContext.taskId}`);
	if (options.waveIdentity && !options.gateEvidence) throw new Error("wave verification requires the gate receipt binding — pass receipts bind to the checked tree and gate");
	const controlRoot = executionContext?.controlPaths.root ?? kit.loop.paths.root;
	const diff = taskContext ? await diffForTaskContext(taskContext) : await diffVsBaseline(controlRoot, task.baselineTreeSha);
	const skepticSecondPass = options.skepticSecondPass ?? kit.loop.config.gates.skepticSecondPass;
	const jevShadowEnabled = options.jevShadow?.enabled ?? kit.loop.config.gates.jevVerifierShadow;
	const policy: VerifierPolicy = skepticSecondPass ? "always" : "never";

	// The checked tree both passes receive independently: the frozen candidate on
	// task execution/read contexts, the gate receipt's tree on wave callers, or an
	// explicit capture only for legacy direct unit callers.
	const checkedTree = taskContext
		? taskContext.candidateOid
		: options.gateEvidence?.tree ?? (await captureBaselineTree(controlRoot));
	if (options.gateEvidence && taskContext && options.gateEvidence.tree !== taskContext.candidateOid) {
		throw new Error("gate evidence tree does not match the execution context candidate");
	}
	const evidenceContext: CriterionEvidenceContext = {
		root: controlRoot,
		checkedTree,
		checks: options.gateEvidence?.checks ?? [],
	};
	const gateBlock = options.gateEvidence
		? [
				`CHECKED TREE (every evidence reference must resolve against this tree): ${checkedTree}`,
				`GATE RECEIPT: ${options.gateEvidence.gateId}`,
				`GATE CHECKS: ${formatGateChecks(evidenceContext.checks) || "(none)"}`,
				`CITABLE GATE IDS (executed, non-scope, non-skipped, passed): ${citableGateIds(evidenceContext.checks).join(", ") || "(none)"}`,
			].join("\n")
		: [
				`CHECKED TREE (every evidence reference must resolve against this tree): ${checkedTree}`,
				`GATE CHECKS: none — this pass has no gate receipts, so gate references cannot be evidence`,
				`CITABLE GATE IDS: (none)`,
			].join("\n");

	const content = [
		`TASK ${task.id}: ${task.title}`,
		`SPEC:\n${task.spec}`,
		`AIMED AT PATHS: ${task.targetPaths.length ? task.targetPaths.join(", ") : "(whole repo)"}`,
		`ACCEPTANCE CRITERIA:\n${task.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}`,
		`DIFF VS BASELINE (${task.baselineTreeSha.slice(0, 12)}) STAT:\n${diff.stat || "(no file content changes)"}`,
		`CHANGED FILES: ${diff.files.slice(0, 40).join(", ") || "(none)"}`,
		gateBlock,
		`Reply with the verdict JSON now.`,
	].join("\n\n");

	const kitConv = new ConversationKit(kit, kit.loop.toolBox);
	const role = kit.loop.config.roles.verifier;
	const refuse = (reason: string): VerifyResult => ({
		verdict: "needs_human",
		criteria: [],
		notes: `approval refused: ${reason}`.slice(0, 300),
	});
	const reviewResult = (review: ReviewPass): VerifyResult => ({
		verdict: review.verdict,
		criteria: review.criteria.map((criterion) => ({ ...criterion, malformed: false })),
		notes: review.notes,
	});
	const bufferedRows: WaveRow[] = [];
	const persistPass = async (
		pass: VerifyPassName,
		result: VerifyResult,
		usage: { usd: number; totalTokens: number },
		conversationId: number,
		submissionKey: string,
	): Promise<void> => {
		const row: WaveRow = {
			ts: Date.now(),
			kind: "verdict",
			task: task.id,
			verb: pass === "primary" ? `verify:${result.verdict}` : `verify:skeptic:${result.verdict}`,
			verdict: result.verdict,
			detail: result.notes,
			provider: role.provider,
			modelId: role.modelId,
			costUsd: usage.usd,
			tokens: usage.totalTokens,
			...(options.waveIdentity ? { planRevision: options.waveIdentity.planRevision } : {}),
		};
		if (!options.waveIdentity || !options.gateEvidence) {
			bufferedRows.push(row); // one-off diagnostic verify: rows only, no receipts
			return;
		}
		const wave = { planRevision: options.waveIdentity.planRevision, taskId: task.id, wave: options.waveIdentity.wave };
		const event = passReceiptEvent(wave, {
			tree: checkedTree,
			gateId: options.gateEvidence.gateId,
			policy,
			review: reviewPass(pass, result, conversationId),
		});
		row.receipt = event.opId;
		const checkpoint = options.checkpointForPass?.(pass, conversationId, submissionKey, result);
		await commitState(kit, {
			receipts: [event],
			rows: [row],
			...(checkpoint ? { checkpoints: [checkpoint] } : {}),
		});
	};
	const passPrompt = (pass: VerifyPassName) => pass === "primary" ? VERIFY_ROLE_BRIEF : SKEPTIC_ROLE_BRIEF;
	// M0-P16: every pass is a paid submission under the single admission gate.
	const checkpointCtx = (): AdmissionCheckpoint => ({
		planRevision: options.waveIdentity?.planRevision,
		taskId: task.id,
		wave: options.waveIdentity?.wave,
	});
	const admitPass = async (pass: VerifyPassName): Promise<void> => {
		const stage = options.waveIdentity ? pass : "verify";
		const admission = await admitSubmission(kit, stage, checkpointCtx());
		if (!admission.admitted) throw new BudgetAdmissionError(admission.reason);
	};
	let fallbackAttempt = 0;
	const runPass = async (pass: VerifyPassName): Promise<VerifyResult> => {
		const recovery = options.submissionRecovery?.[pass];
		let submissionKey = recovery?.submissionKey ?? options.submissionKeys?.[pass] ?? `verify-${task.id}-${pass}-${Date.now()}`;
		let conv = recovery ? await kitConv.find(recovery.conversationId) : undefined;
		if (recovery && !conv) throw new Error(`checkpointed ${pass} verifier conversation ${recovery.conversationId} is unavailable; refusing a new submission`);
		conv ??= await kitConv.createUnit({
			instructions: passPrompt(pass),
			guard: { role: "verifier", targetPaths: [] },
			tools: "read",
			model: { provider: role.provider, modelId: role.modelId, thinkingLevel: role.thinkingLevel },
			maxTurns: kit.loop.config.engine.maxTurns,
			executionContext,
		});
		const conversationId = idOfConversation(conv);
		if (!recovery) {
			await options.onSubmissionPrepared?.(pass, conversationId, submissionKey);
			// M0-P16: a FRESH pass is admitted before its first call.
			await admitPass(pass);
		}
		let outcome = await kitConv.submitAndAwait(conv, submissionKey, content);
		if (recovery && outcome.status === "unanswered") {
			// Reconcile-first: the same request was reacquired by its exact
			// identity. A TERMINAL failure under it — a model error or a past
			// budget denial — is never replayed and its key is never reused:
			// checkpoint a NEW submission attempt for THIS pass only (prior usage
			// stays counted) and dispatch it. Whether the pause still holds is
			// the admission's call: it refuses (recording the stop) while the
			// ceiling is still breached and admits after the human raises it.
			const newKey = options.resubmitAttemptKey?.(pass, submissionKey) ?? `${submissionKey}#r${++fallbackAttempt}`;
			submissionKey = newKey;
			await options.onSubmissionPrepared?.(pass, conversationId, submissionKey);
			await admitPass(pass);
			outcome = await kitConv.submitAndAwait(conv, submissionKey, content);
		}
		if (outcome.status === "unanswered" && (isBudgetDenial(outcome.detail) || isBudgetDenial(outcome.reason))) {
			// A denial inside the pass (next tool follow-up, SDK retry, or
			// compaction dispatch paused by the guard) is a budget pause — never
			// a model failure and never a verdict: no pass receipt is written.
			const reason = await recordBudgetStop(kit, options.waveIdentity ? pass : "verify", checkpointCtx(), "a provider dispatch inside the pass was paused by budget admission (tool follow-up, retry, or compaction)");
			throw new BudgetAdmissionError(reason);
		}
		const raw = parseVerdictStrict(outcome.answer ?? "");
		const result = await enforceCriterionEvidence(raw, task.acceptance, evidenceContext, refuse);
		await persistPass(pass, result, outcome.usage, conversationId, submissionKey);
		await options.afterPassCommitted?.(pass);
		return result;
	};
	const primary = options.existingPasses?.primary
		? reviewResult(options.existingPasses.primary)
		: await runPass("primary");
	let parsed = primary;
	let skepticResult: VerifyResult | undefined;
	// A fresh skeptic only follows a conclusive approving primary. Existing
	// receipts are reused; a checkpointed submission is reacquired by its exact
	// conversation/request identity rather than dispatched a second time.
	if (skepticSecondPass && primary.verdict === "approve") {
		skepticResult = options.existingPasses?.skeptic
			? reviewResult(options.existingPasses.skeptic)
			: await runPass("skeptic");
		if (skepticResult.verdict !== "approve") parsed = { ...skepticResult, notes: `skeptic pass: ${skepticResult.notes}`.slice(0, 300) };
	}

	if (bufferedRows.length) await commitState(kit, { rows: bufferedRows });
	if (jevShadowEnabled) {
		// Even an unexpected shadow implementation/persistence fault cannot escape
		// into wave control flow after the authoritative verdict has committed.
		await runShadowAssessment(kit, task, diff, gateSummary, primary, skepticResult, options.jevShadow, executionContext).catch(() => {});
	}
	return parsed;
}

/** Best-effort provenance after the real verdict commit; no result feeds control flow. */
async function runShadowAssessment(
	kit: LoopAndLock,
	task: VerifyTask,
	diff: { stat: string; files: string[]; display?: Awaited<ReturnType<typeof diffDisplayTrees>> },
	gateSummary: string,
	primary: VerifyResult,
	skeptic: VerifyResult | undefined,
	options: VerifyOptions["jevShadow"],
	executionContext?: ExecutionContext,
): Promise<void> {
	let patch = { text: "", truncated: false, available: false };
	try {
		const frozenContext = executionContext?.kind === "task-execution" || executionContext?.kind === "task-read" ? executionContext : undefined;
		const display = diff.display ?? (frozenContext
			? await diffDisplayTrees(frozenContext.controlPaths.root, frozenContext.startOid, frozenContext.candidateOid)
			: await computeDisplayPatch(executionContext?.controlPaths.root ?? kit.loop.paths.root, task.baselineTreeSha));
		patch = { text: display.text, truncated: display.truncated, available: display.ok };
	} catch {
		// Diff evidence degrades to the summary; the existing verdict is already durable.
	}
	const observation = (result: VerifyResult): VerifierObservation => ({
		verdict: result.verdict, criteria: result.criteria, notes: result.notes,
	});
	const assessment = await assessVerifier({
		task,
		diff: {
			stat: diff.stat, files: diff.files, patch: patch.text,
			patchTruncated: patch.truncated, patchAvailable: patch.available,
		},
		gateSummary,
		primary: observation(primary),
		...(skeptic ? { skeptic: observation(skeptic) } : {}),
	}, {
		...options,
		enabled: true,
		apiKey: options?.apiKey ?? process.env["TYPESAFE_API_KEY"],
	});
	if (assessment.status === "assessed") {
		await persistVerifierAssessment(executionContext?.controlPaths.root ?? kit.loop.paths.root, assessment).catch(() => {});
	}
}

/** One-line-per-check rendering for the verifier prompt (outcomes, not output). */
function formatGateChecks(checks: readonly GateCheck[]): string {
	return checks
		.map((c) => `${c.id}: ${c.outcome}${c.exit !== null ? ` (exit ${c.exit})` : ""}`)
		.join("; ");
}

/** Defensive parse: ONE optional code fence; malformed → needs_human (never
 *  approve). Prose around the JSON is rejected. Reply criteria entries map 1:1
 *  — malformed entries are preserved with `malformed: true`, never filtered. */
export function parseVerdictStrict(text: string): VerifyResult {
	const failed: VerifyResult = {
		verdict: "needs_human",
		criteria: [],
		notes: "verifier reply was not the expected JSON verdict — check .orch/artifacts and the wave log",
	};
	try {
		let cleaned = text.trim();
		if (cleaned.startsWith("```")) {
			cleaned = cleaned
				.replace(/^```(?:json)?[ \t]*\r?\n?/i, "")
				.replace(/\r?\n?```[ \t]*$/i, "")
				.trim();
		}
		// No prose around the JSON: the reply must be exactly one object.
		if (!cleaned.startsWith("{") || !cleaned.endsWith("}")) return failed;
		const raw = JSON.parse(cleaned) as {
			verdict?: unknown;
			criteria?: unknown;
			notes?: unknown;
		};
		if (raw.verdict !== "approve" && raw.verdict !== "reject" && raw.verdict !== "needs_human") {
			throw new Error("verdict is not one of approve|reject|needs_human");
		}
		const criteria = Array.isArray(raw.criteria)
			? (raw.criteria as unknown[]).map((c): CriterionReply => {
					if (typeof c !== "object" || c === null || Array.isArray(c)) {
						return { id: "", status: "unverifiable", evidence: [], malformed: true };
					}
					const o = c as { id?: unknown; status?: unknown; evidence?: unknown };
					const id = typeof o["id"] === "string" ? o["id"] : "";
					const status: CriterionReply["status"] = o["status"] === "pass" || o["status"] === "fail" || o["status"] === "unverifiable"
						? o["status"]
						: "unverifiable";
					let malformed = id === "" || o["status"] !== status;
					const evidence: CriterionReply["evidence"] = [];
					if (o["evidence"] !== undefined) {
						if (Array.isArray(o["evidence"])) {
							for (const ref of o["evidence"] as unknown[]) {
								const parsedRef = parseEvidenceRef(ref);
								if (parsedRef) evidence.push(parsedRef);
								else malformed = true;
							}
						} else malformed = true;
					}
					return { id, status, evidence, malformed };
				})
			: [];
		return {
			verdict: raw.verdict,
			criteria,
			notes: typeof raw.notes === "string" ? raw.notes.slice(0, 300) : "",
		};
	} catch {
		return failed;
	}
}

function parseEvidenceRef(ref: unknown): CriterionReply["evidence"][number] | undefined {
	if (typeof ref !== "object" || ref === null || Array.isArray(ref)) return undefined;
	const o = ref as { kind?: unknown; id?: unknown; path?: unknown; line?: unknown };
	if (o["kind"] === "gate" && typeof o["id"] === "string" && o["id"].length > 0) {
		return { kind: "gate", id: o["id"] };
	}
	if (
		o["kind"] === "line" && typeof o["path"] === "string" && o["path"].length > 0
		&& typeof o["line"] === "number" && Number.isSafeInteger(o["line"]) && o["line"] >= 1
	) {
		return { kind: "line", path: o["path"], line: o["line"] };
	}
	return undefined;
}

/** Compact one-line gate summary for the verifier prompt. */
export function gateSummaryText(results: readonly GateResult[]): string {
	return results
		.filter((r) => !r.skipped)
		.map((r) => `${r.name}: ${r.passed ? "pass" : "fail"}`)
		.join(", ");
}

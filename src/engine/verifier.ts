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
import { exec } from "../util/exec.ts";
import { captureBaselineTree, diffStatVsTree, computeDisplayPatch, diffDisplayTrees } from "../util/git.ts";
import { ConversationKit } from "./conversations.ts";
import { idOfConversation } from "./kit.ts";
import type { LoopAndLock } from "./harness.ts";
import { commitState } from "./state.ts";
import type { GateResult } from "./gates.ts";
import { passReceiptEvent } from "./receipts.ts";
import type { GateCheck, VerifierPolicy } from "./receipts.ts";
import {
	citableGateIds, enforceCriterionEvidence, reviewPass,
	type CriterionEvidenceContext, type CriterionReply,
} from "./review.ts";
import type { WaveRow } from "./infos.ts";
import {
	assessVerifier, persistVerifierAssessment,
	type AssessVerifierOptions, type VerifierObservation,
} from "./verifier-assessment.ts";
import type { ExecutionContext, TaskExecutionContext } from "./workspace.ts";

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
	const list = await exec(["git", "diff", "--name-only", baseline], { cwd: root, timeoutMs: 30_000 });
	return { stat, files: (list.stdout || "").trim().split("\n").filter(Boolean) };
}

async function diffForTaskContext(context: TaskExecutionContext): Promise<{ stat: string; files: string[]; display: Awaited<ReturnType<typeof diffDisplayTrees>> }> {
	const display = await diffDisplayTrees(context.controlPaths.root, context.startOid, context.candidateOid);
	return {
		stat: display.stats.files.map((file) => `${file.path} (+${file.insertions}/-${file.deletions}${file.binary ? ", binary" : ""})`).join("\n"),
		files: display.stats.files.map((file) => file.path),
		display,
	};
}

/** The checked tree + gate receipt binding both read-only passes receive. */
export interface GateEvidenceInput {
	/** The tree the gate receipt recorded (the candidate on prepared contexts). */
	tree: string;
	/** The gate receipt id the pass receipts bind to. */
	gateId: string;
	checks: readonly GateCheck[];
}

export interface VerifyOptions {
	skepticSecondPass?: boolean;
	/** Host-issued roots and immutable candidate; omitted only on the trusted compatibility path. */
	executionContext?: ExecutionContext;
	/** The gate receipt's checked tree + checks; omitted on the one-off diagnostic
	 *  path, where no gate receipts exist and no gate reference can be evidence. */
	gateEvidence?: GateEvidenceInput;
	/** Wave identity for durable pass receipts (M0-P11). The one-off diagnostic
	 *  verify owns its operation key and never records a fictitious wave. */
	waveIdentity?: { planRevision: string; wave: number };
	/** Optional injection seam; config supplies the default opt-in and env supplies credentials. */
	jevShadow?: Omit<AssessVerifierOptions, "enabled"> & { enabled?: boolean };
}

export async function runVerify(kit: LoopAndLock, task: VerifyTask, gateSummary: string, options: VerifyOptions = {}): Promise<VerifyResult> {
	const executionContext = options.executionContext;
	if (executionContext && executionContext.controlPaths.root !== kit.loop.paths.root) throw new Error("execution context control root does not match the open project harness");
	const taskContext = executionContext?.kind === "task-execution" ? executionContext : undefined;
	if (taskContext && taskContext.taskId !== task.id) throw new Error(`verifier task ${task.id} does not match execution context task ${taskContext.taskId}`);
	if (options.waveIdentity && !options.gateEvidence) throw new Error("wave verification requires the gate receipt binding — pass receipts bind to the checked tree and gate");
	const controlRoot = executionContext?.controlPaths.root ?? kit.loop.paths.root;
	const diff = taskContext ? await diffForTaskContext(taskContext) : await diffVsBaseline(controlRoot, task.baselineTreeSha);
	const skepticSecondPass = options.skepticSecondPass ?? kit.loop.config.gates.skepticSecondPass;
	const jevShadowEnabled = options.jevShadow?.enabled ?? kit.loop.config.gates.jevVerifierShadow;
	const policy: VerifierPolicy = skepticSecondPass ? "always" : "never";

	// The checked tree both passes receive independently: the frozen candidate on
	// prepared contexts, the gate receipt's tree on the wave loop, and a fresh
	// capture for the one-off diagnostic verify (trusted pre-cutover behavior).
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
	const conv = await kitConv.createUnit({
		instructions: VERIFY_ROLE_BRIEF,
		guard: { role: "verifier", targetPaths: [] },
		tools: "read",
		model: { provider: role.provider, modelId: role.modelId, thinkingLevel: role.thinkingLevel },
		maxTurns: kit.loop.config.engine.maxTurns,
		executionContext,
	});
	const outcome = await kitConv.submitAndAwait(conv, `verify-${task.id}-${Date.now()}`, content);
	const refuse = (reason: string): VerifyResult => ({
		verdict: "needs_human",
		criteria: [],
		notes: `approval refused: ${reason}`.slice(0, 300),
	});
	const primaryRaw = parseVerdictStrict(outcome.answer ?? "");
	// Symmetric enforcement (M0-P11): the primary approval must prove every criterion too.
	const primary = await enforceCriterionEvidence(primaryRaw, task.acceptance, evidenceContext, refuse);
	let parsed = primary;
	let skepticResult: VerifyResult | undefined;
	// Each pass is persisted BEFORE the next pass is dispatched (M0-P11): the
	// pass receipt + its verdict row commit in one state commit.
	const persistPass = async (pass: "primary" | "skeptic", result: VerifyResult, usage: { usd: number; totalTokens: number }, conversationId: number, buffered: WaveRow[]): Promise<void> => {
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
		};
		if (!options.waveIdentity || !options.gateEvidence) {
			buffered.push(row); // one-off diagnostic verify: rows only, no receipts
			return;
		}
		const event = passReceiptEvent(
			{ planRevision: options.waveIdentity.planRevision, taskId: task.id, wave: options.waveIdentity.wave },
			{
				tree: checkedTree,
				gateId: options.gateEvidence.gateId,
				policy,
				review: reviewPass(pass, result, conversationId),
			},
		);
		row.receipt = event.opId;
		await commitState(kit, { receipts: [event], rows: [row] });
	};
	const bufferedRows: WaveRow[] = [];
	await persistPass("primary", primary, outcome.usage, idOfConversation(conv), bufferedRows);

	// Default-on defense in depth: approval requires a second, fresh read-only
	// conversation — and it is only dispatched after a CONCLUSIVE, evidence-valid
	// primary approval (never after an invalid or nonapproving primary). Its own
	// verdict and usage stay visible in the wave log.
	if (skepticSecondPass && primary.verdict === "approve") {
		const convTwo = await kitConv.createUnit({
			instructions: SKEPTIC_ROLE_BRIEF,
			guard: { role: "verifier", targetPaths: [] },
			tools: "read",
			model: { provider: role.provider, modelId: role.modelId, thinkingLevel: role.thinkingLevel },
			maxTurns: kit.loop.config.engine.maxTurns,
			executionContext,
		});
		const outcomeTwo = await kitConv.submitAndAwait(convTwo, `verify-${task.id}-skeptic-${Date.now()}`, content);
		const rawTwo = parseVerdictStrict(outcomeTwo.answer ?? "");
		skepticResult = await enforceCriterionEvidence(rawTwo, task.acceptance, evidenceContext, refuse);
		await persistPass("skeptic", skepticResult, outcomeTwo.usage, idOfConversation(convTwo), bufferedRows);
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
		const display = diff.display ?? (executionContext?.kind === "task-execution"
			? await diffDisplayTrees(executionContext.controlPaths.root, executionContext.startOid, executionContext.candidateOid)
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

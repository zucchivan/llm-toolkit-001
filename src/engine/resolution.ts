/**
 * Binding human resolution (M0-P18, §3 "Human path").
 *
 * The ONLY command that turns a blocked (`quarantined`) task back into work, and
 * the only place a human — not a model — may authorize a candidate tree. It
 * never bypasses a guard:
 *
 *  - `--retry` opens ONE fresh retry cycle for the task: it requeues from the
 *    CURRENT accepted head (never the failed candidate), keeps the wave history
 *    and every earlier receipt, clears the duplicate-failure hash / transport
 *    counters / this task's durable sleep counter, and dispatches NOTHING — the
 *    next authorized `run` does the work. It needs the current revision, the
 *    stored grant that covers the task, a quarantined task with a sealed
 *    (terminal) checkpoint, a `discarded` rollback receipt, an unchanged
 *    accepted integration head and an observed-absent workspace lease.
 *  - `--accept-tree <oid>` is ONLY for an inconclusive `needs_human` quarantine
 *    with a retained candidate: the tree must be the wave's pinned candidate,
 *    lineage (accepted head, parent) and the reviewed control bundle unchanged,
 *    the operator's evidence file must prove every reviewed criterion against
 *    the rerun gate receipt, and the deterministic gates must be rerun on the
 *    exact candidate and ALL pass. It records a HUMAN acceptance receipt
 *    (`authority: "human"`, policy `human-v1`) and drives LOCAL integration; it
 *    never publishes — `commit`/`pr` publication still needs an authorized
 *    `run`/resume with `--deliver` where the mode requires it.
 *
 * Both actions derive a DETERMINISTIC operation id from the request identity +
 * tree + reason/evidence digest, so replaying the same request (a crash between
 * commit and integration, or an operator rerunning the command) reconciles to
 * the recorded decision instead of minting a second one. A blocked request
 * throws `ResolutionRefusal` with the remedy; nothing is written.
 *
 * Neither action edits the operator checkout, force-dones a task, replays a
 * truncated quarantine patch, or delivers remotely.
 */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { assertGitOid, readCommit, readRef, resolveTree } from "../util/git-objects.ts";
import { BACKGROUND_CONTEXT } from "./kit.ts";
import type { LoopAndLock } from "./harness.ts";
import { createTaskControls } from "./controls.ts";
import { gateCheckFromResult, gateReceiptEvent, latestJournalEvent, ReceiptsDoc, receiptKey } from "./receipts.ts";
import type {
	AcceptanceReceipt,
	Checkpoint,
	ReceiptEvent,
	ReceiptsDocValue,
	Resolution,
	ReviewPass,
	WaveKey,
} from "./receipts.ts";
import { readGrant, readSessionState, commitState } from "./state.ts";
import type { ReceiptAttempt } from "./state.ts";
import { recipeBundleFromTree, runGates } from "./gates.ts";
import type { GateOutcome } from "./gates.ts";
import { toCriterionResult, validateApprovingCriteria } from "./review.ts";
import type { CriterionReply } from "./review.ts";
import { hostExecArgv } from "./recipe-runner.ts";
import {
	createTaskExecutionContext,
	discard,
	fenceWorkspace,
	inspectCheckpointedWorkspace,
	materializeRead,
	openTask,
} from "./workspace.ts";
import type { TaskExecutionContext, ReadWorkspace } from "./workspace.ts";
import { canonicalSha256, controlsBindingRefusal, loadPlanControls, reviewBindingRefusal } from "./plans.ts";
import type { PlanIdentity } from "./plans.ts";
import { integrateAcceptedCandidate } from "./delivery.ts";
import type { RouterTask, WaveRow } from "./infos.ts";

/** A blocked human resolution: the message always carries the remedy. */
export class ResolutionRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ResolutionRefusal";
	}
}

/** Operator reason bounds (§3: a local, human-attributable sentence). */
export const RESOLUTION_REASON_MIN = 1;
export const RESOLUTION_REASON_MAX = 300;
/** Evidence file bounds: a small local JSON document, never a patch. */
export const RESOLUTION_EVIDENCE_MAX_BYTES = 64 * 1024;

export type ResolutionAction = Resolution["action"];

/** Validated operator evidence: the reviewed-criteria proof plus its digest. */
export type ResolutionEvidence = {
	criteria: CriterionReply[];
	/** Raw file bytes (bounded, regular local file). */
	bytes: Buffer;
	/** SHA256 of those exact bytes (binds the decision to the document). */
	sha256: string;
};

export interface ResolutionRequest {
	/** The `--revision`: must name the CURRENT reviewed plan revision. */
	planRevision: string;
	taskId: string;
	action: ResolutionAction;
	reason: string;
	/** `--accept-tree <oid>`: the retained frozen candidate, accept-tree only. */
	tree?: string;
	/** `--evidence <file>`: required by accept-tree, refused by retry. */
	evidence?: ResolutionEvidence;
}

export interface ResolutionOutcome {
	action: ResolutionAction;
	taskId: string;
	wave: number;
	/** Deterministic operation id (request identity + tree + reason/evidence). */
	operationId: string;
	/** True when this request was already recorded and only reconciled. */
	idempotent: boolean;
	/** accept-tree: the recorded human acceptance receipt id. */
	acceptanceId?: string;
	/** accept-tree: the integration commit the accepted ref names. */
	commit?: string;
	/** What the operator runs next (printed by the CLI). */
	nextSteps: string[];
}

/** `resolve` acts only on a sealed (terminal) checkpoint of a blocked task. */
type BlockedWave = {
	checkpoint: Checkpoint;
	waveKey: WaveKey;
};

// ---------------------------------------------------------------------------
// CLI-side input validation (both forms share these rules)
// ---------------------------------------------------------------------------

/** 1–300 characters of local operator reason (trimmed; no silent clamping). */
export function validateResolutionReason(reason: string): string {
	const trimmed = reason.trim();
	if (trimmed.length < RESOLUTION_REASON_MIN || trimmed.length > RESOLUTION_REASON_MAX) {
		throw new ResolutionRefusal(
			`resolve needs --reason TEXT of ${RESOLUTION_REASON_MIN}–${RESOLUTION_REASON_MAX} characters (the human decision is attributed, never invented)`,
		);
	}
	return trimmed;
}

/**
 * Read and validate `--evidence FILE`: a REGULAR LOCAL JSON file of at most
 * 64 KiB with exactly one top-level key, `{criteria: CriterionResult[]}`.
 * Nothing is guessed: a symlink, a directory, an oversized file, invalid JSON
 * or an unknown top-level key is refused before any state is read.
 */
export async function loadResolutionEvidence(file: string): Promise<ResolutionEvidence> {
	const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!info) throw new ResolutionRefusal(`--evidence ${file} does not exist — write a local JSON document {"criteria":[…]} first`);
	if (info.isSymbolicLink()) throw new ResolutionRefusal(`--evidence ${file} is a symbolic link — evidence must be a regular local file`);
	if (!info.isFile()) throw new ResolutionRefusal(`--evidence ${file} is not a regular file`);
	if (info.size > RESOLUTION_EVIDENCE_MAX_BYTES) {
		throw new ResolutionRefusal(
			`--evidence ${file} is ${info.size} bytes; the evidence document is capped at ${RESOLUTION_EVIDENCE_MAX_BYTES} bytes (it cites proof, it is not a patch)`,
		);
	}
	const bytes = await readFile(file);
	if (bytes.length > RESOLUTION_EVIDENCE_MAX_BYTES) {
		throw new ResolutionRefusal(`--evidence ${file} grew past the ${RESOLUTION_EVIDENCE_MAX_BYTES}-byte cap while being read`);
	}
	const text = bytes.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(bytes)) throw new ResolutionRefusal(`--evidence ${file} is not valid UTF-8`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ResolutionRefusal(`--evidence ${file} is not JSON — expected {"criteria":[{"id":"1","status":"pass","evidence":[…]}]}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ResolutionRefusal(`--evidence ${file} must be a JSON object with a single "criteria" array`);
	}
	const record = parsed as Record<string, unknown>;
	const extra = Object.keys(record).filter((key) => key !== "criteria");
	if (extra.length) throw new ResolutionRefusal(`--evidence ${file} has unknown top-level key(s) ${extra.join(", ")} — only {"criteria":[…]} is accepted`);
	if (!Array.isArray(record["criteria"])) throw new ResolutionRefusal(`--evidence ${file} must carry a "criteria" ARRAY of {id, status, evidence}`);
	return {
		criteria: record["criteria"].map(parseEvidenceCriterion),
		bytes,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

/** Preserve every deviation (never filtered): a malformed entry refuses approval. */
function parseEvidenceCriterion(entry: unknown): CriterionReply {
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
		return { id: "", status: "unverifiable", evidence: [], malformed: true };
	}
	const record = entry as { id?: unknown; status?: unknown; evidence?: unknown };
	const extra = Object.keys(record).filter((key) => key !== "id" && key !== "status" && key !== "evidence");
	const id = typeof record.id === "string" ? record.id : "";
	const status: CriterionReply["status"] =
		record.status === "pass" || record.status === "fail" || record.status === "unverifiable" ? record.status : "unverifiable";
	let malformed = id === "" || record.status !== status || extra.length > 0 || !Array.isArray(record.evidence);
	const evidence: CriterionReply["evidence"] = [];
	if (Array.isArray(record.evidence)) {
		for (const ref of record.evidence) {
			if (ref === null || typeof ref !== "object" || Array.isArray(ref)) {
				malformed = true;
				continue;
			}
			const row = ref as { kind?: unknown; id?: unknown; path?: unknown; line?: unknown };
			const refExtra = Object.keys(row).filter((key) => key !== "kind" && key !== "id" && key !== "path" && key !== "line");
			if (row.kind === "gate" && typeof row.id === "string" && row.id !== "" && refExtra.length === 0) {
				evidence.push({ kind: "gate", id: row.id });
			} else if (
				row.kind === "line" && typeof row.path === "string" && row.path !== ""
				&& typeof row.line === "number" && Number.isSafeInteger(row.line) && row.line >= 1 && refExtra.length === 0
			) {
				evidence.push({ kind: "line", path: row.path, line: row.line });
			} else {
				malformed = true;
			}
		}
	}
	return { id, status, evidence, malformed };
}

// ---------------------------------------------------------------------------
// Operation identity
// ---------------------------------------------------------------------------

/**
 * Deterministic operation id: SHA256 over the canonical request identity.
 * Replaying the same (revision, task, wave, action, tree, reason, evidence)
 * reconciles to the recorded human decision instead of recording a second one.
 */
export function resolutionOperationId(input: {
	planRevision: string;
	taskId: string;
	wave: number;
	action: ResolutionAction;
	reason: string;
	tree?: string;
	evidenceSha256?: string;
}): string {
	return createHash("sha256").update(canonicalSha256({
		domain: "kit:resolution:v1",
		planRevision: input.planRevision,
		taskId: input.taskId,
		wave: input.wave,
		action: input.action,
		reason: input.reason,
		tree: input.tree ?? null,
		evidenceSha256: input.evidenceSha256 ?? null,
	})).digest("hex");
}

function acceptedRef(planRevision: string): string {
	return `refs/kit/${planRevision}/accepted`;
}

function remedyRun(): string {
	return "remedy: fix the named precondition, then rerun `run` (bare resume of the stored grant) or the documented `resolve` form";
}

// ---------------------------------------------------------------------------
// The human path
// ---------------------------------------------------------------------------

/**
 * Apply one binding human resolution. Throws `ResolutionRefusal` (exit 1 with a
 * remedy) on any invalid request; never mutates state before every precondition
 * holds.
 */
export async function runResolution(kit: LoopAndLock, request: ResolutionRequest): Promise<ResolutionOutcome> {
	const root = kit.loop.paths.root;
	const reason = validateResolutionReason(request.reason);
	if (request.action === "retry" && (request.tree !== undefined || request.evidence !== undefined)) {
		throw new ResolutionRefusal("--retry takes no --accept-tree/--evidence: a retry discards, it never accepts a tree");
	}
	if (request.action === "accept-tree" && request.evidence === undefined) {
		throw new ResolutionRefusal(
			"--accept-tree needs --evidence FILE ({\"criteria\":[…]} proving every reviewed criterion against the rerun gates) and --reason TEXT",
		);
	}

	const state = await readSessionState(kit.loop.harness);
	const identity = state.router.identity;
	if (!identity) {
		throw new ResolutionRefusal(
			`this plan has no plan revision (v1 storage) — a human resolution acts only on a reviewed plan: replan (\`plan\`), review router.md, then \`run --approve --revision <uuid>\`; ${remedyRun()}`,
		);
	}
	if (request.planRevision !== identity.planRevision) {
		throw new ResolutionRefusal(
			`--revision ${request.planRevision} does not name the current plan revision ${identity.planRevision} — a human decision binds one reviewed revision; ${remedyRun()}`,
		);
	}
	const task = state.router.tasks.find((entry) => entry.id === request.taskId);
	if (!task) {
		throw new ResolutionRefusal(
			`task ${JSON.stringify(request.taskId)} is not in the current plan (${state.router.tasks.map((entry) => entry.id).join(", ") || "no tasks"}); ${remedyRun()}`,
		);
	}
	const grant = readGrant(state.runStatus);
	if (!grant || grant.planRevision !== identity.planRevision) {
		throw new ResolutionRefusal(
			`plan revision ${identity.planRevision} has no current human grant — a resolution performs no work without matching grant; ${remedyRun()}`,
		);
	}
	if (!grant.selected.includes(task.id)) {
		throw new ResolutionRefusal(
			`task ${task.id} is outside the current grant (${grant.selected.join(", ")}) — a resolution never broadens a grant; approve a grant that includes it: \`run --approve --revision ${identity.planRevision} --tasks ${task.id}\``,
		);
	}
	if (!identity.baseCommit) {
		throw new ResolutionRefusal(`plan revision ${identity.planRevision} has no reviewed base commit — create the seed commit and replan; ${remedyRun()}`);
	}

	const receipts = (await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT)) ?? { version: 1, events: [] };
	const blocked = blockedWave(receipts, identity.planRevision, task.id);
	const { checkpoint, waveKey } = blocked;
	const operationId = resolutionOperationId({
		planRevision: identity.planRevision,
		taskId: task.id,
		wave: checkpoint.wave,
		action: request.action,
		reason,
		...(request.action === "accept-tree" ? { tree: request.tree, evidenceSha256: request.evidence!.sha256 } : {}),
	});
	const prior = receipts.events.find((event): event is Extract<typeof event, { kind: "resolution" }> =>
		event.kind === "resolution" && event.opId === operationId,
	);
	// A REPLAYED request reconciles to the recorded decision; it must not be
	// refused merely because the first application already moved the task on.
	if (prior && request.action === "retry") {
		return {
			action: "retry", taskId: task.id, wave: checkpoint.wave, operationId, idempotent: true,
			nextSteps: [`llm-toolkit-001 run   # resumes the stored grant; ${task.id} starts a fresh wave`],
		};
	}
	// M1-P01 step (d): a NEW human decision may start fresh work (rerun gates on
	// the candidate, a fresh retry cycle), so the reviewed identity must still
	// hold: HEAD, the actual PRD, every evals/** byte, PROMPT.md, approved
	// remediations and the effective policy settings. A recorded decision that
	// is being REPLAYED reconciles its pinned effects instead (no fresh work).
	if (!prior) {
		const bindingRefusal = await reviewBindingRefusal(root, identity, kit.loop.config);
		if (bindingRefusal) throw new ResolutionRefusal(`${bindingRefusal}; ${remedyRun()}`);
	}

	// --- Preconditions shared by both forms: the wave is sealed and recovered.
	if (!prior && task.status !== "quarantined") {
		throw new ResolutionRefusal(
			`task ${task.id} is ${task.status}, not quarantined — resolve acts only on a blocked task (a run stops on it with exit 2); ${remedyRun()}`,
		);
	}
	if (!prior && checkpoint.outcome !== "quarantined") {
		throw new ResolutionRefusal(
			`task ${task.id} wave ${checkpoint.wave} ended ${checkpoint.outcome ?? "(no outcome)"}, not quarantined — nothing to resolve; ${remedyRun()}`,
		);
	}
	if (!checkpoint.candidate) {
		throw new ResolutionRefusal(`task ${task.id} wave ${checkpoint.wave} has no retained frozen candidate — there is nothing to review or retry from; ${remedyRun()}`);
	}
	const acceptedHead = await readRef(root, acceptedRef(identity.planRevision));
	// "Unchanged integration head": the accepted ref either names the wave's
	// recorded parent, or is still ABSENT because the first acceptance lazily
	// creates it at the reviewed base commit (§3 transition 4). A replay of an
	// accepted wave legitimately observes the commit the decision itself created.
	const headUnchanged = acceptedHead === undefined
		? checkpoint.parent === identity.baseCommit
		: acceptedHead === checkpoint.parent || (prior !== undefined && request.action === "accept-tree");
	if (!headUnchanged) {
		throw new ResolutionRefusal(
			`the accepted integration head is ${acceptedHead ?? "absent"}, not the wave's recorded parent ${checkpoint.parent} — recovery is unresolved, so no human decision may advance integration; inspect \`inspect --health\` and rerun \`run\` to reconcile; ${remedyRun()}`,
		);
	}
	await readCommit(root, checkpoint.parent);
	const rollback = latestJournalEvent(receipts, receiptKey({ ...waveKey, stage: "rollback" }));
	if (rollback?.kind !== "rollback" || rollback.value.state !== "discarded") {
		throw new ResolutionRefusal(
			`task ${task.id} wave ${checkpoint.wave} has no confirmed workspace discard (rollback ${rollback?.kind === "rollback" ? rollback.value.state : "missing"}) — resolve requires a fenced, discarded lease; ${remedyRun()}`,
		);
	}
	if (!checkpoint.leaseId) {
		throw new ResolutionRefusal(`task ${task.id} wave ${checkpoint.wave} checkpoint carries no owned workspace identity — recovery cannot be verified; ${remedyRun()}`);
	}
	const workspace = await inspectCheckpointedWorkspace(root, identity, task.id, checkpoint.leaseId);
	if (!prior && workspace.lease !== "absent") {
		throw new ResolutionRefusal(
			`task ${task.id} wave ${checkpoint.wave}'s private workspace lease is still present — the wave is not fenced; stop any live writer and rerun \`run\` to finish disposal; ${remedyRun()}`,
		);
	}

	if (request.action === "retry") {
		return await recordRetry(kit, {
			identity, task, checkpoint, waveKey, parent: checkpoint.parent, reason, operationId,
		});
	}

	return await recordAcceptTree(kit, {
		identity, task, checkpoint, waveKey, grant,
		tree: request.tree!, evidence: request.evidence!, reason, operationId, prior: prior !== undefined, receipts,
	});
}

/**
 * The task's latest SEALED wave (`terminal` checkpoint). Later `integrate` /
 * `publish` checkpoints of the same wave, or the retry checkpoint a resolution
 * itself wrote, never change which wave a replay of that decision addresses.
 *
 * Safety comes from the caller's own evidence: the task must be quarantined (so
 * no wave is live), its rollback receipt must say `discarded`, and the owned
 * workspace lease must be observed ABSENT. An `unknown` checkpoint anywhere is
 * an unresolved recovery and refuses before any human decision.
 */
function blockedWave(receipts: ReceiptsDocValue, planRevision: string, taskId: string): BlockedWave {
	const checkpoints = receipts.events.filter((event): event is Extract<typeof event, { kind: "checkpoint" }> =>
		event.kind === "checkpoint" && event.value.planRevision === planRevision && event.value.taskId === taskId,
	);
	const latest = checkpoints.at(-1);
	if (!latest) {
		throw new ResolutionRefusal(
			`task ${taskId} has no durable checkpoint — a human decision applies only to a retained candidate wave; ${remedyRun()}`,
		);
	}
	const unknown = checkpoints.filter((event) => event.value.state === "unknown").at(-1);
	if (unknown) {
		throw new ResolutionRefusal(
			`task ${taskId} wave ${unknown.value.wave} has an unknown ${unknown.value.stage} checkpoint — an uncertain effect is never manually approvable; rerun \`run\` to reconcile it; ${remedyRun()}`,
		);
	}
	const sealed = checkpoints.filter((event) => event.value.stage === "terminal" && event.value.state === "complete").at(-1);
	if (!sealed) {
		throw new ResolutionRefusal(
			`task ${taskId} wave ${latest.value.wave} has an unresolved ${latest.value.stage} checkpoint (${latest.value.state}) — finish or reconcile it first: \`run\` resumes the same pending stage; ${remedyRun()}`,
		);
	}
	return { checkpoint: sealed.value, waveKey: { planRevision, taskId, wave: sealed.value.wave } };
}

// ---------------------------------------------------------------------------
// --retry
// ---------------------------------------------------------------------------

async function recordRetry(
	kit: LoopAndLock,
	input: {
		identity: PlanIdentity;
		task: RouterTask;
		checkpoint: Checkpoint;
		waveKey: WaveKey;
		/** The unchanged integration head the retry requeues from. */
		parent: string;
		reason: string;
		operationId: string;
	},
): Promise<ResolutionOutcome> {
	const { identity, task, checkpoint, waveKey, parent, reason, operationId } = input;
	const startTree = await resolveTree(kit.loop.paths.root, parent);
	const at = Date.now();
	const resolution: Resolution = { ...waveKey, action: "retry", reason };
	const attempt: ReceiptAttempt = {
		identity: { ...waveKey, stage: "resolution" },
		opId: operationId,
		build: (meta) => ({ kind: "resolution", ...meta, value: { ...resolution } }),
	};
	const rows: WaveRow[] = [
		{
			ts: at, kind: "task", task: task.id, wave: checkpoint.wave, verb: "resolve:retry",
			reason, detail: `human retry from the accepted head ${parent}`, planRevision: identity.planRevision,
		},
	];
	await commitState(kit, {
		router: (draft) => {
			const row = draft.tasks.find((entry) => entry.id === task.id)!;
			// Fresh retry cycle: back in the queue with a fresh attempt quota. The
			// wave number and every earlier receipt/feedback entry stay intact —
			// the next wave is `waveCount + 1`, never a reuse.
			row.status = "todo";
			delete row.blockReason;
			// Duplicate-failure breaker and the per-task durable sleep counter
			// (M0-P17 promise: an explicitly granted human retry clears it).
			delete row.lastGateHash;
			row.sleepCycles = 0;
			row.feedback.push({ wave: checkpoint.wave, from: "gate", text: `human retry: ${reason}`, ts: at });
		},
		runStatus: (draft) => {
			draft.consecutiveErrors = 0;
			delete draft.activeAlert;
		},
		checkpoints: [{
			...waveKey,
			stage: "terminal",
			state: "complete",
			outcome: "retry",
			parent,
			startTree,
			leaseId: checkpoint.leaseId,
			grantedFeedbackIds: [],
			code: "human-retry",
		}],
		receiptAttempts: [attempt],
		rows,
		statusPhase: { phase: "idle", message: `${task.id} requeued by human retry — rerun \`run\` to start wave ${checkpoint.wave + 1}` },
	});
	return {
		action: "retry", taskId: task.id, wave: checkpoint.wave, operationId, idempotent: false,
		nextSteps: [
			`llm-toolkit-001 run   # bare resume of the stored grant; ${task.id} starts wave ${checkpoint.wave + 1} from the accepted head`,
		],
	};
}

// ---------------------------------------------------------------------------
// --accept-tree
// ---------------------------------------------------------------------------

async function recordAcceptTree(
	kit: LoopAndLock,
	input: {
		identity: PlanIdentity;
		task: RouterTask;
		checkpoint: Checkpoint;
		waveKey: WaveKey;
		grant: NonNullable<ReturnType<typeof readGrant>>;
		tree: string;
		evidence: ResolutionEvidence;
		reason: string;
		operationId: string;
		prior: boolean;
		receipts: ReceiptsDocValue;
	},
): Promise<ResolutionOutcome> {
	const { identity, task, checkpoint, waveKey, grant, evidence, reason, operationId, prior, receipts } = input;
	const root = kit.loop.paths.root;
	if (!prior && task.blockReason !== "needs_human") {
		throw new ResolutionRefusal(
			`--accept-tree applies only to an inconclusive \`needs_human\` quarantine; task ${task.id} was quarantined for another reason (no block reason recorded). ` +
				`Repair it and \`resolve --retry\` instead, or fix the cause and rerun \`run\`; ${remedyRun()}`,
		);
	}
	const requestedTree = await resolveTree(root, assertGitOid(input.tree));
	if (checkpoint.candidate !== requestedTree) {
		throw new ResolutionRefusal(
			`--accept-tree ${requestedTree} is not the retained candidate ${checkpoint.candidate} of task ${task.id} wave ${checkpoint.wave} — only this wave's frozen tree can be accepted; ${remedyRun()}`,
		);
	}
	const receiptsNow = prior
		? ((await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT)) ?? { version: 1, events: [] })
		: receipts;
	const pinned = (await inspectCheckpointedWorkspace(root, identity, task.id, checkpoint.leaseId!)).candidate;
	if (pinned !== undefined && pinned !== requestedTree) {
		throw new ResolutionRefusal(
			`the retained candidate pin names ${pinned}, not ${requestedTree} — the frozen tree moved; ${remedyRun()}`,
		);
	}

	const priorAcceptance = latestAcceptance(receiptsNow, waveKey);
	if (!prior) {
		// Unchanged lineage/controls: the wave's own gate receipt bound this exact
		// candidate to the reviewed control bundle.
		const gate = latestGateReceipt(receiptsNow, waveKey);
		if (!gate) {
			throw new ResolutionRefusal(`task ${task.id} wave ${checkpoint.wave} has no gate receipt — no deterministic check ran on this candidate; ${remedyRun()}`);
		}
		if (gate.value.tree !== requestedTree) {
			throw new ResolutionRefusal(
				`task ${task.id} wave ${checkpoint.wave}'s gate receipt covers ${gate.value.tree}, not ${requestedTree} — the tree is stale; ${remedyRun()}`,
			);
		}
		if (gate.value.controlsSha256 !== identity.controlsSha256) {
			throw new ResolutionRefusal(
				`the reviewed control bundle changed since task ${task.id} wave ${checkpoint.wave} was gated (${identity.controlsSha256 ?? "absent"} vs ${gate.value.controlsSha256 ?? "absent"}) — changed controls require a replan and a new review; ${remedyRun()}`,
			);
		}
		// The reviewed bytes themselves must still be the ones the plan recorded:
		// an edited PROMPT.md / checklist / recipe file / remediation list is a new
		// review, not something a human acceptance may silently absorb. A legacy
		// pre-step-(d) digest is named as a migration, not a false on-disk edit.
		const currentControls = await loadPlanControls(root, { prdPath: identity.prdPath, config: kit.loop.config });
		const controlsRefusal = controlsBindingRefusal(identity, currentControls);
		if (controlsRefusal) throw new ResolutionRefusal(`${controlsRefusal}; ${remedyRun()}`);

		const startTree = await resolveTree(root, checkpoint.startTree);
		const controls = createTaskControls({ root, targetPaths: task.targetPaths, prdPath: identity.prdPath });
		let lease: Awaited<ReturnType<typeof openTask>> | undefined;
		let readView: ReadWorkspace | undefined;
		let context: TaskExecutionContext | undefined;
		let gateRun: GateOutcome;
		try {
			// A disposable private copy of the EXACT frozen candidate: scratch space
			// for the rerun only, discarded in the finally below. Gates execute on
			// the frozen read view, never the operator checkout.
			lease = await openTask({ root, oid: requestedTree }, identity, task.id, { scopeBaseOid: checkpoint.parent });
			readView = await materializeRead({ root, oid: requestedTree }, controls);
			context = await createTaskExecutionContext({
				controlPaths: kit.loop.paths,
				grant: { planRevision: identity.planRevision, selectedTaskIds: grant.selected },
				taskId: task.id,
				parentOid: checkpoint.parent,
				startOid: requestedTree,
				candidateOid: requestedTree,
				writableWorkspace: lease,
				frozenReadView: readView,
				// Recipes come from the immutable candidate; `evals/**` is a protected
				// path, so a candidate that altered it fails the scope check below and
				// no recipe runs at all.
				recipeBundle: await recipeBundleFromTree(root, requestedTree),
				execArgv: hostExecArgv,
			});
			fenceWorkspace(lease, controls);
			gateRun = await runGates(kit, {
				id: task.id,
				targetPaths: task.targetPaths,
				baselineTreeSha: startTree,
				planRevision: identity.planRevision,
				wave: checkpoint.wave,
			}, {}, { context });
		} finally {
			if (readView) await discard(readView).catch(() => {});
			if (lease) await discard(lease).catch(() => {});
		}
		if (!gateRun.allPassed) {
			const failing = gateRun.results.filter((result) => !result.passed);
			throw new ResolutionRefusal(
				`deterministic gates did not all pass on ${requestedTree}: ${failing.map((result) => result.name).join(", ")}` +
					`${gateRun.scopeBody ? ` — ${gateRun.scopeBody}` : ""}; a skipped or failing check is never claimed proof, so nothing was accepted; ${remedyRun()}`,
			);
		}
		const evidenceRefusal = await validateApprovingCriteria(evidence.criteria, task.acceptance, {
			root,
			checkedTree: requestedTree,
			checks: gateRun.results.map(gateCheckFromResult),
		});
		if (evidenceRefusal) {
			throw new ResolutionRefusal(
				`--evidence is not valid proof for ${requestedTree}: ${evidenceRefusal}; criterion ids are the reviewed 1-based acceptance indices and every reference must resolve on the frozen tree; nothing was accepted`,
			);
		}

		const checks = gateRun.results.map(gateCheckFromResult);
		const gateEvent = gateReceiptEvent(waveKey, {
			tree: requestedTree,
			...(identity.controlsSha256 !== undefined ? { controlsSha256: identity.controlsSha256 } : {}),
			...(gateRun.failHash ? { failureHash: gateRun.failHash } : {}),
			checks,
		});
		const humanPass: ReviewPass = {
			pass: "human",
			verdict: "approve",
			criteria: evidence.criteria.map(toCriterionResult),
			notes: reason,
		};
		let acceptanceId = "";
		const acceptanceAttempt: ReceiptAttempt = {
			identity: { ...waveKey, stage: "acceptance" },
			build: (meta) => {
				acceptanceId = meta.opId;
				const value: AcceptanceReceipt = {
					...waveKey,
					id: meta.opId,
					parent: checkpoint.parent,
					tree: requestedTree,
					gateId: gateEvent.value.id,
					...(identity.controlsSha256 !== undefined ? { controlsSha256: identity.controlsSha256 } : {}),
					policy: "human-v1",
					required: ["human"],
					passes: [humanPass],
					authority: "human",
					at: meta.at,
					reason,
				};
				return { kind: "acceptance", ...meta, value };
			},
		};
		const resolutionAttempt: ReceiptAttempt = {
			identity: { ...waveKey, stage: "resolution" },
			opId: operationId,
			build: (meta) => ({
				kind: "resolution", ...meta,
				value: { ...waveKey, action: "accept-tree", reason, evidenceSha256: evidence.sha256, tree: requestedTree },
			}),
		};
		await commitState(kit, {
			router: (draft) => {
				const row = draft.tasks.find((entry) => entry.id === task.id)!;
				// Accepted but NOT delivered: the task stays in flight with a non-implement
				// stage; only the authorized run records `done` after publication.
				row.status = "in_progress";
				delete row.blockReason;
			},
			runStatus: (draft) => {
				delete draft.activeAlert;
			},
			receipts: [gateEvent],
			receiptAttempts: [acceptanceAttempt, resolutionAttempt],
			checkpoints: [{
				...waveKey,
				stage: "integrate",
				state: "pending",
				outcome: "accepted",
				parent: checkpoint.parent,
				startTree,
				candidate: requestedTree,
				leaseId: checkpoint.leaseId,
				grantedFeedbackIds: [],
			}],
			rows: [{
				ts: Date.now(), kind: "gate", task: task.id, wave: checkpoint.wave, verb: "pass",
				detail: checks.map((check) => `${check.id}:${check.outcome}`).join(","), planRevision: identity.planRevision,
				receiptStates: { ...waveKey, gate: "pass" },
			}],
			statusPhase: { phase: "idle", message: `${task.id} human-accepted ${requestedTree} — integrating (no publication yet)` },
		});
		if (!acceptanceId) throw new Error("human acceptance commit did not report its receipt id");
	} else if (!priorAcceptance || priorAcceptance.authority !== "human" || priorAcceptance.tree !== requestedTree) {
		throw new ResolutionRefusal(
			`the recorded resolution for task ${task.id} wave ${checkpoint.wave} does not match a human acceptance of ${requestedTree} — inspect the receipts before resolving again; ${remedyRun()}`,
		);
	}

	// Local integration only: commit/PR publication stays with the authorized run.
	const integrated = await integrateAcceptedCandidate(kit, waveKey);
	const acceptance = latestAcceptance(
		(await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT)) ?? { version: 1, events: [] },
		waveKey,
	);
	const integrateCheckpoint = latestCheckpointForStage(
		(await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT)) ?? { version: 1, events: [] },
		waveKey,
		"integrate",
	);
	if (!(integrateCheckpoint?.state === "complete" && integrateCheckpoint.outcome === "integrated")) {
		await commitState(kit, {
			checkpoints: [{
				...waveKey,
				stage: "integrate",
				state: "complete",
				outcome: "integrated",
				parent: checkpoint.parent,
				startTree: await resolveTree(root, checkpoint.startTree),
				candidate: requestedTree,
				leaseId: checkpoint.leaseId,
				grantedFeedbackIds: [],
			}],
			rows: [{
				ts: Date.now(), kind: "engine", task: task.id, wave: checkpoint.wave, verb: "integrated",
				detail: integrated.receipt.commit, planRevision: identity.planRevision,
			}],
			statusPhase: { phase: "idle", message: `${task.id} integrated — publication pending; rerun \`run\` to publish and finish` },
		});
	}
	return {
		action: "accept-tree",
		taskId: task.id,
		wave: checkpoint.wave,
		operationId,
		idempotent: prior,
		...(acceptance ? { acceptanceId: acceptance.id } : {}),
		commit: integrated.receipt.commit,
		nextSteps: [
			`llm-toolkit-001 run   # bare resume: confirms publication (none records the accepted lineage) and marks ${task.id} done`,
			`llm-toolkit-001 run --deliver   # only if delivery.mode = "pr": remote publication is never automatic`,
		],
	};
}

function latestGateReceipt(receipts: ReceiptsDocValue, wave: WaveKey): Extract<ReceiptEvent, { kind: "gate" }> | undefined {
	return receipts.events.filter((event): event is Extract<ReceiptEvent, { kind: "gate" }> =>
		event.kind === "gate" && event.value.planRevision === wave.planRevision
			&& event.value.taskId === wave.taskId && event.value.wave === wave.wave,
	).at(-1);
}

function latestAcceptance(receipts: ReceiptsDocValue, wave: WaveKey): AcceptanceReceipt | undefined {
	return receipts.events.filter((event): event is Extract<typeof event, { kind: "acceptance" }> =>
		event.kind === "acceptance" && event.value.planRevision === wave.planRevision
			&& event.value.taskId === wave.taskId && event.value.wave === wave.wave,
	).at(-1)?.value;
}

function latestCheckpointForStage(receipts: ReceiptsDocValue, wave: WaveKey, stage: Checkpoint["stage"]): Checkpoint | undefined {
	return receipts.events.filter((event): event is Extract<ReceiptEvent, { kind: "checkpoint" }> =>
		event.kind === "checkpoint" && event.value.planRevision === wave.planRevision
			&& event.value.taskId === wave.taskId && event.value.wave === wave.wave && event.value.stage === stage,
	).at(-1)?.value;
}

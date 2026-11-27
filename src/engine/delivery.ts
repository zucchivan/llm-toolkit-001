/**
 * Delivery host operations. M0-P12 provides journaled local integration,
 * workspace disposal, and local publication; M0-P13 provides verified stacked
 * PR publication. M0-P14's serial driver calls these operations instead of
 * staging, restoring, checking out, or delivering from the operator worktree.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { LoopAndLock } from "./harness.ts";
import { classifyProjectPath } from "../hygiene.ts";
import { parseApprovedGitHubOrigin, readApprovedDeliveryOrigin } from "../sandbox/host-profile.ts";
import type { ApprovedGitHubOrigin } from "../sandbox/host-profile.ts";
import { reviewBindingRefusal, type PlanIdentity } from "./plans.ts";
import { commitState, readGrant, readSessionState } from "./state.ts";
import type { ReceiptAttempt } from "./state.ts";
import {
	latestJournalEvent, receiptKey,
} from "./receipts.ts";
import type {
	AcceptanceReceipt, DeliveryReceipt, IntegrationReceipt, JournalReceiptEvent, ReceiptEvent,
	ReceiptIdentity, ReceiptStage, ReceiptsDocValue, ReviewPass, RollbackReceipt, WaveKey,
} from "./receipts.ts";
import { ReceiptsDoc } from "./receipts.ts";
import { BACKGROUND_CONTEXT } from "./kit.ts";
import {
	assertGitOid, compareAndSwapRef, createCommitObject, isBranchCheckedOut, readCommit, readRef, readTreeEntries, resolveTree, runGh, runGit,
} from "../util/git-objects.ts";
import { validateApprovingCriteria } from "./review.ts";
import { discard as discardWorkspace, observeLease, requireFencedWorkspace } from "./workspace.ts";
import type { FencedWorkspace } from "./workspace.ts";

export interface JournalFaultOptions {
	/** Deterministic host-side fault seam used by journal crash/replay tests. */
	faultInjector?: (point: JournalFaultPoint) => void | Promise<void>;
}

type JournalCommitBoundary = "acceptance" | "integration-intent" | "integration-result" | "rollback-intent" | "rollback-result" | "delivery-intent" | "delivery-result";

export type JournalFaultPoint =
	| `${JournalCommitBoundary}:before-commit` | `${JournalCommitBoundary}:after-commit`
	| "acceptance-pin:before-effect" | "acceptance-pin:after-effect"
	| "integration-commit-object:before-effect" | "integration-commit-object:after-effect"
	| "integration-pin:before-effect" | "integration-pin:after-effect"
	| "integration-init:before-cas" | "integration-init:after-cas"
	| "integration-cas:before-effect" | "integration-cas:after-effect"
	| "rollback-discard:before-effect" | "rollback-discard:after-effect"
	| "delivery-cas:before-effect" | "delivery-cas:after-effect"
	| "pr-ref-create:before-effect" | "pr-ref-create:after-effect"
	| "pr-host-create:before-effect" | "pr-host-create:after-effect";

export class RecoveryRequiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RecoveryRequiredError";
	}
}

export type AcceptCandidateInput = WaveKey & {
	parent: string;
	tree: string;
	policy: AcceptanceReceipt["policy"];
	required: ("primary" | "skeptic")[];
	controlsSha256?: string;
};

export type JournalOperationResult<T extends JournalReceiptEvent> = {
	receipt: T["value"];
	event: T;
};

async function fault(options: JournalFaultOptions | undefined, point: JournalFaultPoint): Promise<void> {
	await options?.faultInjector?.(point);
}

function stageIdentity(wave: WaveKey, stage: ReceiptStage): ReceiptIdentity {
	return { ...wave, stage };
}

function acceptedRef(planRevision: string): string {
	return `refs/kit/${planRevision}/accepted`;
}

function integrationCommitRef(wave: WaveKey): string {
	return `refs/kit/${wave.planRevision}/integration-objects/${wave.taskId}/${wave.wave}/commit`;
}

function candidatePinRef(wave: WaveKey): string {
	return `refs/kit/${wave.planRevision}/accepted-candidates/${wave.taskId}/${wave.wave}/tree`;
}

function localResultRef(planRevision: string): string {
	return `refs/heads/kit/${planRevision}/result`;
}

function sameRef(actual: string | undefined, expected: string | null): boolean {
	return (actual ?? null) === expected;
}

async function receiptSnapshot(kit: LoopAndLock): Promise<ReceiptsDocValue> {
	return (await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT)) ?? { version: 1, events: [] };
}

function latestOf<K extends JournalReceiptEvent["kind"]>(doc: ReceiptsDocValue, wave: WaveKey, stage: K): Extract<JournalReceiptEvent, { kind: K }> | undefined {
	const event = latestJournalEvent(doc, receiptKey(stageIdentity(wave, stage)));
	return event?.kind === stage ? event as Extract<JournalReceiptEvent, { kind: K }> : undefined;
}

async function appendJournal<K extends JournalReceiptEvent["kind"]>(
	kit: LoopAndLock,
	wave: WaveKey,
	stage: K,
	build: (meta: { key: string; ordinal: number; opId: string; at: number }) => Extract<JournalReceiptEvent, { kind: K }>,
	options: JournalFaultOptions | undefined,
	boundary: JournalCommitBoundary,
): Promise<Extract<JournalReceiptEvent, { kind: K }>> {
	await fault(options, `${boundary}:before-commit` as JournalFaultPoint);
	let written: JournalReceiptEvent | undefined;
	const attempt: ReceiptAttempt = {
		identity: stageIdentity(wave, stage),
		build(meta) {
			written = build(meta);
			return written;
		},
	};
	await commitState(kit, { receiptAttempts: [attempt] });
	if (!written || written.kind !== stage) throw new Error(`journal commit did not write its ${stage} receipt`);
	await fault(options, `${boundary}:after-commit` as JournalFaultPoint);
	return written as Extract<JournalReceiptEvent, { kind: K }>;
}

async function assertCurrentTask(kit: LoopAndLock, wave: WaveKey): Promise<{ state: Awaited<ReturnType<typeof readSessionState>>; task: Awaited<ReturnType<typeof readSessionState>>["router"]["tasks"][number] }> {
	const state = await readSessionState(kit.loop.harness);
	if (state.router.identity?.planRevision !== wave.planRevision) throw new Error(`receipt plan revision ${wave.planRevision} is not the current reviewed plan`);
	const task = state.router.tasks.find((candidate) => candidate.id === wave.taskId);
	if (!task) throw new Error(`receipt task ${wave.taskId} is absent from the current plan`);
	if (!Number.isSafeInteger(wave.wave) || wave.wave < 1) throw new Error("receipt wave must be a positive safe integer");
	return { state, task };
}

async function ensureAcceptedRef(kit: LoopAndLock, wave: WaveKey, baseCommit: string, expectedParent: string, options?: JournalFaultOptions): Promise<string | undefined> {
	const root = kit.loop.paths.root;
	const ref = acceptedRef(wave.planRevision);
	const current = await readRef(root, ref);
	if (current) return current;
	if (expectedParent !== baseCommit) throw new RecoveryRequiredError(`accepted ref ${ref} is absent but this operation expects prior integration ${expectedParent}`);
	await fault(options, "integration-init:before-cas");
	await compareAndSwapRef(root, ref, baseCommit, null);
	await fault(options, "integration-init:after-cas");
	return await readRef(root, ref);
}

async function ensurePrivatePin(root: string, ref: string, oid: string): Promise<void> {
	const existing = await readRef(root, ref);
	if (existing) {
		if (existing !== oid) throw new RecoveryRequiredError(`private pin ${ref} already names ${existing}, not ${oid}`);
		return;
	}
	await compareAndSwapRef(root, ref, oid, null);
	const observed = await readRef(root, ref);
	if (observed !== oid) throw new RecoveryRequiredError(`could not confirm private pin ${ref} at ${oid}`);
}

function assertJournalCommit(commit: { oid: string; tree: string; parents: string[] }, tree: string, parent: string): void {
	if (commit.tree !== tree || commit.parents.length !== 1 || commit.parents[0] !== parent) {
		throw new RecoveryRequiredError(`commit ${commit.oid} does not have the recorded candidate tree and sole integration parent`);
	}
}

/**
 * Record verifier acceptance of one pinned candidate. The accepted integration
 * head must still equal its recorded parent; review passes are revalidated
 * against the gate receipt and checked tree before the receipt is committed.
 */
export async function acceptCandidate(
	kit: LoopAndLock,
	input: AcceptCandidateInput,
	options: JournalFaultOptions = {},
): Promise<JournalOperationResult<Extract<JournalReceiptEvent, { kind: "acceptance" }>>> {
	const { state, task } = await assertCurrentTask(kit, input);
	const identity = state.router.identity!;
	const grant = readGrant(state.runStatus);
	if (!grant || grant.planRevision !== input.planRevision || !grant.selected.includes(input.taskId)) {
		throw new Error("acceptance requires the current revision-qualified grant to include this task");
	}
	if (!identity.baseCommit) throw new Error("acceptance requires a reviewed base commit; create the project seed commit and replan first");
	const parent = assertGitOid(input.parent);
	await readCommit(kit.loop.paths.root, parent);
	const tree = await resolveTree(kit.loop.paths.root, input.tree);
	const doc = await receiptSnapshot(kit);
	const gate = doc.events.filter((event): event is Extract<ReceiptEvent, { kind: "gate" }> =>
		event.kind === "gate" && event.value.planRevision === input.planRevision && event.value.taskId === input.taskId && event.value.wave === input.wave,
	).at(-1);
	if (!gate || gate.value.tree !== tree) throw new Error("acceptance requires a gate receipt for this exact candidate tree and wave");
	if (gate.value.controlsSha256 !== input.controlsSha256) throw new Error("acceptance controls digest does not match its gate receipt (absent and empty are distinct)");
	if (new Set(input.required).size !== input.required.length || !input.required.includes("primary")) {
		throw new Error("verifier acceptance requires primary exactly once and no duplicate required passes");
	}
	if ((input.policy === "always" && !input.required.includes("skeptic")) || (input.policy === "never" && input.required.includes("skeptic"))) {
		throw new Error(`required verifier passes do not match the ${input.policy} policy`);
	}
	if (input.policy !== "always" && input.policy !== "never") throw new Error(`prepared verifier acceptance does not support policy ${input.policy}`);
	const passes: ReviewPass[] = [];
	for (const required of input.required) {
		const event = doc.events.filter((candidate): candidate is Extract<ReceiptEvent, { kind: "pass" }> =>
			candidate.kind === "pass" && candidate.value.planRevision === input.planRevision && candidate.value.taskId === input.taskId
				&& candidate.value.wave === input.wave && candidate.value.tree === tree && candidate.value.gateId === gate.value.id
				&& candidate.value.review.pass === required,
		).at(-1);
		if (!event || event.value.review.verdict !== "approve" || event.value.policy !== input.policy) {
			throw new Error(`acceptance requires a matching approving ${required} pass receipt under policy ${input.policy}`);
		}
		const criteria = event.value.review.criteria.map((criterion) => ({ ...criterion, malformed: false }));
		const refusal = await validateApprovingCriteria(criteria, task.acceptance, {
			root: kit.loop.paths.root, checkedTree: tree, checks: gate.value.checks,
		});
		if (refusal) throw new Error(`acceptance refused: ${required} receipt is invalid against the checked tree: ${refusal}`);
		passes.push(event.value.review);
	}
	const existing = latestOf(doc, input, "acceptance");
	if (existing) {
		const sameRequired = existing.value.required.length === input.required.length && existing.value.required.every((pass, index) => pass === input.required[index]);
		if (existing.value.parent !== parent || existing.value.tree !== tree || existing.value.gateId !== gate.value.id
			|| existing.value.policy !== input.policy || !sameRequired || existing.value.controlsSha256 !== input.controlsSha256) {
			throw new RecoveryRequiredError(`wave ${input.taskId}/${input.wave} already has a different acceptance receipt`);
		}
		await fault(options, "acceptance-pin:before-effect");
		await ensurePrivatePin(kit.loop.paths.root, candidatePinRef(input), tree);
		await fault(options, "acceptance-pin:after-effect");
		return { receipt: existing.value, event: existing };
	}
	const current = await ensureAcceptedRef(kit, input, identity.baseCommit, parent, options);
	if (current !== parent) throw new RecoveryRequiredError(`accepted integration ref is ${current ?? "absent"}, not the candidate's recorded parent ${parent}`);
	await fault(options, "acceptance-pin:before-effect");
	await ensurePrivatePin(kit.loop.paths.root, candidatePinRef(input), tree);
	await fault(options, "acceptance-pin:after-effect");
	const event = await appendJournal(kit, input, "acceptance", (meta) => ({
		kind: "acceptance", ...meta, value: {
			planRevision: input.planRevision,
			taskId: input.taskId,
			wave: input.wave,
			id: meta.opId,
			parent,
			tree,
			gateId: gate.value.id,
			...(input.controlsSha256 !== undefined ? { controlsSha256: input.controlsSha256 } : {}),
			policy: input.policy,
			required: [...input.required],
			passes,
			authority: "verifier",
			at: meta.at,
		},
	}), options, "acceptance");
	return { receipt: event.value, event };
}

/** Reconcile/create the one-parent integration commit and CAS the private accepted ref. */
export async function integrateAcceptedCandidate(
	kit: LoopAndLock,
	wave: WaveKey,
	options: JournalFaultOptions = {},
): Promise<JournalOperationResult<Extract<JournalReceiptEvent, { kind: "integrate" }>>> {
	const { state } = await assertCurrentTask(kit, wave);
	const plan = state.router.identity!;
	if (!plan.baseCommit) throw new Error("integration requires a reviewed base commit");
	const doc = await receiptSnapshot(kit);
	const acceptance = latestOf(doc, wave, "acceptance");
	if (!acceptance) throw new Error("integration requires a durable acceptance receipt");
	const accepted = acceptance.value;
	const root = kit.loop.paths.root;
	const acceptedName = acceptedRef(wave.planRevision);
	const parent = assertGitOid(accepted.parent);
	const candidate = await resolveTree(root, accepted.tree);
	const prior = latestOf(doc, wave, "integrate");
	if (prior && (prior.value.acceptedId !== accepted.id || prior.value.parent !== parent || prior.value.candidate !== candidate)) {
		throw new RecoveryRequiredError("integration journal intent does not match its durable acceptance receipt");
	}
	if (prior?.value.state === "integrated") {
		const recorded = await readCommit(root, prior.value.commit);
		assertJournalCommit(recorded, candidate, parent);
		let observed: string | undefined;
		try { observed = await readRef(root, acceptedName); }
		catch (error) {
			await recordIntegrationState(kit, wave, prior.value, "unknown", "accepted-ref-unreadable", options);
			throw new RecoveryRequiredError(`cannot re-confirm integrated accepted ref: ${(error as Error).message}`);
		}
		if (observed !== prior.value.commit) {
			await recordIntegrationState(kit, wave, prior.value, "unknown", "accepted-ref-conflict", options);
			throw new RecoveryRequiredError(`integrated accepted ref is ${observed ?? "absent"}, not the recorded commit ${prior.value.commit}`);
		}
		return { receipt: prior.value, event: prior };
	}

	let commit: string;
	const pinned = await readRef(root, integrationCommitRef(wave));
	if (prior) commit = prior.value.commit;
	else if (pinned) commit = pinned;
	else {
		await fault(options, "integration-commit-object:before-effect");
		commit = await createCommitObject(root, candidate, parent, `kit: ${wave.taskId} (wave ${wave.wave})`);
		await fault(options, "integration-commit-object:after-effect");
		await fault(options, "integration-pin:before-effect");
		await ensurePrivatePin(root, integrationCommitRef(wave), commit);
		await fault(options, "integration-pin:after-effect");
	}
	const recorded = await readCommit(root, commit);
	assertJournalCommit(recorded, candidate, parent);
	if (pinned && pinned !== commit) throw new RecoveryRequiredError(`pinned integration commit ${pinned} differs from the journal commit ${commit}`);
	await ensurePrivatePin(root, integrationCommitRef(wave), commit);

	const intent = await appendJournal(kit, wave, "integrate", (meta) => ({
		kind: "integrate", ...meta, value: {
			...wave, acceptedId: accepted.id, parent, candidate, commit, at: meta.at, state: "pending",
		},
	}), options, "integration-intent");

	let observed: string | undefined;
	try {
		observed = await readRef(root, acceptedName);
		if (observed === undefined) observed = await ensureAcceptedRef(kit, wave, plan.baseCommit, parent, options);
	} catch (error) {
		await recordIntegrationState(kit, wave, intent.value, "unknown", "accepted-ref-unreadable", options);
		throw new RecoveryRequiredError(`cannot reconcile accepted ref after intent: ${(error as Error).message}`);
	}
	if (observed === commit) {
		const readback = await readCommit(root, commit);
		assertJournalCommit(readback, candidate, parent);
	} else {
		if (observed !== parent) {
			const error = new RecoveryRequiredError(`accepted ref ${acceptedName} is ${observed ?? "absent"}, expected parent ${parent} or recorded commit ${commit}`);
			await recordIntegrationState(kit, wave, intent.value, "unknown", "recovery-required", options);
			throw error;
		}
		try {
			await fault(options, "integration-cas:before-effect");
			const swapped = await compareAndSwapRef(root, acceptedName, commit, parent);
			await fault(options, "integration-cas:after-effect");
			const readbackRef = await readRef(root, acceptedName);
			if (!swapped && readbackRef !== commit) {
				throw new RecoveryRequiredError(`accepted ref CAS did not publish ${commit}; observed ${readbackRef ?? "absence"}`);
			}
			if (readbackRef !== commit) throw new RecoveryRequiredError(`accepted ref readback is ${readbackRef ?? "absent"}, not ${commit}`);
			assertJournalCommit(await readCommit(root, commit), candidate, parent);
		} catch (error) {
			await recordIntegrationState(kit, wave, intent.value, "unknown", error instanceof RecoveryRequiredError ? "recovery-required" : "effect-uncertain", options);
			throw error;
		}
	}
	return await recordIntegrationState(kit, wave, intent.value, "integrated", undefined, options);
}

async function recordIntegrationState(
	kit: LoopAndLock,
	wave: WaveKey,
	intent: IntegrationReceipt,
	state: IntegrationReceipt["state"],
	code: string | undefined,
	options: JournalFaultOptions,
): Promise<JournalOperationResult<Extract<JournalReceiptEvent, { kind: "integrate" }>>> {
	const event = await appendJournal(kit, wave, "integrate", (meta) => ({
		kind: "integrate", ...meta, value: {
			...wave, acceptedId: intent.acceptedId, parent: intent.parent, candidate: intent.candidate,
			commit: intent.commit, at: meta.at, state, ...(code ? { code } : {}),
		},
	}), options, "integration-result");
	return { receipt: event.value, event };
}

/** Confirm `none`, or CAS the named local result branch without checkout/index operations. */
export async function publishLocalResult(
	kit: LoopAndLock,
	wave: WaveKey,
	mode: "none" | "commit",
	options: JournalFaultOptions = {},
): Promise<JournalOperationResult<Extract<JournalReceiptEvent, { kind: "delivery" }>>> {
	if (mode !== "none" && mode !== "commit") throw new Error(`prepared local publication does not support mode ${String(mode)}`);
	const { state } = await assertCurrentTask(kit, wave);
	const plan = state.router.identity!;
	if (plan.deliveryOrigin !== undefined) {
		throw new RecoveryRequiredError("reviewed PR delivery cannot finish in a local delivery mode; restore the reviewed mode to recover publication");
	}
	const doc = await receiptSnapshot(kit);
	const integration = latestOf(doc, wave, "integrate");
	if (!integration || integration.value.state !== "integrated") throw new Error("local publication requires a confirmed integration receipt");
	const accepted = latestOf(doc, wave, "acceptance");
	if (!accepted || accepted.value.id !== integration.value.acceptedId) throw new Error("integration receipt does not reference the current acceptance receipt");
	const root = kit.loop.paths.root;
	const commit = assertGitOid(integration.value.commit);
	const commitData = await readCommit(root, commit);
	assertJournalCommit(commitData, accepted.value.tree, accepted.value.parent);
	const existing = latestOf(doc, wave, "delivery");
	if (existing && existing.value.acceptedId !== accepted.value.id) {
		throw new RecoveryRequiredError("delivery receipt does not reference the current acceptance receipt");
	}
	if (existing && existing.value.mode !== mode) {
		throw new RecoveryRequiredError(`delivery retry changed mode from ${existing.value.mode} to ${mode} for the same wave`);
	}
	if (mode === "none") {
		let acceptedHead: string | undefined;
		try { acceptedHead = await readRef(root, acceptedRef(wave.planRevision)); }
		catch (error) {
			const unknown = await appendJournal(kit, wave, "delivery", (meta) => ({
				kind: "delivery", ...meta, value: {
					...wave, id: meta.opId, acceptedId: accepted.value.id, commit, mode, state: "unknown", checkedAt: meta.at,
					code: "accepted-ref-unreadable",
				},
			}), options, "delivery-result");
			throw new RecoveryRequiredError(`none acknowledgment could not read accepted ref (${unknown.value.code}): ${(error as Error).message}`);
		}
		if (acceptedHead !== commit) {
			const unknown = await appendJournal(kit, wave, "delivery", (meta) => ({
				kind: "delivery", ...meta, value: {
					...wave, id: meta.opId, acceptedId: accepted.value.id, commit, mode, state: "unknown", checkedAt: meta.at,
					code: "accepted-ref-conflict",
				},
			}), options, "delivery-result");
			throw new RecoveryRequiredError(`none acknowledgment requires accepted ref ${commit}, observed ${acceptedHead ?? "absent"} (${unknown.value.code})`);
		}
		if (existing?.value.state === "not_requested") return { receipt: existing.value, event: existing };
		const event = await appendJournal(kit, wave, "delivery", (meta) => ({
			kind: "delivery", ...meta, value: {
				...wave, id: meta.opId, acceptedId: accepted.value.id, commit, mode, state: "not_requested", checkedAt: meta.at,
			},
		}), options, "delivery-result");
		return { receipt: event.value, event };
	}

	const ref = localResultRef(wave.planRevision);
	const expected = commitData.parents[0];
	if (!expected) throw new RecoveryRequiredError("accepted integration commit has no parent");
	let current: string | undefined;
	try { current = await readRef(root, ref); }
	catch (error) {
		const unknown = await appendJournal(kit, wave, "delivery", (meta) => ({
			kind: "delivery", ...meta, value: {
				...wave, id: meta.opId, acceptedId: accepted.value.id, commit, mode, state: "unknown", ref,
				baseRef: expected, checkedAt: meta.at, code: "result-ref-unreadable",
			},
		}), options, "delivery-result");
		throw new RecoveryRequiredError(`cannot observe local result ref (${unknown.value.code}): ${(error as Error).message}`);
	}
	let checkedOut = false;
	try { checkedOut = current !== commit && await isBranchCheckedOut(root, ref); }
	catch (error) {
		await appendJournal(kit, wave, "delivery", (meta) => ({
			kind: "delivery", ...meta, value: {
				...wave, id: meta.opId, acceptedId: accepted.value.id, commit, mode, state: "unknown", ref,
				baseRef: expected, checkedAt: meta.at, code: "worktree-check-failed",
			},
		}), options, "delivery-result");
		throw new RecoveryRequiredError(`cannot determine whether result branch ${ref} is checked out: ${(error as Error).message}`);
	}
	if (current === commit) {
		assertJournalCommit(await readCommit(root, commit), accepted.value.tree, expected);
		if (existing?.value.state === "published") return { receipt: existing.value, event: existing };
		if (existing && (existing.value.state === "pending" || existing.value.state === "unknown")) {
			const retryIntent = await appendJournal(kit, wave, "delivery", (meta) => ({
				kind: "delivery", ...meta, value: {
					...wave, id: meta.opId, acceptedId: accepted.value.id, commit, mode, state: "pending", ref,
					baseRef: expected, checkedAt: meta.at, code: "reconcile-local-result-ref",
				},
			}), options, "delivery-intent");
			return await recordDeliveryState(kit, wave, retryIntent.value, "published", options);
		}
		await appendJournal(kit, wave, "delivery", (meta) => ({
			kind: "delivery", ...meta, value: {
				...wave, id: meta.opId, acceptedId: accepted.value.id, commit, mode, state: "unknown", ref,
				baseRef: expected, checkedAt: meta.at, code: "result-ref-without-intent",
			},
		}), options, "delivery-result");
		throw new RecoveryRequiredError(`local result ref ${ref} already names ${commit} without a matching publication intent`);
	}
	if (existing?.value.state === "published") {
		await recordDeliveryState(kit, wave, existing.value, "unknown", options, "result-ref-conflict");
		throw new RecoveryRequiredError(`previously published result branch ${ref} now reads ${current ?? "absent"}, not ${commit}`);
	}
	if (checkedOut) {
		const failed = await appendJournal(kit, wave, "delivery", (meta) => ({
			kind: "delivery", ...meta, value: {
				...wave, id: meta.opId, acceptedId: accepted.value.id, commit, mode, state: "failed", ref,
				checkedAt: meta.at, code: "result-branch-checked-out",
			},
		}), options, "delivery-result");
		throw new RecoveryRequiredError(`refusing to update checked-out result branch ${ref}; observed ${failed.value.state}`);
	}
	const deliveryIntent = await appendJournal(kit, wave, "delivery", (meta) => ({
		kind: "delivery", ...meta, value: {
			...wave, id: meta.opId, acceptedId: accepted.value.id, commit, mode, state: "pending", ref,
			baseRef: expected, checkedAt: meta.at,
		},
	}), options, "delivery-intent");
	let observed: string | undefined;
	try { observed = await readRef(root, ref); }
	catch (error) {
		await recordDeliveryState(kit, wave, deliveryIntent.value, "unknown", options, "result-ref-unreadable");
		throw new RecoveryRequiredError(`cannot reconcile local result ref after intent: ${(error as Error).message}`);
	}
	if (observed === commit) {
		assertJournalCommit(await readCommit(root, commit), accepted.value.tree, expected);
		return await recordDeliveryState(kit, wave, deliveryIntent.value, "published", options);
	}
	const expectedOld = expected === plan.baseCommit && observed === undefined ? null : expected;
	if (observed !== expectedOld && !(expectedOld === null && observed === undefined)) {
		const error = new RecoveryRequiredError(`local result ref ${ref} is ${observed ?? "absent"}, expected ${expectedOld ?? "absence"} or recorded commit ${commit}`);
		await recordDeliveryState(kit, wave, deliveryIntent.value, "unknown", options, "recovery-required");
		throw error;
	}
	try {
		await fault(options, "delivery-cas:before-effect");
		const swapped = await compareAndSwapRef(root, ref, commit, expectedOld);
		await fault(options, "delivery-cas:after-effect");
		const readback = await readRef(root, ref);
		if (readback !== commit) {
			throw new RecoveryRequiredError(`local result branch CAS ${swapped ? "succeeded" : "did not succeed"}, but readback is ${readback ?? "absent"}`);
		}
		assertJournalCommit(await readCommit(root, commit), accepted.value.tree, expected);
	} catch (error) {
		await recordDeliveryState(kit, wave, deliveryIntent.value, "unknown", options, error instanceof RecoveryRequiredError ? "recovery-required" : "effect-uncertain");
		throw error;
	}
	return await recordDeliveryState(kit, wave, deliveryIntent.value, "published", options);
}

async function recordDeliveryState(
	kit: LoopAndLock,
	wave: WaveKey,
	intent: DeliveryReceipt,
	state: DeliveryReceipt["state"],
	options: JournalFaultOptions,
	code?: string,
): Promise<JournalOperationResult<Extract<JournalReceiptEvent, { kind: "delivery" }>>> {
	const event = await appendJournal(kit, wave, "delivery", (meta) => ({
		kind: "delivery", ...meta, value: {
			...wave, id: meta.opId, acceptedId: intent.acceptedId, commit: intent.commit, mode: intent.mode,
			state, ...(intent.ref ? { ref: intent.ref } : {}), ...(intent.baseRef ? { baseRef: intent.baseRef } : {}),
			checkedAt: meta.at, ...(code ? { code } : {}),
		},
	}), options, "delivery-result");
	return { receipt: event.value, event };
}

// ---------------------------------------------------------------------------
// Verified stacked PR publication (M0-P13, activated by P14). The only
// destination authority is host-v1.json; tests inject narrow transport/host
// interfaces and no caller may supply an origin.
// ---------------------------------------------------------------------------

export type RemotePullRequest = {
	repository: string;
	number: number;
	url: string;
	baseRef: string;
	baseOid: string;
	headRef: string;
	headOid: string;
	state?: "open" | "closed";
};

export type PullRequestIdentity = {
	repository: string;
	baseRef: string;
	baseOid: string;
	headRef: string;
	headOid: string;
};

/** Narrow Git surface: no checkout, arbitrary remote name, ref update, or force API. */
export interface RemoteGitTransport {
	readRemoteRef(origin: string, ref: string): Promise<string | undefined>;
	createRemoteRef(origin: string, ref: string, oid: string): Promise<void>;
}

/** The host adapter searches all PRs for this repo/head so conflicting bases are visible. */
export interface PullRequestHost {
	findForHead(identity: PullRequestIdentity): Promise<RemotePullRequest[]>;
	create(identity: PullRequestIdentity & { title: string; body: string }): Promise<void>;
}

export type PrPublicationOptions = JournalFaultOptions & {
	deliverExplicit: boolean;
	/** Internal test seam; production reads the operator host profile by default. */
	profilePath?: string;
	gitTransport?: RemoteGitTransport;
	prHost?: PullRequestHost;
};

function deliveryBranchRef(wave: WaveKey): string {
	return `refs/heads/kit/${wave.planRevision}/${wave.taskId}`;
}

function shortHeadRef(ref: string): string {
	if (!ref.startsWith("refs/heads/")) throw new Error(`expected a fully qualified branch ref, got ${ref}`);
	return ref.slice("refs/heads/".length);
}

function assertBranchRef(ref: string): string {
	const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
	const forbidden = ["~", "^", ":", "?", "*", "[", "\\", "]"];
	const hasControl = [...branch].some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f);
	if (!branch || ref.length > 512 || hasControl || branch.split("/").some((part) =>
		!part || part === "." || part === ".." || part.endsWith(".") || part.endsWith(".lock") || forbidden.some((char) => part.includes(char)),
	) || branch.includes("@{")) {
		throw new Error(`invalid publication branch ref ${JSON.stringify(ref)}`);
	}
	return ref;
}

function secretPath(path: string): boolean {
	const parts = path.split("/");
	return parts.some((part) => {
		const name = part.toLowerCase();
		return name === ".env" || name.startsWith(".env.") || name === ".npmrc" || name === ".netrc" || name === ".pypirc"
			|| name === ".ssh" || name === ".aws" || name.endsWith(".pem") || name.endsWith(".key");
	});
}

async function assertPublicTree(root: string, tree: string, label: string): Promise<void> {
	for (const entry of await readTreeEntries(root, tree)) {
		if (classifyProjectPath(entry.path) === "private") {
			throw new Error(`refusing public PR delivery: ${label} tracks private runtime path ${JSON.stringify(entry.path)}; remove it manually and replan`);
		}
		if (secretPath(entry.path)) {
			throw new Error(`refusing public PR delivery: ${label} tracks §2 secret path ${JSON.stringify(entry.path)}; remove it manually and replan`);
		}
	}
}

function latestDeliveryFor(doc: ReceiptsDocValue, event: Extract<ReceiptEvent, { kind: "delivery" }>): Extract<ReceiptEvent, { kind: "delivery" }> | undefined {
	const latest = latestJournalEvent(doc, receiptKey({ ...event.value, stage: "delivery" }));
	return latest?.kind === "delivery" ? latest : undefined;
}

function assertReportedPullRequest(record: RemotePullRequest, identity: PullRequestIdentity): RemotePullRequest {
	if (!record || record.repository !== identity.repository || record.baseRef !== identity.baseRef || record.baseOid !== identity.baseOid
		|| record.headRef !== identity.headRef || record.headOid !== identity.headOid || record.state === "closed"
		|| !Number.isSafeInteger(record.number) || record.number < 1) {
		throw new RecoveryRequiredError("PR host reported a repository, base, head, OID, or PR identity different from the reviewed publication intent");
	}
	const expectedUrl = `https://github.com/${identity.repository}/pull/${record.number}`;
	if (record.url !== expectedUrl) throw new RecoveryRequiredError("PR host reported a non-canonical or mismatched GitHub PR URL");
	return record;
}

function findExactPr(records: RemotePullRequest[], identity: PullRequestIdentity): RemotePullRequest | undefined {
	if (records.length === 0) return undefined;
	if (records.length !== 1) throw new RecoveryRequiredError("multiple PRs exist for the same repository/head; publication is ambiguous");
	return assertReportedPullRequest(records[0]!, identity);
}

async function publicationBase(
	root: string,
	planRevision: string,
	baseCommit: string,
	baseBranch: string | null,
	parent: string,
	doc: ReceiptsDocValue,
	deliveryOrigin: string,
): Promise<string> {
	if (parent === baseCommit) {
		if (!baseBranch || baseBranch.startsWith("(") || baseBranch.startsWith("refs/")) {
			throw new Error("PR delivery requires the reviewed base branch captured by the plan; detached-base plans cannot publish");
		}
		const ref = assertBranchRef(`refs/heads/${baseBranch}`);
		const check = await runGit(root, ["check-ref-format", ref], { timeoutMs: 10_000 });
		if (check.code !== 0) throw new Error(`reviewed base branch ${JSON.stringify(baseBranch)} is not a valid Git branch`);
		return ref;
	}
	const matches = doc.events.filter((event): event is Extract<ReceiptEvent, { kind: "delivery" }> =>
		event.kind === "delivery" && event.value.planRevision === planRevision && event.value.mode === "pr"
			&& event.value.state === "published" && event.value.commit === parent
			&& latestDeliveryFor(doc, event)?.opId === event.opId,
	);
	const base = matches[0]?.value;
	if (matches.length !== 1 || !base?.ref) {
		throw new RecoveryRequiredError(`integration parent ${parent} is not the reviewed base or one uniquely published PR head; refusing to guess a stack base`);
	}
	if (base.deliveryOrigin !== deliveryOrigin) {
		throw new RecoveryRequiredError(`published stack base ${base.ref} lacks a matching PR destination binding; inspect its original delivery receipt`);
	}
	return assertBranchRef(base.ref);
}

/** Check the recorded canonical origin against current local operator authority. */
export async function requireReviewedPrDestination(
	root: string,
	plan: PlanIdentity,
	profilePath?: string,
): Promise<ApprovedGitHubOrigin> {
	if (plan.deliveryOrigin === undefined) {
		throw new RecoveryRequiredError("reviewed plan has no PR destination binding; reconcile any unresolved delivery manually or replan if there is no unresolved effect");
	}
	let pinned: ApprovedGitHubOrigin;
	try {
		pinned = parseApprovedGitHubOrigin(plan.deliveryOrigin);
		if (pinned.origin !== plan.deliveryOrigin) throw new Error("recorded origin is not canonical");
	} catch (error) {
		throw new RecoveryRequiredError(`invalid reviewed PR destination binding: ${(error as Error).message}`);
	}
	let current: ApprovedGitHubOrigin;
	try {
		current = await readApprovedDeliveryOrigin(root, profilePath);
	} catch (error) {
		throw new RecoveryRequiredError(`cannot establish current PR destination authorization: ${(error as Error).message}`);
	}
	if (current.origin !== pinned.origin) {
		throw new RecoveryRequiredError(`operator-approved PR destination changed from ${pinned.origin} to ${current.origin}; restore the original authorization, or replan and re-approve if there is no unresolved effect`);
	}
	return pinned;
}

/** Validate consent, the host-approved destination, and reviewed base branch without network effects. */
export async function preflightPullRequest(
	kit: LoopAndLock,
	options: { deliverExplicit: boolean; profilePath?: string },
): Promise<void> {
	if (!options.deliverExplicit) throw new Error('delivery.mode="pr" requires explicit --deliver consent before implementation starts');
	if (kit.loop.config.delivery.mode !== "pr") throw new Error("PR preflight requires reviewed delivery.mode = pr");
	const state = await readSessionState(kit.loop.harness);
	const plan = state.router.identity;
	if (!plan?.baseCommit) throw new Error("PR delivery requires a reviewed base commit; create the project seed commit and replan first");
	if (!plan.baseBranch || plan.baseBranch.startsWith("(") || plan.baseBranch.startsWith("refs/")) {
		throw new Error("PR delivery requires the reviewed base branch captured by the plan; detached-base plans cannot publish");
	}
	await requireReviewedPrDestination(kit.loop.paths.root, plan, options.profilePath);
	const baseRef = assertBranchRef(`refs/heads/${plan.baseBranch}`);
	const check = await runGit(kit.loop.paths.root, ["check-ref-format", baseRef], { timeoutMs: 10_000 });
	if (check.code !== 0) throw new Error(`reviewed base branch ${JSON.stringify(plan.baseBranch)} is not a valid Git branch`);
}

/** Publish or reconcile a create-only branch and exact PR for the reviewed destination. */
export async function publishPullRequest(
	kit: LoopAndLock,
	wave: WaveKey,
	options: PrPublicationOptions,
): Promise<JournalOperationResult<Extract<JournalReceiptEvent, { kind: "delivery" }>>> {
	if (!options.deliverExplicit) throw new Error("PR publication requires explicit --deliver consent");
	if (kit.loop.config.delivery.mode !== "pr") throw new Error("PR publication requires reviewed delivery.mode = pr");
	const { state } = await assertCurrentTask(kit, wave);
	const plan = state.router.identity!;
	const grant = readGrant(state.runStatus);
	if (!grant || grant.planRevision !== wave.planRevision || !grant.selected.includes(wave.taskId)) {
		throw new Error("PR publication requires the current revision-qualified grant to include this task");
	}
	if (!plan.baseCommit) throw new Error("PR publication requires a reviewed base commit");
	const doc = await receiptSnapshot(kit);
	const prior = latestOf(doc, wave, "delivery");
	if (prior?.value.mode === "pr" && prior.value.deliveryOrigin === undefined) {
		throw new RecoveryRequiredError("legacy PR delivery receipt has no destination binding; preserve the journal and verify the original destination independently before manual recovery");
	}
	const integration = latestOf(doc, wave, "integrate");
	const acceptance = latestOf(doc, wave, "acceptance");
	if (!integration || integration.value.state !== "integrated" || !acceptance || acceptance.value.id !== integration.value.acceptedId) {
		throw new Error("PR publication requires the matching confirmed integration and acceptance receipts");
	}
	const root = kit.loop.paths.root;
	const commit = assertGitOid(integration.value.commit);
	const commitData = await readCommit(root, commit);
	assertJournalCommit(commitData, acceptance.value.tree, acceptance.value.parent);
	if (await readRef(root, acceptedRef(wave.planRevision)) !== commit) throw new RecoveryRequiredError("private accepted ref does not name the integrated commit");
	const parent = assertGitOid(commitData.parents[0]!);
	if (parent !== acceptance.value.parent) throw new RecoveryRequiredError("integration commit parent differs from the accepted candidate's recorded parent");
	await assertPublicTree(root, commitData.tree, "accepted candidate");
	await assertPublicTree(root, (await readCommit(root, parent)).tree, "integration parent");

	const authorizeDestination = () => requireReviewedPrDestination(root, plan, options.profilePath);
	const approved = await authorizeDestination();
	if (prior && prior.value.deliveryOrigin !== approved.origin) {
		throw new RecoveryRequiredError("durable PR delivery destination differs from the reviewed plan; inspect the original delivery intent");
	}
	const baseRef = await publicationBase(root, wave.planRevision, plan.baseCommit, plan.baseBranch, parent, doc, approved.origin);
	const headRef = assertBranchRef(deliveryBranchRef(wave));
	const identity: PullRequestIdentity = {
		repository: approved.repository,
		baseRef: shortHeadRef(baseRef),
		baseOid: parent,
		headRef: shortHeadRef(headRef),
		headOid: commit,
	};
	const git = options.gitTransport ?? new TrustedGitRemoteTransport(root);
	const host = options.prHost ?? new GhPullRequestHost(root);
	if (prior && (prior.value.acceptedId !== acceptance.value.id || prior.value.commit !== commit || prior.value.mode !== "pr"
		|| prior.value.ref !== headRef || prior.value.baseRef !== baseRef)) {
		throw new RecoveryRequiredError("PR delivery retry differs from its durable acceptance, commit, head, or stack base");
	}
	async function requireCurrentControls(): Promise<void> {
		const refusal = await reviewBindingRefusal(root, plan, kit.loop.config);
		if (refusal) throw new RecoveryRequiredError(`cannot start a new PR publication effect: ${refusal}`);
	}
	if (!prior) await requireCurrentControls();

	// Confirm the reviewed base still names exactly the expected parent. A base
	// movement is never repaired by selecting a newer origin tip.
	let observedBase: string | undefined;
	await authorizeDestination();
	try { observedBase = await git.readRemoteRef(approved.origin, baseRef); }
	catch (error) { throw new RecoveryRequiredError(`cannot query approved PR base ${baseRef}: ${(error as Error).message}`); }
	if (observedBase !== parent) throw new RecoveryRequiredError(`approved PR base ${baseRef} is ${observedBase ?? "absent"}, expected reviewed parent ${parent}`);

	let deliveryIntent = prior?.value;
	if (!deliveryIntent) {
		const event = await appendJournal(kit, wave, "delivery", (meta) => ({
			kind: "delivery", ...meta, value: {
				...wave, id: meta.opId, acceptedId: acceptance.value.id, commit, mode: "pr", state: "pending",
				ref: headRef, baseRef, deliveryOrigin: approved.origin, checkedAt: meta.at, code: "remote-ref-pending",
			},
		}), options, "delivery-intent");
		deliveryIntent = event.value;
	}

	let observedHead: string | undefined;
	await authorizeDestination();
	try { observedHead = await git.readRemoteRef(approved.origin, headRef); }
	catch (error) {
		if (deliveryIntent.state !== "published") await recordPrDeliveryState(kit, wave, deliveryIntent, "unknown", "remote-ref-unreadable", options);
		throw new RecoveryRequiredError(`cannot observe approved remote head ${headRef}: ${(error as Error).message}`);
	}
	if (observedHead !== undefined && observedHead !== commit) {
		if (deliveryIntent.state !== "published") await recordPrDeliveryState(kit, wave, deliveryIntent, "unknown", "remote-ref-conflict", options);
		throw new RecoveryRequiredError(`refusing conflicting existing remote head ${headRef}: ${observedHead}; expected exact commit ${commit}`);
	}
	// A durable pre-attempt intent can retry; after an attempt, absence could
	// mean the remote ref was deleted, so it must remain recovery-required.
	if (observedHead === undefined && (deliveryIntent.state === "published" || deliveryIntent.code !== "remote-ref-pending")) {
		// A prior intent means the create may already have happened and the ref
		// may since have been removed. Recreating it would be repair, not replay.
		if (deliveryIntent.state !== "published") await recordPrDeliveryState(kit, wave, deliveryIntent, "unknown", "remote-ref-missing-after-intent", options);
		throw new RecoveryRequiredError(`remote head ${headRef} is absent after a recorded publication intent; refusing to recreate or repair it`);
	}
	if (observedHead === undefined) {
		await requireCurrentControls();
		// Record that a push may have been attempted before calling the transport.
		// A subsequent absent head is uncertain, never blindly recreated.
		deliveryIntent = (await recordPrDeliveryState(kit, wave, deliveryIntent, "pending", "remote-ref-create-attempt", options)).receipt;
		// An empty-expected lease creates the ref atomically.
		// If the response is lost, readback decides whether the exact commit appeared.
		try {
			await fault(options, "pr-ref-create:before-effect");
			await authorizeDestination();
			await git.createRemoteRef(approved.origin, headRef, commit);
			await fault(options, "pr-ref-create:after-effect");
		} catch (error) {
			await authorizeDestination();
			const readback = await git.readRemoteRef(approved.origin, headRef).catch(() => undefined);
			if (readback !== commit) {
				await recordPrDeliveryState(kit, wave, deliveryIntent, "unknown", readback ? "remote-ref-conflict" : "remote-ref-create-uncertain", options);
				throw new RecoveryRequiredError(`create-only remote ref effect is uncertain (${(error as Error).message}); observed ${readback ?? "absence"}`);
			}
		}
		await authorizeDestination();
		observedHead = await git.readRemoteRef(approved.origin, headRef);
		if (observedHead !== commit) {
			await recordPrDeliveryState(kit, wave, deliveryIntent, "unknown", "remote-ref-readback-mismatch", options);
			throw new RecoveryRequiredError(`remote head readback is ${observedHead ?? "absent"}, not ${commit}`);
		}
	}

	// Persist the confirmed branch before any PR-host mutation. A crash before
	// the next intent can safely resume from the create-only branch observation.
	// Later ref errors may change the latest code without undoing a PR attempt.
	const prCreateMayHaveOccurred = prior !== undefined && doc.events.some((event) =>
		event.kind === "delivery" && event.key === prior.key
		&& (event.value.prNumber !== undefined || ["pr-create-intent", "pr-create-uncertain", "pr-identity-conflict"].includes(event.value.code ?? "")),
	);
	if (deliveryIntent.state !== "published" && !prCreateMayHaveOccurred) {
		deliveryIntent = (await recordPrDeliveryState(kit, wave, deliveryIntent, "pending", "remote-ref-confirmed", options)).receipt;
	}

	let records: RemotePullRequest[];
	await authorizeDestination();
	try { records = await host.findForHead(identity); }
	catch (error) {
		if (deliveryIntent.state !== "published") await recordPrDeliveryState(kit, wave, deliveryIntent, "unknown", prCreateMayHaveOccurred ? "pr-create-uncertain" : "pr-lookup-failed", options);
		throw new RecoveryRequiredError(`PR lookup failed; no blind create/retry will be made: ${(error as Error).message}`);
	}
	let found: RemotePullRequest | undefined;
	try { found = findExactPr(records, identity); }
	catch (error) {
		if (deliveryIntent.state !== "published") await recordPrDeliveryState(kit, wave, deliveryIntent, "unknown", "pr-identity-conflict", options);
		throw error;
	}
	if (prior?.value.state === "published") {
		if (found && prior.value.prNumber === found.number && prior.value.prUrl === found.url) {
			return { receipt: prior.value, event: prior };
		}
		throw new RecoveryRequiredError("the recorded published PR identity is no longer observable; refusing to replace it");
	}
	if (found) {
		return await recordPrDeliveryState(kit, wave, deliveryIntent, "published", undefined, options, found);
	}

	if (prCreateMayHaveOccurred) {
		await recordPrDeliveryState(kit, wave, deliveryIntent, "unknown", "pr-create-uncertain", options);
		throw new RecoveryRequiredError("no matching PR is currently observable after a possibly attempted/conflicting create; refusing a blind duplicate create");
	}
	await requireCurrentControls();
	const createIntent = (await recordPrDeliveryState(kit, wave, deliveryIntent, "pending", "pr-create-intent", options)).receipt;
	try {
		await fault(options, "pr-host-create:before-effect");
		await authorizeDestination();
		await host.create({
			...identity,
			title: `llm-toolkit-001: ${wave.taskId}`,
			body: `Automated candidate from reviewed plan ${wave.planRevision}.\n\nHead: ${commit}\nBase: ${parent}\n\nThis PR is not auto-merged.`,
		});
		await fault(options, "pr-host-create:after-effect");
	} catch (error) {
		// A timed-out create may have succeeded. Reconcile by repo/base/head/OID;
		// never repeat create merely because its response was lost.
		await authorizeDestination();
		const reconciled = await host.findForHead(identity).catch(() => undefined);
		if (reconciled) {
			try {
				const exact = findExactPr(reconciled, identity);
				if (exact) return await recordPrDeliveryState(kit, wave, createIntent, "published", undefined, options, exact);
			} catch (lookupError) {
				await recordPrDeliveryState(kit, wave, createIntent, "unknown", "pr-identity-conflict", options);
				throw lookupError;
			}
		}
		await recordPrDeliveryState(kit, wave, createIntent, "unknown", "pr-create-uncertain", options);
		throw new RecoveryRequiredError(`PR create response was lost or uncertain; retry will only look up this exact PR identity (${(error as Error).message})`);
	}

	let created: RemotePullRequest[];
	await authorizeDestination();
	try { created = await host.findForHead(identity); }
	catch (error) {
		await recordPrDeliveryState(kit, wave, createIntent, "unknown", "pr-create-uncertain", options);
		throw new RecoveryRequiredError(`PR create completed but its identity could not be queried: ${(error as Error).message}`);
	}
	let exact: RemotePullRequest | undefined;
	try { exact = findExactPr(created, identity); }
	catch (error) {
		await recordPrDeliveryState(kit, wave, createIntent, "unknown", "pr-identity-conflict", options);
		throw error;
	}
	if (!exact) {
		await recordPrDeliveryState(kit, wave, createIntent, "unknown", "pr-create-uncertain", options);
		throw new RecoveryRequiredError("PR create returned without an observable matching PR; it will not be repeated blindly");
	}
	return await recordPrDeliveryState(kit, wave, createIntent, "published", undefined, options, exact);
}

async function recordPrDeliveryState(
	kit: LoopAndLock,
	wave: WaveKey,
	intent: DeliveryReceipt,
	state: DeliveryReceipt["state"],
	code: string | undefined,
	options: JournalFaultOptions,
	pr?: RemotePullRequest,
): Promise<JournalOperationResult<Extract<JournalReceiptEvent, { kind: "delivery" }>>> {
	const event = await appendJournal(kit, wave, "delivery", (meta) => ({
		kind: "delivery", ...meta, value: {
			...wave, id: meta.opId, acceptedId: intent.acceptedId, commit: intent.commit, mode: "pr", state,
			...(intent.ref ? { ref: intent.ref } : {}), ...(intent.baseRef ? { baseRef: intent.baseRef } : {}),
			...(intent.deliveryOrigin !== undefined ? { deliveryOrigin: intent.deliveryOrigin } : {}),
			...(pr ? { prNumber: pr.number, prUrl: pr.url } : intent.prNumber !== undefined ? { prNumber: intent.prNumber, ...(intent.prUrl ? { prUrl: intent.prUrl } : {}) } : {}),
			checkedAt: meta.at, ...(code ? { code } : {}),
		},
	}), options, state === "pending" ? "delivery-intent" : "delivery-result");
	return { receipt: event.value, event };
}

/** Trusted Git implementation. It always receives the profile-approved URL and exact full refs. */
export class TrustedGitRemoteTransport implements RemoteGitTransport {
	constructor(private readonly root: string) {}

	async readRemoteRef(origin: string, ref: string): Promise<string | undefined> {
		assertBranchRef(ref);
		const result = await trustedGit(this.root, ["ls-remote", "--refs", origin, ref], 30_000);
		if (result.code !== 0) throw new Error(`git ls-remote failed: ${result.stderr.trim().slice(0, 500)}`);
		const rows = result.stdout.trim().split("\n").filter(Boolean);
		if (!rows.length) return undefined;
		if (rows.length !== 1) throw new Error(`remote query returned ambiguous rows for ${ref}`);
		const [oid, returnedRef] = rows[0]!.split("\t");
		if (returnedRef !== ref || !oid) throw new Error(`remote query returned a different ref than ${ref}`);
		return assertGitOid(oid);
	}

	async createRemoteRef(origin: string, ref: string, oid: string): Promise<void> {
		assertBranchRef(ref);
		assertGitOid(oid);
		// Empty expected OID means the destination ref must be absent. This lease
		// cannot overwrite a value; no remote name or update/repair path is exposed.
		const result = await trustedGit(this.root, [
			"push", "--porcelain", `--force-with-lease=${ref}:`, origin, `${oid}:${ref}`,
		], 120_000);
		if (result.code !== 0) throw new Error(`create-only git push failed: ${result.stderr.trim().slice(0, 500)}`);
	}
}

/** Host-resolved GitHub credential for delivery subprocesses only. */
function hostGitHubToken(): string | undefined {
	const token = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
	return typeof token === "string" && token.length > 0 ? token : undefined;
}

/** Trusted gh adapter; every operation pins --repo, --base, and --head explicitly. */
export class GhPullRequestHost implements PullRequestHost {
	constructor(private readonly root: string) {}

	async findForHead(identity: PullRequestIdentity): Promise<RemotePullRequest[]> {
		const result = await runGh(this.root, ["pr", "list", "--repo", identity.repository, "--head", identity.headRef,
			"--state", "all", "--json", "number,url,headRefName,headRefOid,baseRefName,baseRefOid,state"], {
			timeoutMs: 30_000,
			...(hostGitHubToken() !== undefined ? { gitHubToken: hostGitHubToken()! } : {}),
		});
		if (result.code !== 0 || result.stdoutCapped || result.stderrCapped) throw new Error(`gh pr list failed: ${result.stderr.trim().slice(0, 500)}`);
		let parsed: unknown;
		try { parsed = JSON.parse(result.stdout); } catch { throw new Error("gh pr list returned malformed JSON"); }
		if (!Array.isArray(parsed)) throw new Error("gh pr list returned a non-array response");
		return parsed.map((item) => {
			if (!item || typeof item !== "object") throw new Error("gh pr list returned a malformed PR identity");
			const row = item as Record<string, unknown>;
			if (typeof row["number"] !== "number" || typeof row["url"] !== "string" || typeof row["headRefName"] !== "string"
				|| typeof row["headRefOid"] !== "string" || typeof row["baseRefName"] !== "string" || typeof row["baseRefOid"] !== "string") {
				throw new Error("gh pr list omitted required repository/base/head OID fields");
			}
			return {
				repository: identity.repository, number: row["number"], url: row["url"],
				baseRef: row["baseRefName"], baseOid: assertGitOid(row["baseRefOid"]),
				headRef: row["headRefName"], headOid: assertGitOid(row["headRefOid"]),
				...(row["state"] === "OPEN" || row["state"] === "open" ? { state: "open" as const } : { state: "closed" as const }),
			};
		});
	}

	async create(identity: PullRequestIdentity & { title: string; body: string }): Promise<void> {
		const result = await runGh(this.root, ["pr", "create", "--repo", identity.repository, "--base", identity.baseRef,
			"--head", identity.headRef, "--title", identity.title, "--body", identity.body], {
			timeoutMs: 60_000,
			...(hostGitHubToken() !== undefined ? { gitHubToken: hostGitHubToken()! } : {}),
		});
		if (result.code !== 0) throw new Error(`gh pr create failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
	}
}

/**
 * One trusted Git remote invocation: the approved canonical origin, the
 * callback-free host environment, and (only for an HTTPS GitHub origin) the
 * absolute resolved gh credential helper. No PATH search, no inherited
 * credential/proxy/SSH state, no repository-controlled URL rewrite.
 */
async function trustedGit(root: string, args: string[], timeoutMs: number): Promise<Awaited<ReturnType<typeof runGit>>> {
	const origin = args[0] === "ls-remote" ? args[2] : args[0] === "push" ? args.at(-2) : undefined;
	if (!origin) throw new Error("trusted Git transport requires an explicit origin argument");
	let includeCredentials = false;
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(origin)) {
		const approved = parseApprovedGitHubOrigin(origin);
		if (approved.origin !== origin) throw new Error("trusted Git transport requires the canonical approved GitHub origin");
		includeCredentials = true;
	}
	// Transport must never load the source repository's local, included or
	// worktree config. Each invocation gets a fresh bare Git directory. A push
	// can read the source object database through an alternate, without importing
	// its refs or configuration.
	if (!includeCredentials && !isAbsolute(origin)) throw new Error("trusted Git transport requires an absolute fixture path or approved HTTPS origin");
	const transport = await mkdtemp(join(tmpdir(), "kit-pr-transport-"));
	try {
		const init = await runGit(root, ["init", "--bare", "--template=", transport], { timeoutMs: 10_000 });
		if (init.code !== 0) throw new Error(`cannot initialize isolated Git transport: ${init.stderr.trim()}`);
		if (args[0] === "push") {
			const objects = await runGit(root, ["rev-parse", "--path-format=absolute", "--git-path", "objects"], { timeoutMs: 10_000 });
			const path = objects.stdout.replace(/\n$/, "");
			if (objects.code !== 0 || !isAbsolute(path) || /[\r\n\0]/.test(path) || objects.stdoutCapped) {
				throw new Error("cannot identify the source Git object store for publication");
			}
			await writeFile(join(transport, "objects", "info", "alternates"), path + "\n", { flag: "wx" });
		}
		const token = includeCredentials ? hostGitHubToken() : undefined;
		const result = await runGit(root, [`--git-dir=${transport}`, "-c", "http.followRedirects=false", ...args], {
			timeoutMs,
			...(includeCredentials ? { credentialHelper: true } : {}),
			...(token !== undefined ? { gitHubToken: token } : {}),
		});
		if (result.timedOut || result.stdoutCapped || result.stderrCapped) throw new Error("trusted Git remote operation timed out or exceeded output limits");
		return result;
	} finally {
		await rm(transport, { recursive: true, force: true });
	}
}

/**
 * Discard only an explicitly fenced task lease. `discarded` is recorded only
 * after the private directory is absent and the accepted integration ref is
 * unchanged; every uncertain/error path remains a blocking journal receipt.
 */
export async function discardCandidateWorkspace(
	kit: LoopAndLock,
	input: WaveKey & { fencedWorkspace: FencedWorkspace; baseTree: string; producedTree?: string; expectedIntegrationCommit?: string | null },
	options: JournalFaultOptions = {},
): Promise<JournalOperationResult<Extract<JournalReceiptEvent, { kind: "rollback" }>>> {
	const { state } = await assertCurrentTask(kit, input);
	const lease = requireFencedWorkspace(input.fencedWorkspace);
	if (lease.root !== kit.loop.paths.root) throw new Error("rollback workspace does not belong to the open project root");
	const plan = state.router.identity!;
	if (!plan.baseCommit) throw new Error("rollback requires a reviewed base commit");
	const expected = input.expectedIntegrationCommit === undefined ? plan.baseCommit : input.expectedIntegrationCommit;
	assertGitOid(input.baseTree);
	if (input.producedTree !== undefined) assertGitOid(input.producedTree);
	if (expected !== null) assertGitOid(expected);
	const ref = acceptedRef(input.planRevision);
	const key = receiptKey(stageIdentity(input, "rollback"));
	const doc = await receiptSnapshot(kit);
	const prior = latestOf(doc, input, "rollback");
	if (prior && (prior.value.leaseId !== lease.id || prior.value.baseTree !== input.baseTree || prior.value.producedTree !== input.producedTree)) {
		throw new RecoveryRequiredError(`rollback journal key ${key} belongs to a different lease or tree pair`);
	}
	if (prior?.value.state === "discarded") {
		const directory = await observeLease(lease);
		const observedRef = await readRef(kit.loop.paths.root, ref).catch(() => undefined);
		if (directory !== "absent" || !sameRef(observedRef, expected)) {
			const error = new RecoveryRequiredError("previous discarded receipt no longer matches observed workspace/ref state");
			await appendRollback(kit, input, lease.id, input.baseTree, input.producedTree, "unknown", "recovery-required", options, "rollback-result");
			throw error;
		}
		return { receipt: prior.value, event: prior };
	}
	let current: string | undefined;
	try {
		current = await readRef(kit.loop.paths.root, ref);
	} catch (error) {
		await appendRollback(kit, input, lease.id, input.baseTree, input.producedTree, "unknown", "integration-ref-unreadable", options, "rollback-result");
		throw new RecoveryRequiredError(`cannot observe integration ref before rollback: ${(error as Error).message}`);
	}
	if (!sameRef(current, expected)) {
		await appendRollback(kit, input, lease.id, input.baseTree, input.producedTree, "unknown", "recovery-required", options, "rollback-result");
		throw new RecoveryRequiredError(`rollback requires unchanged integration ref ${expected ?? "absence"}, observed ${current ?? "absence"}`);
	}
	if (!prior) {
		await appendRollback(kit, input, lease.id, input.baseTree, input.producedTree, "pending", undefined, options, "rollback-intent");
	} else {
		await appendRollback(kit, input, lease.id, input.baseTree, input.producedTree, "pending", "retry", options, "rollback-intent");
	}
	try {
		if (await observeLease(lease) === "present") {
			await fault(options, "rollback-discard:before-effect");
			await discardWorkspace(lease);
			await fault(options, "rollback-discard:after-effect");
		}
		const absent = await observeLease(lease) === "absent";
		const afterRef = await readRef(kit.loop.paths.root, ref);
		if (!absent || !sameRef(afterRef, expected)) {
			throw new RecoveryRequiredError(`rollback cannot confirm disposal/ref fence (workspace=${absent ? "absent" : "present"}, integration=${afterRef ?? "absent"})`);
		}
	} catch (error) {
		const absent = await observeLease(lease).then((value) => value === "absent").catch(() => false);
		const afterRef = await readRef(kit.loop.paths.root, ref).catch(() => undefined);
		const stateValue: RollbackReceipt["state"] = absent && sameRef(afterRef, expected) ? "unknown" : error instanceof RecoveryRequiredError ? "unknown" : "failed";
		await appendRollback(kit, input, lease.id, input.baseTree, input.producedTree, stateValue,
			error instanceof RecoveryRequiredError ? "recovery-required" : "dispose-failed", options, "rollback-result");
		throw error;
	}
	return await appendRollback(kit, input, lease.id, input.baseTree, input.producedTree, "discarded", undefined, options, "rollback-result");
}

async function appendRollback(
	kit: LoopAndLock,
	input: WaveKey & { baseTree: string; producedTree?: string },
	leaseId: string,
	baseTree: string,
	producedTree: string | undefined,
	state: RollbackReceipt["state"],
	code: string | undefined,
	options: JournalFaultOptions,
	boundary: "rollback-intent" | "rollback-result",
): Promise<JournalOperationResult<Extract<JournalReceiptEvent, { kind: "rollback" }>>> {
	const event = await appendJournal(kit, input, "rollback", (meta) => ({
		kind: "rollback", ...meta, value: {
			planRevision: input.planRevision,
			taskId: input.taskId,
			wave: input.wave,
			id: meta.opId,
			baseTree,
			...(producedTree ? { producedTree } : {}),
			state, checkedAt: meta.at, leaseId, ...(code ? { code } : {}),
		},
	}), options, boundary);
	return { receipt: event.value, event };
}

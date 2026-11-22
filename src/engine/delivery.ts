/**
 * Delivery host operations. M0-P12 adds prepared journaled local integration,
 * discard, and publication helpers above; they are not wired into the serial
 * driver until P14. The legacy `runDelivery` implementation below intentionally
 * remains unchanged for the pre-cutover driver and is not the P12 guarantee.
 */
import { exec } from "../util/exec.ts";
import type { LoopAndLock } from "./harness.ts";
import { commitState, readGrant, readSessionState } from "./state.ts";
import type { ReceiptAttempt } from "./state.ts";
import type { WaveRow } from "./infos.ts";
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
	assertGitOid, compareAndSwapRef, createCommitObject, isBranchCheckedOut, readCommit, readRef, resolveTree,
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
	| "delivery-cas:before-effect" | "delivery-cas:after-effect";

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
	if (existing && existing.value.commit === commit && (existing.value.state === "published" || existing.value.state === "not_requested")) {
		return { receipt: existing.value, event: existing };
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

export interface DeliveryOutcome {
	mode: string;
	performed: boolean;
	ref?: string;
	detail?: string;
}

export async function runDelivery(
	kit: LoopAndLock,
	taskId: string,
	wave: number,
	options: { deliverExplicit?: boolean } = {},
): Promise<DeliveryOutcome> {
	const mode = kit.loop.config.delivery.mode;
	if (mode === "none") return { mode, performed: false };

	if (mode === "pr" && !options.deliverExplicit) {
		await commitState(kit, {
			rows: [
				{ ts: Date.now(), kind: "delivery", task: taskId, verb: "pr-skip", detail: 'delivery.mode="pr" requires the --deliver flag on the run command' },
			],
		});
		return { mode, performed: false, detail: "needs --deliver" };
	}

	if (mode === "commit") {
		return commitMode(kit, taskId, wave);
	}

	// mode === "pr"
	return prMode(kit, taskId, wave);
}

async function commitMode(kit: LoopAndLock, taskId: string, wave: number): Promise<DeliveryOutcome> {
	const root = kit.loop.paths.root;
	const message = `${projectName(kit)}: ${taskId} (wave ${wave})`;
	const add = await exec(["git", "add", "-A"], { cwd: root, timeoutMs: 30_000 });
	if (add.code !== 0) {
		await commitState(kit, { rows: rows(kit, taskId, "commit-failed", add.stderr.slice(0, 200)) });
		return { mode: "commit", performed: false, detail: "git add failed" };
	}
	const commit = await exec(["git", "commit", "-m", message], { cwd: root, timeoutMs: 60_000 });
	if (commit.code !== 0) {
		await commitState(kit, { rows: rows(kit, taskId, "commit-failed", commit.stderr.slice(0, 200)) });
		return { mode: "commit", performed: false, detail: "git commit failed (nothing to commit?)" };
	}
	return finish(kit, taskId, undefined, `committed: ${message}`);
}

async function prMode(kit: LoopAndLock, taskId: string, wave: number): Promise<DeliveryOutcome> {
	const root = kit.loop.paths.root;
	const branch = `kit/${taskId}-w${wave}`;
	const message = `${projectName(kit)}: ${taskId} (wave ${wave})`;

	const head = await exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, timeoutMs: 15_000 });
	const previous = (head.stdout || "main").trim();
	const checkout = await exec(["git", "checkout", "-b", branch], { cwd: root, timeoutMs: 30_000 }); // keeps working tree
	if (checkout.code !== 0) {
		await commitState(kit, { rows: rows(kit, taskId, "pr-failed", checkout.stderr.slice(0, 200)) });
		return { mode: "pr", performed: false, detail: "branch creation failed" };
	}
	await exec(["git", "add", "-A"], { cwd: root, timeoutMs: 30_000 });
	const commit = await exec(["git", "commit", "-m", message], { cwd: root, timeoutMs: 60_000 });
	if (commit.code !== 0) {
		await exec(["git", "checkout", previous], { cwd: root, timeoutMs: 30_000 });
		await commitState(kit, { rows: rows(kit, taskId, "pr-failed", commit.stderr.slice(0, 200)) });
		return { mode: "pr", performed: false, detail: "commit failed" };
	}
	const push = await exec(["git", "push", "-u", "origin", branch], { cwd: root, timeoutMs: 120_000 });
	if (push.code !== 0) {
		await exec(["git", "checkout", previous], { cwd: root, timeoutMs: 30_000 });
		await commitState(kit, { rows: rows(kit, taskId, "pr-failed", push.stderr.slice(0, 200)) });
		return { mode: "pr", performed: false, detail: "push failed" };
	}
	const pr = await exec(["gh", "pr", "create", "--fill", "--head", branch], { cwd: root, timeoutMs: 60_000 });
	if (pr.code !== 0) {
		await exec(["git", "checkout", previous], { cwd: root, timeoutMs: 30_000 });
		await commitState(kit, { rows: rows(kit, taskId, "pr-failed", (pr.stderr || pr.stdout).slice(0, 200)) });
		return { mode: "pr", performed: false, detail: "gh pr create failed" };
	}
	const ref = (pr.stdout || "").trim();
	await exec(["git", "checkout", previous], { cwd: root, timeoutMs: 30_000 });
	return finish(kit, taskId, branch, `${ref} (back on ${previous})`);
}

async function finish(kit: LoopAndLock, taskId: string, branch: string | undefined, detail: string): Promise<DeliveryOutcome> {
	await commitState(kit, {
		rows: [{ ts: Date.now(), kind: "delivery", task: taskId, verb: "delivered", detail }],
	});
	return { mode: kit.loop.config.delivery.mode, performed: true, ref: branch, detail };
}

function rows(kit: LoopAndLock, taskId: string, verb: string, detail: string): WaveRow[] {
	return [{ ts: Date.now(), kind: "delivery", task: taskId, verb, detail }];
}

/** Use the project name recorded at init (package.json / cwd basename). */
function projectName(kit: LoopAndLock): string {
	const name = (kit.loop.config as unknown as { name?: string }).name;
	if (name) return name;
	return basename(kit.loop.paths.root);
}

function basename(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}

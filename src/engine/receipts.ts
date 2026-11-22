/**
 * Receipts (M0-P11, §3 transition protocol): the `loop.receipts` session doc —
 * a tagged union of durable observations recorded with the Router/Run mutation
 * they authorize, each with a stable operation ID and timestamp. P11 adds GATE
 * and PASS events; P12 adds ACCEPTANCE, INTEGRATE, ROLLBACK, and DELIVERY
 * journal events with stable per-stage keys, attempt ordinals, and latest
 * pointers. P11 event shapes remain unchanged; later packets may add
 * resolution/checkpoint kinds additively.
 *
 * Bindings: receipts reference the candidate (checked tree), the gate receipt,
 * the effective verification policy, and the plan's reviewed controls digest.
 * Raw output/tails stay out of documents — the gate log and wave log carry them.
 */
import { randomUUID } from "node:crypto";
import { defineDoc } from "./kit.ts";

/** {planRevision, taskId, wave} — a manual retry never reuses a wave number. */
export type WaveKey = { planRevision: string; taskId: string; wave: number };

/** One deterministic check outcome inside a gate receipt. */
export type GateCheck = {
	id: string;
	kind: "scope" | "recipe";
	outcome: "pass" | "fail" | "skip" | "error";
	exit: number | null;
	ms: number;
};

/** §3 EvidenceRef: where an approving pass claims its proof lives. */
export type EvidenceRef =
	| { kind: "gate"; id: string }
	| { kind: "line"; path: string; line: number };

/**
 * §3 CriterionResult: the criterion id is the EXACT 1-based index in the
 * reviewed task's ordered acceptance array (never renumbered after review).
 */
export type CriterionResult = {
	id: string;
	status: "pass" | "fail" | "unverifiable";
	evidence: EvidenceRef[];
};

/** One read-only pass as recorded (effective verdict after host validation). */
export type ReviewPass = {
	pass: "primary" | "skeptic" | "human";
	verdict: "approve" | "reject" | "needs_human";
	criteria: CriterionResult[];
	notes: string;
	conversationId?: number;
};

/**
 * The verification policy bound to each pass. `always` | `never` map the
 * current `[gates] skepticSecondPass` boolean; `risk-v1` arrives with routing,
 * `human-v1` with the human resolution path.
 */
export type VerifierPolicy = "always" | "risk-v1" | "never" | "human-v1";

/** Gate receipt: the checked tree plus every check outcome observed on it. */
export type GateReceipt = WaveKey & {
	id: string;
	tree: string;
	/** Digest of the reviewed control bundle; ABSENT when the plan has no approved control input (distinct from empty). */
	controlsSha256?: string;
	checks: GateCheck[];
};

/** Pass receipt: one verifier pass bound to the candidate, gate, and policy. */
export type PassReceipt = WaveKey & {
	id: string;
	tree: string;
	gateId: string;
	policy: VerifierPolicy;
	review: ReviewPass;
};

/** Acceptance decision about one exact checked candidate (§3 transition 4). */
export type AcceptanceReceipt = WaveKey & {
	id: string;
	parent: string;
	tree: string;
	gateId: string;
	controlsSha256?: string;
	policy: VerifierPolicy;
	required: ("primary" | "skeptic" | "human")[];
	passes: ReviewPass[];
	authority: "verifier" | "human";
	at: number;
	reason?: string;
};

/** Durable integration intent + the host's latest observation of its CAS. */
export type IntegrationIntent = WaveKey & {
	acceptedId: string;
	parent: string;
	candidate: string;
	commit: string;
	at: number;
};
export type IntegrationReceipt = IntegrationIntent & {
	state: "pending" | "integrated" | "failed" | "unknown";
	code?: string;
};

/** Workspace-disposal receipt; `leaseId` is a host-created workspace identity. */
export type RollbackReceipt = WaveKey & {
	id: string;
	baseTree: string;
	producedTree?: string;
	state: "pending" | "discarded" | "failed" | "unknown";
	checkedAt: number;
	code?: string;
	leaseId?: string;
};

/** Separates local/none acknowledgment from a confirmed local branch update. */
export type DeliveryReceipt = WaveKey & {
	id: string;
	acceptedId: string;
	commit: string;
	mode: "none" | "commit" | "pr";
	state: "not_requested" | "pending" | "published" | "failed" | "unknown";
	ref?: string;
	baseRef?: string;
	prNumber?: number;
	prUrl?: string;
	checkedAt: number;
	code?: string;
};

export type Resolution = WaveKey & { action: "retry" | "accept-tree"; reason: string; evidenceSha256?: string; tree?: string };
export type Checkpoint = WaveKey & {
	stage: "implement" | "gates" | "primary" | "skeptic" | "integrate" | "publish" | "rollback" | "terminal";
	parent: string;
	startTree: string;
	candidate?: string;
	conversationId?: number;
	submissionKey?: string;
	leaseId?: string;
	grantedFeedbackIds: string[];
};

export type ReceiptPayloads = {
	gate: GateReceipt;
	pass: PassReceipt;
	acceptance: AcceptanceReceipt;
	integrate: IntegrationReceipt;
	rollback: RollbackReceipt;
	delivery: DeliveryReceipt;
	resolution: Resolution;
	checkpoint: Checkpoint;
};

/** The four mutable journal stages get an address and per-key attempt ordinal.
 *  P11 gate/pass events intentionally retain their original wrapper shape. */
export type JournalReceiptKind = "acceptance" | "integrate" | "rollback" | "delivery";
export type JournalReceiptEvent = {
	[K in JournalReceiptKind]: { kind: K; opId: string; at: number; key: string; ordinal: number; value: ReceiptPayloads[K] }
}[JournalReceiptKind];
export type ReceiptEvent =
	| { kind: "gate"; opId: string; at: number; value: GateReceipt }
	| { kind: "pass"; opId: string; at: number; value: PassReceipt }
	| JournalReceiptEvent;

export type ReceiptStage = JournalReceiptKind;
export type ReceiptIdentity = WaveKey & { stage: ReceiptStage };
export type ReceiptLatest = { opId: string; ordinal: number };
export type ReceiptsDocValue = { version: 1; events: ReceiptEvent[]; latest?: Record<string, ReceiptLatest> };

const REVISION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TASK_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Stable journal address: the key is independent of attempts and timestamps. */
export function receiptKey(identity: ReceiptIdentity): string {
	if (!REVISION_RE.test(identity.planRevision)) throw new Error("receipt key requires a lowercase planRevision UUIDv4");
	if (!TASK_RE.test(identity.taskId)) throw new Error(`receipt key has an invalid task id ${JSON.stringify(identity.taskId)}`);
	if (!Number.isSafeInteger(identity.wave) || identity.wave < 1) throw new Error("receipt key requires a positive safe-integer wave");
	return `${identity.planRevision}/${identity.taskId}/${identity.wave}/${identity.stage}`;
}

/** Latest event by journal key, falling back to event history for pre-index docs. */
export function latestJournalEvent(doc: ReceiptsDocValue, key: string): JournalReceiptEvent | undefined {
	const pointer = doc.latest?.[key];
	if (pointer) {
		const event = doc.events.find((candidate): candidate is JournalReceiptEvent =>
			"key" in candidate && candidate.opId === pointer.opId && candidate.key === key && candidate.ordinal === pointer.ordinal,
		);
		if (event) return event;
	}
	return doc.events
		.filter((event): event is JournalReceiptEvent => "key" in event && event.key === key)
		.sort((a, b) => b.ordinal - a.ordinal)[0];
}

export const ReceiptsDoc = defineDoc({
	kind: "loop.receipts",
	version: 1,
	scope: "session",
	initial: (): ReceiptsDocValue => ({ version: 1, events: [] }),
	checkpointWhen: () => true, // small typed observations; no output/patch bytes
});

/** One receipt = one operation: the receipt id IS the event's operation id. */
export function gateReceiptEvent(
	waveKey: WaveKey,
	value: { tree: string; controlsSha256?: string; checks: GateCheck[] },
): Extract<ReceiptEvent, { kind: "gate" }> {
	const id = randomUUID();
	// Optional means omit: a plan without approved controls records no digest.
	const receipt: GateReceipt = value.controlsSha256 === undefined
		? { ...waveKey, id, tree: value.tree, checks: [...value.checks] }
		: { ...waveKey, id, tree: value.tree, controlsSha256: value.controlsSha256, checks: [...value.checks] };
	return { kind: "gate", opId: id, at: Date.now(), value: receipt };
}

export function passReceiptEvent(
	waveKey: WaveKey,
	value: { tree: string; gateId: string; policy: VerifierPolicy; review: ReviewPass },
): Extract<ReceiptEvent, { kind: "pass" }> {
	const id = randomUUID();
	const review: ReviewPass = value.review.conversationId === undefined
		? { ...value.review, pass: value.review.pass, criteria: [...value.review.criteria] }
		: { ...value.review, pass: value.review.pass, criteria: [...value.review.criteria], conversationId: value.review.conversationId };
	const receipt: PassReceipt = { ...waveKey, id, tree: value.tree, gateId: value.gateId, policy: value.policy, review };
	return { kind: "pass", opId: id, at: Date.now(), value: receipt };
}

/**
 * Map the gate runner's results onto receipt checks. A skipped check is never
 * evidence; an invalid/timeout/aborted run is an `error`, not a `fail`.
 */
export function gateCheckFromResult(result: {
	name: string;
	skipped?: string;
	passed: boolean;
	exit?: number | null;
	reason?: string;
	durationMs: number;
}): GateCheck {
	const outcome = result.skipped !== undefined
		? "skip" as const
		: result.passed
			? "pass" as const
			: result.reason !== undefined && /^\[(invalid|timeout|abort)\]/.test(result.reason)
				? "error" as const
				: "fail" as const;
	return {
		id: result.name,
		kind: result.name === "scope" ? "scope" : "recipe",
		outcome,
		exit: result.exit ?? null,
		ms: result.durationMs,
	};
}

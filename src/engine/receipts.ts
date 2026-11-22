/**
 * Receipts (M0-P11, §3 transition protocol): the `loop.receipts` session doc —
 * a tagged union of durable observations recorded with the Router/Run mutation
 * they authorize, each with a stable operation ID and timestamp. P11 introduces
 * the GATE and PASS events: a gate receipt binds the checked tree and its
 * per-check outcomes; a pass receipt binds one read-only verifier pass
 * (criteria, effective verdict, policy) to that gate receipt and candidate.
 * Later packets extend the union (acceptance/intent/rollback/delivery/
 * resolution/checkpoint); the payload shape is additive per kind.
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

/** P11 union: gate + pass. Later receipt packets extend this union. */
export type ReceiptEvent =
	| { kind: "gate"; opId: string; at: number; value: GateReceipt }
	| { kind: "pass"; opId: string; at: number; value: PassReceipt };

export type ReceiptsDocValue = { version: 1; events: ReceiptEvent[] };

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
): ReceiptEvent {
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
): ReceiptEvent {
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

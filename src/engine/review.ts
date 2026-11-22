/**
 * Criterion evidence (M0-P11, §1 ADR 02): host-side validation of an approving
 * verifier pass against the checked tree. Each *required* approving pass —
 * primary and skeptic alike — needs exactly one entry per reviewed criterion
 * (unique, exact 1-based ids) and at least one valid evidence reference per
 * criterion: a gate that actually executed, was not skipped, and passed on the
 * checked tree (the scope check alone is never criterion evidence), or a line
 * that exists in a regular UTF-8 text blob of the checked tree. Neither is
 * recomputed from the operator's checkout. A well-formed explicit reject needs
 * no proof; approvals fail closed to `needs_human`.
 */
import { readBlob, readTreeEntries } from "../util/git-objects.ts";
import type { CriterionResult, EvidenceRef, GateCheck, ReviewPass } from "./receipts.ts";

/** One parsed reply criterion. Malformed entries are PRESERVED (never
 * filtered): an approving verdict citing one is refused, not repaired. */
export interface CriterionReply {
	id: string;
	status: "pass" | "fail" | "unverifiable";
	evidence: EvidenceRef[];
	/** The raw reply entry deviated from the required shape. */
	malformed: boolean;
}

/** Host inputs both read-only passes receive independently (M0-P11). */
export interface CriterionEvidenceContext {
	/** Control root owning the Git object database (never a worker cwd). */
	root: string;
	/** The checked tree: the frozen candidate the gates ran against. */
	checkedTree: string;
	/** The gate receipt's checks — every outcome, skipped included. */
	checks: readonly GateCheck[];
}

/** Citable gate ids: executed, non-scope, non-skipped, passed. */
export function citableGateIds(checks: readonly GateCheck[]): string[] {
	return checks.filter((c) => c.kind === "recipe" && c.outcome === "pass").map((c) => c.id);
}

/** Normalize a parsed reply into the receipt's CriterionResult shape (1:1). */
export function toCriterionResult(reply: CriterionReply): CriterionResult {
	return { id: reply.id, status: reply.status, evidence: reply.evidence };
}

interface TreeIndex {
	entries: Map<string, { oid: string; mode: string; type: string }>;
	texts: Map<string, string>;
}

async function treeIndex(root: string, tree: string): Promise<TreeIndex> {
	const rows = await readTreeEntries(root, tree);
	const entries = new Map<string, { oid: string; mode: string; type: string }>();
	for (const row of rows) entries.set(row.path, { oid: row.oid, mode: row.mode, type: row.type });
	return { entries, texts: new Map() };
}

/** A "safe text blob" is a regular file (no symlink/submodule), decodable UTF-8, with no NUL bytes. */
async function safeTextLineCount(root: string, index: TreeIndex, path: string): Promise<number | undefined> {
	const entry = index.entries.get(path);
	if (!entry || entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) return undefined;
	const cached = index.texts.get(entry.oid);
	if (cached !== undefined) return countLines(cached);
	const bytes = await readBlob(root, entry.oid);
	const text = bytes.toString("utf8");
	if (bytes.includes(0) || !Buffer.from(text, "utf8").equals(bytes)) return undefined;
	index.texts.set(entry.oid, text);
	return countLines(text);
}

function countLines(text: string): number {
	if (text === "") return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * Why this approving pass is refused, or undefined when every reviewed
 * criterion is explicitly passed with valid evidence on the checked tree.
 */
export async function validateApprovingCriteria(
	criteria: readonly CriterionReply[],
	acceptance: readonly string[],
	context: CriterionEvidenceContext,
): Promise<string | undefined> {
	const total = acceptance.length;
	if (total === 0) return "the task has no acceptance criteria to prove";
	for (let i = 0; i < total; i++) {
		if (!acceptance[i]!.trim()) return `acceptance criterion ${i + 1} is empty — an empty criterion cannot be proven`;
	}
	const citable = new Set(citableGateIds(context.checks));
	const seen = new Set<string>();
	// One tree read per validation, built only when a line reference must resolve.
	let indexPromise: Promise<TreeIndex> | undefined;
	const index = (): Promise<TreeIndex> => (indexPromise ??= treeIndex(context.root, context.checkedTree));
	for (const criterion of criteria) {
		if (criterion.malformed) {
			return `criterion entry ${JSON.stringify(criterion.id || "(no id)")} deviates from the required {id, status, evidence[]} shape — malformed entries are never filtered`;
		}
		if (!criterion.id) return "a criteria entry lacks an id";
		if (!/^[1-9][0-9]*$/.test(criterion.id) || Number(criterion.id) > total) {
			return `criterion id ${JSON.stringify(criterion.id)} is not one of the reviewed criteria 1–${total}`;
		}
		if (seen.has(criterion.id)) return `criterion ${criterion.id} appears more than once in the approval`;
		seen.add(criterion.id);
		if (criterion.status !== "pass") {
			return `approval is inconclusive: criterion ${criterion.id} is marked ${criterion.status}, not pass`;
		}
		if (criterion.evidence.length === 0) return `criterion ${criterion.id} cites no evidence`;
		for (const ref of criterion.evidence) {
			const refusal = await evidenceRefRefusal(ref, context, citable, index);
			if (refusal) return `criterion ${criterion.id}: ${refusal}`;
		}
	}
	for (let i = 1; i <= total; i++) {
		if (!seen.has(String(i))) return `criterion ${i} has no entry in the approval`;
	}
	return undefined;
}

async function evidenceRefRefusal(
	ref: EvidenceRef,
	context: CriterionEvidenceContext,
	citable: ReadonlySet<string>,
	index: () => Promise<TreeIndex>,
): Promise<string | undefined> {
	if (ref.kind === "gate") {
		if (!citable.has(ref.id)) {
			return `gate reference ${JSON.stringify(ref.id)} is not an executed, non-scope, non-skipped passing check on the checked tree`;
		}
		return undefined;
	}
	const lineCount = await safeTextLineCount(context.root, await index(), ref.path);
	if (lineCount === undefined || ref.line < 1 || ref.line > lineCount) {
		return `line reference ${ref.path}:${ref.line} does not exist in a safe text blob on the checked tree`;
	}
	return undefined;
}

/** Enforce the pass symmetry: an approving verdict is validated; an explicit
 * well-formed reject/needs_human stands as parsed. Returns the effective pass. */
export async function enforceCriterionEvidence<T extends { verdict: string; criteria: readonly CriterionReply[]; notes: string }>(
	parsed: T,
	acceptance: readonly string[],
	context: CriterionEvidenceContext,
	refuse: (reason: string) => T,
): Promise<T> {
	if (parsed.verdict !== "approve") return parsed;
	const refusal = await validateApprovingCriteria(parsed.criteria, acceptance, context);
	return refusal ? refuse(refusal) : parsed;
}

/** ReviewPass for the receipt: effective verdict + original criteria (1:1). */
export function reviewPass(
	pass: ReviewPass["pass"],
	result: { verdict: string; criteria: readonly CriterionReply[]; notes: string },
	conversationId?: number,
): ReviewPass {
	return conversationId === undefined
		? { pass, verdict: result.verdict as ReviewPass["verdict"], criteria: result.criteria.map(toCriterionResult), notes: result.notes }
		: { pass, verdict: result.verdict as ReviewPass["verdict"], criteria: result.criteria.map(toCriterionResult), notes: result.notes, conversationId };
}

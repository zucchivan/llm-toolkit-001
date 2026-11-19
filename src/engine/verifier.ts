/**
 * Verifier (§4.4): one read-only conversation per verdict. Input: task spec +
 * acceptance criteria + diff stat vs the task's baseline tree + the changed
 * file list + gate results summary. Output: STRICT JSON verdict, parsed
 * defensively; unparseable JSON is `needs_human`, never a silent approve.
 * beforeTool guard blocks anything but `read` (belt & suspenders over the
 * `[read]`-only tool selection).
 */
import { exec } from "../util/exec.ts";
import { diffStatVsTree } from "../util/git.ts";
import { ConversationKit } from "./conversations.ts";
import type { LoopAndLock } from "./harness.ts";
import { commitState } from "./state.ts";
import type { GateResult } from "./gates.ts";
import type { WaveRow } from "./infos.ts";

export type Verdict = "approve" | "reject" | "needs_human";

export interface VerifyResult {
	verdict: Verdict;
	criteria: { id: string; status: "pass" | "fail" | "unverifiable" }[];
	notes: string;
}

export const VERIFY_ROLE_BRIEF = `You are the VERIFIER of an implementation-loop kit. You are read-only: you will never edit files.
Judge whether the wave's changes implement the task spec and satisfy every acceptance criterion.

Read files if you need to (you have the read tool). Then reply with ONE JSON object and nothing else:

{
  "verdict": "approve" | "reject" | "needs_human",
  "criteria": [{ "id": "<criterion number, 1-based>", "status": "pass" | "fail" | "unverifiable" }],
  "notes": "<= 300 chars; concrete blockers when rejecting"
}

approve = every criterion passes. reject = a criterion fails and is fixable by another wave; the notes
must say exactly what to change. needs_human = you cannot judge from the diff/spec (ambiguous spec,
design decision, credentials, flaky external). Never approve on partial evidence.`;

export const SKEPTIC_ROLE_BRIEF = `You are the ADVERSARIAL VERIFIER of an implementation-loop kit. You are read-only: you will never edit files.
Assume the primary verifier missed a subtle defect. Try to refute approval rather than repeating its reasoning.

Independently check every acceptance criterion and look for regressions, edge cases, missing tests,
changes outside the task's target paths, and security or data-loss risks. Read any files you need with
the read tool. Then reply with ONE JSON object and nothing else:

{
  "verdict": "approve" | "reject" | "needs_human",
  "criteria": [{ "id": "<criterion number, 1-based>", "status": "pass" | "fail" | "unverifiable" }],
  "notes": "<= 300 chars; concrete blockers when rejecting"
}

approve only after independently confirming that every acceptance criterion passes and finding no
refutation. reject a fixable defect and say exactly what to change. needs_human is mandatory when
evidence is missing, ambiguous, or inconclusive. Incomplete or unverifiable criteria can never approve.`;

export interface VerifyTask {
	id: string;
	title: string;
	spec: string;
	acceptance: string[];
	baselineTreeSha: string;
	targetPaths: string[];
}

/** Diff vs baseline (so uncommitted prior waves never bleed into this verdict). */
async function diffVsBaseline(root: string, baseline: string): Promise<{ stat: string; files: string[] }> {
	const stat = await diffStatVsTree(root, baseline);
	const list = await exec(["git", "diff", "--name-only", baseline], { cwd: root, timeoutMs: 30_000 });
	return { stat, files: (list.stdout || "").trim().split("\n").filter(Boolean) };
}

export async function runVerify(kit: LoopAndLock, task: VerifyTask, gateSummary: string, options: { skepticSecondPass?: boolean } = {}): Promise<VerifyResult> {
	const diff = await diffVsBaseline(kit.loop.paths.root, task.baselineTreeSha);
	const criteriaIds = task.acceptance.map((a, i) => `${i + 1}`);
	const skepticSecondPass = options.skepticSecondPass ?? kit.loop.config.gates.skepticSecondPass;

	const content = [
		`TASK ${task.id}: ${task.title}`,
		`SPEC:\n${task.spec}`,
		`AIMED AT PATHS: ${task.targetPaths.length ? task.targetPaths.join(", ") : "(whole repo)"}`,
		`ACCEPTANCE CRITERIA:\n${task.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}`,
		`DIFF VS BASELINE (${task.baselineTreeSha.slice(0, 12)}) STAT:\n${diff.stat || "(no file content changes)"}`,
		`CHANGED FILES: ${diff.files.slice(0, 40).join(", ") || "(none)"}`,
		`GATE RESULTS: ${gateSummary || "(no deterministic gates ran)"}`,
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
	});
	const outcome = await kitConv.submitAndAwait(conv, `verify-${task.id}-${Date.now()}`, content);
	const primary = parseVerdictStrict(outcome.answer ?? "");
	let parsed = primary;
	const rows: WaveRow[] = [];
	const recordVerdict = (pass: "primary" | "skeptic", result: VerifyResult, usage: { usd: number; totalTokens: number }) => {
		rows.push({
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
		});
	};
	recordVerdict("primary", primary, outcome.usage);

	// Default-on defense in depth: approval requires a second, fresh read-only
	// conversation. Its own verdict and usage stay visible in the wave log.
	if (skepticSecondPass && primary.verdict === "approve") {
		const convTwo = await kitConv.createUnit({
			instructions: SKEPTIC_ROLE_BRIEF,
			guard: { role: "verifier", targetPaths: [] },
			tools: "read",
			model: { provider: role.provider, modelId: role.modelId, thinkingLevel: role.thinkingLevel },
			maxTurns: kit.loop.config.engine.maxTurns,
		});
		const outcomeTwo = await kitConv.submitAndAwait(convTwo, `verify-${task.id}-skeptic-${Date.now()}`, content);
		let parsedTwo = parseVerdictStrict(outcomeTwo.answer ?? "");
		if (parsedTwo.verdict === "approve" && !isConclusiveApproval(parsedTwo, criteriaIds)) {
			parsedTwo = {
				...parsedTwo,
				verdict: "needs_human",
				notes: "skeptic approval was inconclusive: every acceptance criterion must be explicitly marked pass",
			};
		}
		recordVerdict("skeptic", parsedTwo, outcomeTwo.usage);
		if (parsedTwo.verdict !== "approve") parsed = { ...parsedTwo, notes: `skeptic pass: ${parsedTwo.notes}`.slice(0, 300) };
	}

	await commitState(kit, { rows });
	return parsed;
}

/** An adversarial approval is conclusive only with one explicit pass per criterion. */
function isConclusiveApproval(result: VerifyResult, criteriaIds: readonly string[]): boolean {
	return result.criteria.length === criteriaIds.length
		&& criteriaIds.every((id) => result.criteria.some((criterion) => criterion.id === id && criterion.status === "pass"));
}

/** Defensive parse: fences stripped; malformed → needs_human (never approve). */
export function parseVerdictStrict(text: string): VerifyResult {
	try {
		const cleaned = text
			.replace(/^\s*```(?:json)?\s*/i, "")
			.replace(/```\s*$/, "")
			.trim();
		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start < 0 || end <= start) throw new Error("no JSON object in verifier reply");
		const raw = JSON.parse(cleaned.slice(start, end + 1)) as {
			verdict?: unknown;
			criteria?: unknown;
			notes?: unknown;
		};
		if (raw.verdict !== "approve" && raw.verdict !== "reject" && raw.verdict !== "needs_human") {
			throw new Error("verdict is not one of approve|reject|needs_human");
		}
		const criteria = Array.isArray(raw.criteria)
			? (raw.criteria as unknown[]).flatMap((c) => {
					if (typeof c !== "object" || c === null) return [];
					const o = c as { id?: unknown; status?: unknown };
					if (typeof o["id"] !== "string") return [];
					const status: "pass" | "fail" | "unverifiable" = o["status"] === "pass" || o["status"] === "fail" ? o["status"] : "unverifiable";
					return [{ id: o["id"], status }];
				})
			: [];
		return {
			verdict: raw.verdict,
			criteria,
			notes: typeof raw.notes === "string" ? raw.notes.slice(0, 300) : "",
		};
	} catch {
		return {
			verdict: "needs_human",
			criteria: [],
			notes: "verifier reply was not the expected JSON verdict — check .orch/artifacts and the wave log",
		};
	}
}

/** Compact one-line gate summary for the verifier prompt. */
export function gateSummaryText(results: readonly GateResult[]): string {
	return results
		.filter((r) => !r.skipped)
		.map((r) => `${r.name}: ${r.passed ? "pass" : "fail"}`)
		.join(", ");
}

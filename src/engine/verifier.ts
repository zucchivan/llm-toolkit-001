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
import type { LoopAndLock, ToolRegistration } from "./harness.ts";
import { commitState } from "./state.ts";
import type { GateResult } from "./gates.ts";

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

export async function runVerify(kit: LoopAndLock, task: VerifyTask, gateSummary: string, toolBoxOverride?: { read: ToolRegistration }): Promise<VerifyResult> {
	const diff = await diffVsBaseline(kit.loop.paths.root, task.baselineTreeSha);
	const criteriaIds = task.acceptance.map((a, i) => `${i + 1}`);

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

	const kitConv = new ConversationKit(kit, {
		...kit.loop.toolBox,
		read: toolBoxOverride?.read ?? kit.loop.toolBox.read,
	});
	const role = kit.loop.config.roles.verifier;
	const conv = await kitConv.createUnit({
		instructions: VERIFY_ROLE_BRIEF,
		guard: { role: "verifier", targetPaths: [] },
		tools: "read",
		model: { provider: role.provider, modelId: role.modelId, thinkingLevel: role.thinkingLevel },
		maxTurns: kit.loop.config.engine.maxTurns,
	});
	const outcome = await kitConv.submitAndAwait(conv, `verify-${task.id}-${Date.now()}`, content);
	const parsed = parseVerdictStrict(outcome.answer ?? "");

	await commitState(kit, {
		rows: [
			{
				ts: Date.now(),
				kind: "verdict",
				task: task.id,
				verb: `verify:${parsed.verdict}`,
				verdict: parsed.verdict,
				detail: parsed.notes,
				provider: role.provider,
				modelId: role.modelId,
				costUsd: outcome.usage.usd,
				tokens: outcome.usage.totalTokens,
			},
		],
	});
	return parsed;
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

/**
 * Planner (§4.1): PRD → RouterDoc in ONE planning conversation on the planner
 * role model with read tools only. Commits RouterDoc ("planned") + RunStatus
 * provenance + wave-log row via commitState, mirrors router.md, and stops for
 * human approval (`run --approve` or a stamped humanApprovedAt).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConversationKit } from "./conversations.ts";
import type { LoopAndLock, ToolRegistration } from "./harness.ts";
import { commitState } from "./state.ts";
import { shasum } from "../util/git.ts";
import type { RouterTask, RouterDocValue } from "./infos.ts";
import { KIT_VERSION } from "../config.ts";

export class PlanParseError extends Error {}

const PLANNER_BRIEF = `You are the planner of an implementation-loop kit: one iteration-per-task pipeline.
Turn the PRD below into a task graph, then reply with ONE JSON object and nothing else.

Reply schema (exactly):
{
  "tasks": [
    {
      "id": "kebab-case, stable, unique",
      "title": "one line",
      "spec": "at most 10 lines: what to build, where, which files",
      "dependsOn": ["id", "..."],
      "acceptance": ["When X, the system shall Y"],   // 1 to 5 criteria, each checkable from a diff
      "targetPaths": ["src/..."],                     // derive when derivable, else []
      "priority": 0                                   // higher runs first at equal DAG position
    }
  ]
}

Rules:
- the graph is a DAG through dependsOn; no cycles, no unknown task ids.
- each task is independently verifiable against its acceptance criteria.
- specs stay under 10 lines; the implementer gets this spec plus the PRD text again.
- forward-dependency order is expressed through dependsOn, not list order.`;

export interface PlanInputs {
	prdPath: string;
	prdText: string;
	toolBox: { read: ToolRegistration; write: ToolRegistration; edit: ToolRegistration; bash: ToolRegistration };
}

/** Load the PRD from the project paths (errors in plain words). */
export async function loadPrd(kit: LoopAndLock, prdPathArg?: string): Promise<string> {
	const path = prdPathArg ?? kit.loop.config.paths.prd;
	const abs = join(kit.loop.paths.root, path);
	try {
		return await readFile(abs, "utf8");
	} catch {
		throw new PlanParseError(`PRD not found at ${abs} — write it, or pass --prd <path> (init --with-demo adds a fixture)`);
	}
}

/** Run the one planning conversation and commit "planned" state. */
export async function runPlan(kitAndLock: LoopAndLock, prdPath: string, prdText: string): Promise<PlanOutcome> {
	const kit = new ConversationKit(kitAndLock, kitAndLock.loop.toolBox);
	const role = kitAndLock.loop.config.roles.planner;
	const conv = await kit.createUnit({
		instructions: PLANNER_BRIEF,
		guard: { role: "planner", targetPaths: [] },
		tools: "read",
		model: { provider: role.provider, modelId: role.modelId, thinkingLevel: role.thinkingLevel },
		maxTurns: kitAndLock.loop.config.engine.maxTurns,
	});

	const outcome = await kit.submitAndAwait(
		conv,
		"kit-plan-v1",
		`PRD (path ${prdPath}, this message is the whole document):\n\n${prdText}\n\nReply with the tasks JSON now.`,
	);
	if (outcome.status !== "done" || !outcome.answer) {
		throw new PlanParseError(
			`planning conversation failed: ${outcome.reason ?? "no answer"}${outcome.detail ? ` (${String(outcome.detail).slice(0, 200)})` : ""}`,
		);
	}

	const tasks = normalizeTasks(parsePlannerJson(outcome.answer));
	const router: RouterDocValue = { version: 1, phase: "planned", tasks };
	await commitState(kitAndLock, {
		router,
		runStatus: (d) => {
			d.prdPath = prdPath;
			d.prdSha = shasum(prdText);
			d.kitVersion = KIT_VERSION;
			},
		rows: [
			{
				ts: Date.now(),
				kind: "wave",
				task: "session",
				verb: "planned",
				detail: `${tasks.length} task(s) from ${prdPath} (sha256 ${shasum(prdText).slice(0, 12)}), one planning conversation`,
				provider: role.provider,
				modelId: role.modelId,
				costUsd: outcome.usage.usd,
				tokens: outcome.usage.totalTokens,
			},
		],
		statusPhase: { phase: "planning" },
	});
	return { tasks, conversationId: conv.id };
}

export interface PlanOutcome {
	tasks: RouterTask[];
	conversationId: number;
}

// ---------------------------------------------------------------------------
// Parsing + normalization
// ---------------------------------------------------------------------------

export function parsePlannerJson(text: string): { tasks: unknown[] } {
	const cleaned = text
		.replace(/^\s*```(?:json)?\s*/i, "")
		.replace(/```\s*$/, "")
		.trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start < 0 || end <= start) throw new PlanParseError("planner returned no JSON object — rerun plan or refine the PRD");
	let json: unknown;
	try {
		json = JSON.parse(cleaned.slice(start, end + 1));
	} catch (err) {
		throw new PlanParseError(`planner JSON parse failed: ${(err as Error).message}`);
	}
	const tasks = (json as { tasks?: unknown }).tasks;
	if (!Array.isArray(tasks)) throw new PlanParseError('planner JSON missing a "tasks" array');
	return { tasks };
}

export function normalizeTasks(raw: { tasks: unknown[] }): RouterTask[] {
	const out: RouterTask[] = [];
	raw.tasks.forEach((entry, i) => {
		const t = entry as Record<string, unknown>;
		if (typeof t["id"] !== "string" || !t["id"].trim()) {
			throw new PlanParseError(`task #${i + 1} is missing an id (string)`);
		}
		const acceptance = strList(t["acceptance"]);
		if (acceptance.length < 1 || acceptance.length > 5) {
			throw new PlanParseError(`task ${String(t["id"])}: acceptance needs 1–5 criteria (got ${acceptance.length})`);
		}
		out.push({
			id: toSlug(String(t["id"])),
			title: typeof t["title"] === "string" ? t["title"] : String(t["id"]),
			spec: typeof t["spec"] === "string" ? t["spec"] : "",
			dependsOn: strList(t["dependsOn"]).map(toSlug),
			acceptance,
			targetPaths: strList(t["targetPaths"]).slice(0, 20),
			priority: typeof t["priority"] === "number" && Number.isFinite(t["priority"]) ? (t["priority"] as number) : 0,
			status: "todo",
			waveCount: 0,
			feedback: [],
		});
	});
	// Validate now: unknown deps + cycles fail before any wave runs (§4.2.2).
	const ids = new Set(out.map((t) => t.id));
	for (const t of out) {
		for (const dep of t.dependsOn) {
			if (!ids.has(dep)) throw new PlanParseError(`task ${t.id}: dependsOn unknown task "${dep}"`);
		}
	}
	ensureAcyclic(out);
	return out;
}

export function ensureAcyclic(tasks: RouterTask[]): void {
	const state = new Map<string, 1 | 2>();
	const visit = (id: string): void => {
		const s = state.get(id);
		if (s === 2) return;
		if (s === 1) throw new PlanParseError(`the dependsOn graph has a cycle through "${id}"`);
		state.set(id, 1);
		for (const dep of tasks.find((t) => t.id === id)?.dependsOn ?? []) visit(dep);
		state.set(id, 2);
	};
	for (const task of tasks) visit(task.id);
}

function strList(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
}

function toSlug(id: string): string {
	return id.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "-");
}

/**
 * Planner (§4.1): PRD → RouterDoc in ONE planning conversation on the planner
 * role model with read tools only. Commits RouterDoc ("planned", with a fresh
 * plan identity — M0-P04) + RunStatus provenance + wave-log row via
 * commitState, mirrors router.md, and stops for human approval
 * (`run --approve`). A successful plan REPLACES the previous one atomically:
 * the old identity is archived and any prior approval is invalidated in the
 * same commit. A failed parse leaves the old plan untouched.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConversationKit } from "./conversations.ts";
import type { LoopAndLock, ToolRegistration } from "./harness.ts";
import { commitState, flushStatusSnapshot, readSessionState } from "./state.ts";
import type { RouterTask } from "./infos.ts";
import { KIT_VERSION } from "../config.ts";
import { readJson } from "../util/fsx.ts";
import { buildPlanIdentity, type ArchivedPlanRef } from "./plans.ts";
import type { Remediation } from "../adoption/types.ts";

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
	// UI seam A.1: flush { phase: "planning" } BEFORE the conversation starts so an
	// attached UI sees the live planning state (and keeps the existing planned
	// commit after the answer). Read-only side-car snapshot, no commit.
	await flushStatusSnapshot(kitAndLock, { phase: "planning" });
	const kit = new ConversationKit(kitAndLock, kitAndLock.loop.toolBox);
	const role = kitAndLock.loop.config.roles.planner;
	const conv = await kit.createUnit({
		instructions: PLANNER_BRIEF,
		guard: { role: "planner", targetPaths: [] },
		tools: "read",
		model: { provider: role.provider, modelId: role.modelId, thinkingLevel: role.thinkingLevel },
		maxTurns: kitAndLock.loop.config.engine.maxTurns,
	});

	const remediations = await loadApprovedRemediations(kitAndLock.loop.paths.root);
	const remediationBrief = formatRemediationBrief(remediations);
	const outcome = await kit.submitAndAwait(
		conv,
		"kit-plan-v1",
		`PRD (path ${prdPath}, this message is the whole document):\n\n${prdText}\n\n${remediationBrief}Reply with the tasks JSON now.`,
	);
	if (outcome.status !== "done" || !outcome.answer) {
		throw new PlanParseError(
			`planning conversation failed: ${outcome.reason ?? "no answer"}${outcome.detail ? ` (${String(outcome.detail).slice(0, 200)})` : ""}`,
		);
	}

	const tasks = normalizeTasks(parsePlannerJson(outcome.answer));
	// Identity inputs are read BEFORE the commit: a failure here (git, paths,
	// controls) leaves the previous plan untouched. planRevision is a fresh
	// UUIDv4 per plan — even for an identical replan.
	const root = kitAndLock.loop.paths.root;
	const identity = await buildPlanIdentity(root, prdPath, prdText, tasks);
	// What this plan REPLACES is read before the commit (the same lock makes
	// this consistent): the replaced identity drives archiving and the provenance
	// row, and a prior approval — v1 legacy stamps included — is invalidated.
	const before = await readSessionState(kitAndLock.loop.harness);
	const previous = before.router.identity;
	const replacedRevision = previous?.planRevision;
	const clearedApproval = before.runStatus.humanApprovedAt !== undefined || before.runStatus.approvedPlanRevision !== undefined;
	const archived: ArchivedPlanRef[] = previous
		? [
				{
					planRevision: previous.planRevision,
					definitionSha256: previous.definitionSha256,
					prdPath: previous.prdPath,
					prdSha256: previous.prdSha256,
					archivedAt: Date.now(),
				},
				...(before.router.archived ?? []),
		  ]
		: [...(before.router.archived ?? [])];
	await commitState(kitAndLock, {
		router: (d) => {
			// Archive the replaced plan's identity references (most recent first);
			// a legacy (v1) plan has no identity, so there is nothing to archive.
			d.archived = archived;
			d.identity = identity;
			d.tasks = tasks;
			d.phase = "planned";
		},
		runStatus: (d) => {
			d.prdPath = identity.prdPath;
			d.prdSha = identity.prdSha256;
			d.kitVersion = KIT_VERSION;
			// The old approval does not survive plan replacement: prior grant and
			// stamp are invalidated ATOMICALLY in this same commit (a replaced
			// plan is a new review point; timestamps authorize nothing without a
			// revision that matches the current plan).
			d.approvedPlanRevision = undefined;
			d.humanApprovedAt = undefined;
		},
		rows: [
			{
				ts: Date.now(),
				kind: "wave",
				task: "session",
				verb: "planned",
				detail:
					`${tasks.length} task(s) from ${identity.prdPath} (sha256 ${identity.prdSha256.slice(0, 12)}), one planning conversation; ` +
					`plan revision ${identity.planRevision}` +
					(replacedRevision ? `; replaced ${replacedRevision} (archived)` : "") +
					(clearedApproval ? "; prior approval invalidated" : ""),
				provider: role.provider,
				modelId: role.modelId,
				costUsd: outcome.usage.usd,
				tokens: outcome.usage.totalTokens,
			},
		],
		statusPhase: { phase: "planning" },
	});
	return { tasks, conversationId: conv.id, planRevision: identity.planRevision, replacedRevision };
}

export interface PlanOutcome {
	tasks: RouterTask[];
	conversationId: number;
	/** Fresh revision minted by THIS plan. */
	planRevision: string;
	/** Revision of the plan this one replaced (undefined when none existed). */
	replacedRevision?: string;
}

export async function loadApprovedRemediations(root: string): Promise<Remediation[]> {
	const stored = await readJson<{ version: number; remediations: Remediation[] }>(join(root, ".orch", "gate-remediations.json"));
	return stored?.version === 1 && Array.isArray(stored.remediations) ? stored.remediations : [];
}

/** Approved gaps become planning input, never PRD mutations or model commands. */
export function formatRemediationBrief(remediations: Remediation[]): string {
	if (!remediations.length) return "";
	const details = remediations.map((item) => JSON.stringify(item)).join("\n");
	return `HUMAN-APPROVED GATE-GAP REMEDIATIONS (additional planning requirements, not implemented changes):\n${details}\nAdd reviewable RouterDoc tasks for these gaps where needed. Do not claim the checks already exist; the normal human plan approval still applies.\n\n`;
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
	// Empty plan: at least one task is required (§3 M0-P04).
	if (raw.tasks.length === 0) {
		throw new PlanParseError("planner returned an empty plan — at least one task is required");
	}
	const out: RouterTask[] = [];
	const seen = new Set<string>();
	raw.tasks.forEach((entry, i) => {
		const t = entry as Record<string, unknown>;
		if (typeof t["id"] !== "string" || !t["id"].trim()) {
			throw new PlanParseError(`task #${i + 1} is missing an id (string)`);
		}
		// IDs are safe after normalization: lower [a-z0-9][a-z0-9_-]{0,63}. An id
		// that cannot be normalized into that shape (e.g. "-b" keeps its leading
		// dash) is rejected, not silently kept or dropped.
		const id = toSlug(String(t["id"]));
		if (!SAFE_TASK_ID.test(id)) {
			throw new PlanParseError(
				`task #${i + 1} (${String(t["id"])}): normalized id "${id}" is not a safe task id — ids must match ${SAFE_TASK_ID.source} after normalization`,
			);
		}
		// Colliding normalized IDs reject BEFORE any state replacement.
		if (seen.has(id)) {
			throw new PlanParseError(`task #${i + 1}: duplicate task id after normalization — two entries normalize to "${id}"`);
		}
		seen.add(id);
		const acceptance = strList(t["acceptance"]);
		if (acceptance.length < 1 || acceptance.length > 5) {
			throw new PlanParseError(`task ${id}: acceptance needs 1–5 criteria (got ${acceptance.length})`);
		}
		out.push({
			id,
			title: typeof t["title"] === "string" ? t["title"] : String(t["id"]),
			spec: typeof t["spec"] === "string" ? t["spec"] : "",
			dependsOn: depList(t["dependsOn"], id),
			acceptance,
			targetPaths: targetList(t["targetPaths"], id),
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

/** Safe normalized task id: lower [a-z0-9][a-z0-9_-]{0,63}. */
export const SAFE_TASK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** dependsOn must be an array of strings; duplicate deps are rejected (absent → []). */
function depList(v: unknown, taskId: string): string[] {
	if (v === undefined) return [];
	if (!Array.isArray(v)) throw new PlanParseError(`task ${taskId}: dependsOn must be an array of task ids`);
	const deps = v.map((item) => {
		if (typeof item !== "string" || !item.trim()) {
			throw new PlanParseError(`task ${taskId}: dependsOn entries must be non-empty task id strings`);
		}
		return toSlug(item);
	});
	if (new Set(deps).size !== deps.length) {
		throw new PlanParseError(`task ${taskId}: dependsOn has duplicate entries (${deps.join(", ")})`);
	}
	return deps;
}

/**
 * targetPaths must be an EXPLICIT array of non-empty project-relative path
 * specs — `[]` is the legitimate way to say "unrestricted admissible project
 * paths", so a missing field is a parse error, not a silent unrestricted
 * default. Entries must be bounded, non-absolute, and must not traverse out of
 * the project.
 */
function targetList(v: unknown, taskId: string): string[] {
	if (v === undefined) {
		throw new PlanParseError(`task ${taskId}: missing targetPaths — targetPaths must be an explicit array ([] means unrestricted admissible paths)`);
	}
	if (!Array.isArray(v)) {
		throw new PlanParseError(`task ${taskId}: targetPaths must be an array of project-relative paths ([] means unrestricted admissible paths)`);
	}
	const out: string[] = [];
	for (const item of v) {
		if (typeof item !== "string" || !item.trim()) {
			throw new PlanParseError(`task ${taskId}: targetPaths entries must be non-empty strings`);
		}
		const p = item.trim();
		if (p.length > 512) {
			throw new PlanParseError(`task ${taskId}: target path is longer than 512 characters`);
		}
		if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\\") || p.split("/").includes("..")) {
			throw new PlanParseError(`task ${taskId}: target path ${JSON.stringify(p)} is not a safe project-relative path`);
		}
		out.push(p);
	}
	if (out.length > 20) {
		throw new PlanParseError(`task ${taskId}: targetPaths exceeds 20 entries`);
	}
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

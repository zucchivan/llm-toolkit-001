/**
 * Action plumbing (ui/PRD.md §11.2 + Appendix C step 5):
 *
 * The UI spawns the CLI with the same flags a human would type — argv arrays
 * only, never a shell. The allowlist is hard-coded; validation is explicit per
 * kind (unknown kinds/fields → 400). `plan`/`run`/`verify`/`export` need the
 * free lock (else 409 with the holder pid/phase); `handoff` is safe during a
 * run (atomic side-car write); `stop` acts only on jobs this UI launched.
 */
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../../src/util/fsx.ts";
import type { StatusPayloads } from "../../src/engine/harness.ts";
import { loadConfig, type RoleName } from "../../src/config.ts";
import {
	activeJobs,
	jobPid,
	jobsList,
	pidAlive,
	readJobRecord,
	spawnJob,
	type JobKind,
	type JobRecord,
} from "./jobs.ts";

// ---------------------------------------------------------------------------
// Allowlist + validation (duplicated nowhere; the HTTP route calls this once)
// ---------------------------------------------------------------------------

export const ACTION_KINDS = ["plan", "run", "stop", "handoff", "verify", "export"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

const ACTION_FIELDS: Record<ActionKind, readonly string[]> = {
	plan: ["kind", "prd"],
	run: ["kind", "approve", "resume", "tasks"],
	stop: ["kind"],
	handoff: ["kind", "note"],
	verify: ["kind", "task"],
	export: ["kind"],
};

export interface ActionBody {
	kind: ActionKind;
	/** plan: PRD path (relative to the project root), as typed by a human. */
	prd?: string;
	/** run: the human approval stamp — REQUIRED unless this is a pre-stamped resume. */
	approve?: boolean;
	/** run: resume after a rate-limit sleep (exit 42) without re-approving. */
	resume?: boolean;
	/** run: explicit todo-task subset (--tasks, repeated flag). */
	tasks?: string[];
	/** handoff note (one CLI positional arg). */
	note?: string;
	/** verify --task <id>. */
	task?: string;
}

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export type Validation =
	| { ok: true; body: ActionBody }
	| { ok: false; status: 400; error: string };

/** Validate the POST /api/actions body against the per-kind shape (§11.2). */
export function validateAction(raw: unknown): Validation {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, status: 400, error: "body must be a JSON object like { kind: \"plan\" }" };
	}
	const body = raw as Record<string, unknown>;
	const kind = body["kind"];
	if (typeof kind !== "string" || !(ACTION_KINDS as readonly string[]).includes(kind)) {
		return { ok: false, status: 400, error: `unknown kind ${JSON.stringify(kind)} — known: ${ACTION_KINDS.join(", ")}` };
	}
	const actionKind = kind as ActionKind;
	const allowed = new Set(ACTION_FIELDS[actionKind]);
	const unknown = Object.keys(body).filter((k) => !allowed.has(k));
	if (unknown.length) {
		return { ok: false, status: 400, error: `unknown field(s) ${unknown.join(", ")} for kind ${actionKind} — allowed: ${FLOW_FIELDS(actionKind)}` };
	}
	const out: ActionBody = { kind: actionKind };

	switch (actionKind) {
		case "plan": {
			const prd = body["prd"];
			if (prd !== undefined) {
				if (typeof prd !== "string" || !prd.trim()) return { ok: false, status: 400, error: "prd must be a non-empty path string" };
				if (prd.includes("\n") || prd.length > 2000) return { ok: false, status: 400, error: "prd must be one path, under 2000 chars" };
				out.prd = prd.trim();
			}
			break;
		}
		case "run": {
			const approve = body["approve"] === undefined ? false : body["approve"];
			const resume = body["resume"] === undefined ? false : body["resume"];
			if (typeof approve !== "boolean" || typeof resume !== "boolean") {
				return { ok: false, status: 400, error: "approve/resume must be booleans" };
			}
			if (approve && resume) {
				return { ok: false, status: 400, error: "run takes exactly one of approve: true (the plan review stamp) or resume: true (post-sleep rerun) — not both" };
			}
			if (!approve && !resume) {
				return { ok: false, status: 400, error: "there is no silent run — run needs approve: true (or resume: true after a sleep)" };
			}
			out.approve = approve === true;
			out.resume = resume === true;
			if (body["tasks"] !== undefined) {
				const tasks = body["tasks"];
				if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 200) {
					return { ok: false, status: 400, error: "tasks must be a non-empty array of task ids (≤200)" };
				}
				const ids: string[] = [];
				for (const id of tasks) {
					if (typeof id !== "string" || !TASK_ID_RE.test(id)) {
						return { ok: false, status: 400, error: `tasks[] has a non-id entry: ${JSON.stringify(id)} — ids are [A-Za-z0-9_..:]` };
					}
					ids.push(id);
				}
				if (new Set(ids).size !== ids.length) {
					return { ok: false, status: 400, error: "tasks[] has duplicate ids" };
				}
				out.tasks = ids;
			}
			break;
		}
		case "handoff": {
			const note = body["note"];
			if (typeof note !== "string" || note.trim().length === 0) {
				return { ok: false, status: 400, error: "handoff needs a non-empty note" };
			}
			const trimmed = note.trim();
			if (trimmed.length > 2000) return { ok: false, status: 400, error: "note is over the 2000-char cap" };
			if (trimmed.startsWith("-")) return { ok: false, status: 400, error: "a note starting with \"-\" would be filtered out by the CLI's handoff parser — rephrase it" };
			out.note = trimmed;
			break;
		}
		case "verify": {
			const task = body["task"];
			if (typeof task !== "string" || !TASK_ID_RE.test(task)) {
				return { ok: false, status: 400, error: "verify needs a valid --task <id>" };
			}
			out.task = task;
			break;
		}
		default:
			break; // stop / export take no params
	}
	return { ok: true, body: out };
}

function FLOW_FIELDS(kind: ActionKind): string {
	return ACTION_FIELDS[kind].filter((f) => f !== "kind").join(", ") || "none";
}

// ---------------------------------------------------------------------------
// CLI resolution — same binary a human would run, same flags (§7.2)
// ---------------------------------------------------------------------------

export interface CliResolution {
	/** Exact full argv prefix used to run the CLI (interpreter included when needed). */
	argv: string[];
	via: string;
}

/**
 * Where is `llm-toolkit-001`? First hit wins, in this order:
 *   1. KIT_UI_CLI_BIN env override (tests + unusual installs);
 *   2. the project's own `node_modules/.bin/llm-toolkit-001` (the
 *      `npm i <kit repo>` demo/consumer layout — the human-like route);
 *   3. the kit repo's built `dist/cli.js` via node;
 *   4. `llm-toolkit-001` on PATH;
 *   5. the kit repo's TypeScript CLI through the ui package's tsx (dev checkout).
 * A *.js/*.mjs bin is always exec'd through node (never a shell).
 */
export function resolveCli(projectRoot: string): CliResolution {
	const uiRoot = fileURLToPath(new URL("..", import.meta.url)); // ui/
	const kitRoot = join(uiRoot, "..");

	const nodeitized = (path: string, via: string): CliResolution =>
		(/\.m?js$/.test(path) ? { argv: [process.execPath, path], via } : { argv: [path], via });

	const override = process.env["KIT_UI_CLI_BIN"];
	if (override) {
		if (!existsSync(override)) throw new Error(`KIT_UI_CLI_BIN points nowhere: ${override}`);
		return nodeitized(override, "KIT_UI_CLI_BIN");
	}

	const projectBin = join(projectRoot, "node_modules", ".bin", "llm-toolkit-001");
	if (existsSync(projectBin)) return { argv: [projectBin], via: "project node_modules/.bin" };

	const distCli = join(kitRoot, "dist", "cli.js");
	if (existsSync(distCli)) return { argv: [process.execPath, distCli], via: "kit dist/cli.js" };

	for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
		if (!dir) continue;
		const bin = join(dir, "llm-toolkit-001");
		if (existsSync(bin)) return { argv: [bin], via: "PATH" };
	}

	const tsxCli = join(uiRoot, "node_modules", "tsx", "dist", "cli.mjs");
	const kitSrcLt = join(kitRoot, "src", "cli.ts");
	if (existsSync(tsxCli) && existsSync(kitSrcLt)) {
		return { argv: [process.execPath, tsxCli, kitSrcLt], via: "kit src/cli.ts via tsx" };
	}

	throw new Error(
		`no llm-toolkit-001 CLI found — build the kit (npm run build) or install it in the project, or set KIT_UI_CLI_BIN to the CLI entry`,
	);
}

// ---------------------------------------------------------------------------
// argv construction (the only place flags are spelled out)
// ---------------------------------------------------------------------------

/** Build the CLI argv for a validated action. `stop` never spawns (→ []). */
export function buildArgv(resolved: CliResolution, body: ActionBody): string[] {
	const base = resolved.argv;
	switch (body.kind) {
		case "plan":
			return [...base, "plan", ...(body.prd ? ["--prd", body.prd] : [])];
		case "run":
			return [
				...base,
				"run",
				...(body.approve ? ["--approve"] : []),
				...(body.tasks ? body.tasks.flatMap((t) => ["--tasks", t]) : []),
			];
		case "verify":
			return [...base, "verify", "--task", body.task!];
		case "handoff":
			return [...base, "handoff", body.note!];
		case "export":
			return [...base, "export"];
		case "stop":
			return [];
	}
}

// ---------------------------------------------------------------------------
// Conflict guards ("one mutating job at a time", §11.2)
// ---------------------------------------------------------------------------

const LOCK_MUTATING: readonly JobKind[] = ["plan", "run", "verify", "export"];

export interface ActionBlock {
	status: 409;
	error: string;
	holderPid?: number;
	phase?: string;
	jobId?: string;
}

/**
 * 409 reasons for a validated action body, or undefined when it may start.
 * `handoff` is allowed while ANY other job runs (it is a side-car write) but
 * not while another handoff is in flight.
 */
export async function conflictFor(projectRoot: string, body: ActionBody): Promise<ActionBlock | undefined> {
	const all = await jobsList(projectRoot);
	const mutationRunning = all.find((j) => j.status === "running" && LOCK_MUTATING.includes(j.kind));
	const handoffRunning = all.find((j) => j.status === "running" && j.kind === "handoff");

	if (body.kind === "handoff") {
		if (handoffRunning) {
			return { status: 409, error: `another handoff is still writing (${handoffRunning.id}) — wait for it to land`, jobId: handoffRunning.id };
		}
		return undefined; // atomic side-car write: safe during any run
	}
	if (mutationRunning) {
		return {
			status: 409,
			error: `a ${mutationRunning.kind} job is already running (${mutationRunning.id}) — one mutating job at a time; stop it first`,
			jobId: mutationRunning.id,
		};
	}
	if (!(LOCK_MUTATING as readonly string[]).includes(body.kind)) return undefined; // stop handles its own conflicts

	// The lock must be free for plan/run/verify/export (§7.2): a live holder
	// (terminal-started run, another CLI, the governor window) → 409 + holder pid.
	return lockProbe(projectRoot);
}

/**
 * Brief lock busy-retry (same tolerances as the readout): our own routine
 * snapshot reads hold the lock for ~100-300 ms — a real holder outlasts the
 * retries and earns the 409 with its pid/phase.
 */
export async function lockProbe(projectRoot: string): Promise<ActionBlock | undefined> {
	for (let attempt = 0; ; attempt++) {
		const holder = await readLockHolder(projectRoot);
		if (!holder) return undefined;
		if (attempt >= 3) {
			const payload = await readJson<StatusPayloads>(join(projectRoot, ".orch", "status.json")).catch(() => undefined);
			return {
				status: 409,
				error: `.orch/lock is held by pid ${holder}` +
					(payload?.phase ? ` (${payload.phase})` : "") +
					" — wait for the live run to exit, or stop it if it is a UI job",
				holderPid: holder,
				phase: payload?.phase,
			};
		}
		await new Promise((r) => setTimeout(r, 150));
	}
}

async function readLockHolder(projectRoot: string): Promise<number | undefined> {
	const lockPath = join(projectRoot, ".orch", "lock");
	if (!existsSync(lockPath)) return undefined;
	let pidLine: string | undefined;
	try {
		pidLine = readFileSync(lockPath, "utf8").split("\n")[0];
	} catch {
		return undefined;
	}
	const pid = Number.parseInt(pidLine ?? "", 10);
	if (!Number.isInteger(pid) || !pidAlive(pid)) return undefined; // dead holder: the next CLI open recovers
	return pid;
}

// ---------------------------------------------------------------------------
// start + stop
// ---------------------------------------------------------------------------

export type StartError = { status: number; error: string; holderPid?: number; phase?: string; jobId?: string; missing?: string[]; configError?: string };

// ---------------------------------------------------------------------------
// Model preflight (§7.2 friendliness): plan/run/verify need their roles to
// name provider+modelId in .orch/config.toml — the CLI fails those instantly,
// and until the snapshot gained visible role models the only evidence lived in
// a failed job's log. Answer 422 BEFORE spawning, in kind words. Read-only
// (one loadConfig): the UI never writes the config (CLI-only mutation path).
// ---------------------------------------------------------------------------

/** The roles each model-carrying action needs (handoff/export/stop need none). */
export const ACTION_ROLE_NEEDS: Record<"plan" | "run" | "verify", readonly RoleName[]> = {
	plan: ["planner"],
	run: ["implementer", "verifier"],
	verify: ["verifier"],
};

/** 422 (no doomed job) when the config lacks the models the action needs. */
export async function configPreflight(projectRoot: string, body: ActionBody): Promise<StartError | undefined> {
	const needed = ACTION_ROLE_NEEDS[body.kind as keyof typeof ACTION_ROLE_NEEDS];
	if (!needed) return undefined;
	try {
		const config = loadConfig(projectRoot);
		const missing = needed.filter((role) => {
			const r = config.roles[role];
			return !r || !String(r.provider).trim() || !String(r.modelId).trim();
		});
		if (missing.length === 0) return undefined;
		const blocks = missing
			.map((role) => `[roles.${role}]\nprovider = "openrouter"\nmodelId = "openai/gpt-5-nano"`)
			.join("\n\n");
		return {
			status: 422,
			missing,
			error:
				`${body.kind} can't start yet: ${missing.map((r) => `roles.${r}`).join(", ")} has no model configured.\n` +
				`In .orch/config.toml add:\n${blocks}\n` +
				"this UI never edits the config for you — set the block(s), save, and try again.",
		};
	} catch (err) {
		const message = (err as Error).message;
		// The loader's most common throw IS the missing-roles diagnostic (it bails
		// on the first role that has no provider/modelId). Convert it to the same
		// prescriptive shape the missing-branch gives, so the client dialog can
		// quote the block verbatim; fixing it re-runs the whole preflight.
		const named: string[] = [];
		for (const match of message.matchAll(/roles\.([A-Za-z_][A-Za-z0-9_]*): needs provider and modelId/g)) named.push(match[1]!);
		if (named.length > 0) {
			const blocks = named.map((role) => `[roles.${role}]\nprovider = "openrouter"\nmodelId = "openai/gpt-5-nano"`).join("\n\n");
			return {
				status: 422,
				missing: named,
				error:
					`${body.kind} can't start yet: ${named.map((r) => `roles.${r}`).join(", ")} has no model configured.\n` +
					`In .orch/config.toml add:\n${blocks}\n` +
					"this UI never edits the config for you — set the block(s), save, and try again.",
			};
		}
		// Any other config break: hand over the loader's plain-words reason.
		return { status: 422, configError: message, error: `the project config can't be read, so ${body.kind} can't start: ${message}` };
	}
}

/**
 * Serialize conflict-check → record-write → spawn inside this one server process
 * (two overlapping POSTs must not both pass the "no running job" check).
 */
const actionGate: { chain: Promise<unknown> } = { chain: Promise.resolve() };
function serializeAction<T>(fn: () => Promise<T>): Promise<T> {
	const run = actionGate.chain.then(fn, fn);
	actionGate.chain = run.catch(() => {});
	return run;
}

/** Start one validated action as a detached job → { job } (via = CLI resolution). */
export function startAction(
	projectRoot: string,
	body: ActionBody,
): Promise<{ ok: true; job: JobRecord; via: string } | { ok: false; fail: StartError }> {
	return serializeAction(async () => {
		try {
			const preflight = await configPreflight(projectRoot, body);
			if (preflight) return { ok: false as const, fail: preflight };
			const conflict = await conflictFor(projectRoot, body);
			if (conflict) return { ok: false as const, fail: conflict };

			const resolved = resolveCli(projectRoot);
			const argv = buildArgv(resolved, body);
			if (argv.length === 0) return { ok: false as const, fail: { status: 400, error: "stop does not spawn a job" } };
			// argv nonempty ⇒ body.kind is not "stop" (buildArgv returns [] only for stop).
			const spawnKind = body.kind as Exclude<typeof body.kind, "stop">;

			const job = await spawnJob(projectRoot, { kind: spawnKind, spawnedArgv: argv, cwd: projectRoot });
			return { ok: true as const, job, via: resolved.via };
		} catch (err) {
			return { ok: false as const, fail: { status: 500, error: (err as Error).message } };
		}
	});
}

/**
 * Wait (bounded) for the record's CLI pid — a stop that lands within the
 * run-up window (record written, runner still spawning the CLI) acts instead
 * of answering 409. Returns the CLI pid or undefined when nothing appears.
 */
async function waitForProcTarget(projectRoot: string, record: JobRecord): Promise<number | undefined> {
	if (record.pid !== undefined || !pidAlive(jobPid(record))) return record.pid;
	const deadline = Date.now() + 3_000;
	for (;;) {
		await new Promise((r) => setTimeout(r, 40));
		const fresh = await readJobRecord(projectRoot, record.id);
		if (fresh?.pid !== undefined || !pidAlive(jobPid(fresh ?? record))) return fresh?.pid;
		if (Date.now() > deadline) return fresh?.pid ?? undefined;
	}
}

/**
 * Stop: SIGINT to the newest running non-handoff job's CLI pid. Only UI jobs
 * are stoppable; a terminal-started run answers 409 with the terminal hint
 * (safe attached-stop is deferred — no verifiable command identity yet).
 */
export async function stopAction(projectRoot: string): Promise<{ ok: true; jobId: string; pid: number } | { ok: false; fail: StartError }> {
	const running = (await activeJobs(projectRoot, (kind) => kind === "handoff")).sort((a, b) => b.startedAt - a.startedAt);
	const target = running[0];
	if (!target) {
		// Attached-run hint: the same holder probe drives the plain message.
		const busy = await lockProbe(projectRoot);
		if (busy) {
			return {
				ok: false,
				fail: {
					status: 409,
					error: `this run holds .orch/lock (pid ${busy.holderPid}) but was not launched by the UI — stop it from its terminal; the UI cannot verify what it would signal`,
					holderPid: busy.holderPid,
					phase: busy.phase,
				},
			};
		}
		return { ok: false, fail: { status: 409, error: "nothing is running — there is no UI job and no live lock holder" } };
	}
	// `pid` is the CLI child (never signalled blindly while the runner's pid is
	// recorded too); undefined means the CLI never spawned — nothing to stop.
	// `pid` is always the CLI child; the runner writes it right after spawn, so a
	// stop that lands within this tiny window waits for it instead of 409-ing.
	const pid = await waitForProcTarget(projectRoot, target);
	if (!pidAlive(pid)) {
		return {
			ok: false,
			fail: {
				status: 409,
				error: `job ${target.id} claims running but the CLI process (pid ${pid ?? "?"}) is not up or is already gone — the record finalizes shortly`,
				jobId: target.id,
			},
		};
	}
	try {
		process.kill(pid!, "SIGINT");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return { ok: false, fail: { status: 500, error: `cannot signal pid ${pid} of job ${target.id}: ${code ?? (err as Error).message}`, jobId: target.id } };
	}
	return { ok: true, jobId: target.id, pid: pid! };
}

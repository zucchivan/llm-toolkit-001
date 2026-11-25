/**
 * Detached job runner + job records (ui/PRD.md Appendix B):
 *
 *   .orch/ui/jobs/<id>.json   { id, kind, argv, cwd, pid, startedAt, endedAt?,
 *                              exitCode?, signal?, status, logPath }
 *   .orch/ui/jobs/<id>.log    CLI stdout+stderr (child streams; runner keeps the fd)
 *
 * The server spawns a small plain-Node runner (`job-runner.mjs`) DETACHED
 * (argv-only, no shell) which spawns the CLI, pipes its output to the log,
 * writes the exit code atomically, then exits. The UI server is NOT in the
 * job's process group and can restart independently; the runner survives UI
 * server/browser death so a run keeps going.
 *
 * `pid` on a record is the CLI child's pid — the same pid that owns `.orch/lock`,
 * so `/api/jobs` (and stop) correlate a running job with the live status.json
 * holder. Liveness is a best-effort signal-0 probe; records whose pid is dead
 * are marked `stale` on server start (history is kept, bounded to ~50/14 days).
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { StatusPayloads } from "../../src/engine/harness.ts";
import {
	installationDescriptorDigest,
	type TrustedLaunchPrefix,
} from "../../src/sandbox/trusted-exec.ts";
import type { TrustedInstallationDescriptor, TrustedToolSource } from "../../src/sandbox/types.ts";

export type JobKind = "plan" | "run" | "verify" | "export" | "handoff";

/**
 * The host-owned launch identity recorded with a job (M1-P01 step (f)).
 *
 * The UI resolves it ONCE per action from the host descriptor, records it in
 * private job state, and the detached runner revalidates the recorded argv
 * against exactly this identity before spawning. There is no re-resolution
 * (no descriptor read, no PATH, no target `.bin`, no `KIT_*` value) after the
 * record, and attached-stop compares a live process against the same prefix.
 */
export interface JobLaunchIdentity {
	version: 1;
	tool: "cli";
	/** The proven running installation root (a foreign record is refused). */
	installationRoot: string;
	/** Absolute interpreter; byte-equal to `argvPrefix[0]`. */
	node: string;
	/** Absolute selected CLI entry. */
	entry: string;
	/** Absolute tsx loader for the documented source form; absent when built. */
	loader?: string;
	form: "built" | "source";
	/** Exactly `[node, ...(loader), entry]` — the recorded argv must start with it. */
	argvPrefix: string[];
	/** Where the selected CLI entry came from (provenance, not authority). */
	source: TrustedToolSource;
	/** SHA-256 over the descriptor's selected tool paths (identity, not authority). */
	descriptorSha256: string;
}

/** Build the record identity from the validated launch prefix. */
export function jobLaunchIdentity(
	prefix: TrustedLaunchPrefix,
	descriptor: TrustedInstallationDescriptor,
): JobLaunchIdentity {
	return {
		version: 1,
		tool: "cli",
		installationRoot: prefix.installationRoot,
		node: prefix.node,
		entry: prefix.entry,
		...(prefix.loader !== undefined ? { loader: prefix.loader } : {}),
		form: prefix.form,
		argvPrefix: [...prefix.argv],
		source: prefix.source,
		descriptorSha256: installationDescriptorDigest(descriptor),
	};
}

/**
 * Kit-named variables that carry inference/debug selection and ARE documented
 * as inherited by UI jobs (ui/PRD.md Appendix B, §15.2 demo mode). Every other
 * `KIT_*` name — including the retired `KIT_UI_CLI_BIN` executable selector —
 * is dropped from a job's environment.
 */
const JOB_ENV_ALLOWED_KIT = new Set(["KIT_FAUX", "KIT_FAUX_SCRIPT", "KIT_DEBUG", "KIT_DEBUG_FAUX"]);

/**
 * Env names that can select/inject a different executable or module into the
 * launched CLI. They are never inherited by a job; the job's executable is the
 * recorded absolute argv, not anything these variables could redirect.
 */
const JOB_ENV_DENIED = new Set([
	"NODE_OPTIONS",
	"NODE_PATH",
	"NODE_REPL_EXTERNAL_MODULE",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"LD_AUDIT",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"DYLD_FRAMEWORK_PATH",
	"BASH_ENV",
	"ENV",
	"SHELLOPTS",
	"BASHOPTS",
	"KIT_UI_CLI_BIN",
	"KIT_UI_HOST",
	"KIT_UI_JOB",
]);

/**
 * The environment a detached job inherits: the UI server's env minus executable
 * authority and non-documented `KIT_*` names. Provider credentials, proxies and
 * `KIT_FAUX*` stay (the CLI needs them); nothing here selects a binary.
 */
export function jobEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (typeof value !== "string") continue;
		if (JOB_ENV_DENIED.has(name)) continue;
		if (name.startsWith("KIT_") && !JOB_ENV_ALLOWED_KIT.has(name)) continue;
		out[name] = value;
	}
	return out;
}

export interface JobRecord {
	id: string;
	kind: JobKind;
	/** The exact argv the runner spawned (interpreter included). Never a shell string. */
	argv: string[];
	cwd: string;
	/** The host-owned launch identity `argv` must start with (step (f)). */
	identity?: JobLaunchIdentity;
	/** The CLI child's pid (the lock holder); the runner writes it right after spawn. */
	pid?: number;
	/** The detached runner's own pid (liveness fallback while the CLI is still starting). */
	runnerPid?: number;
	startedAt: number;
	endedAt?: number;
	/** The CLI's exit code when it exited (0 ok · 42 sleeping · 1 error · 130 interrupted). */
	exitCode?: number;
	/** Signal name when the process was killed instead of exiting. */
	signal?: string;
	/** Runner-side spawn/observation detail (e.g. "spawn failed: …"). */
	detail?: string;
	status: "running" | "exited" | "failed" | "stale";
	logPath: string;
}

/**
 * A listing view of a record: adds a bounded `tail` (the reason, ANSI-stripped)
 * for terminal outcomes where the log holds the human-relevant explanation
 * (config errors, gate/verify messages, spawn failures). A 0-exit or a plain
 * interrupt stays tail-free — the exit code alone is the full story there.
 */
export interface JobView extends JobRecord {
	/** Last meaningful log lines, ANSI stripped; present only when diagnostic. */
	tail?: string[];
}

/** Terminal outcomes whose log tail explains the outcome ("what do I do now"). */
export function wantsReasonTail(record: Pick<JobRecord, "status" | "exitCode" | "detail">): boolean {
	if (record.detail) return true; // runner-side spawn/observation detail: the log may be empty
	if (record.status === "running") return false;
	if (record.status === "failed" || record.status === "stale") return true;
	// exited with a real outcome: sleeping (42) and any nonzero error tail in;
	// 0 ok and 130 (the user interrupted) are self-explanatory.
	return record.exitCode !== undefined && record.exitCode !== 0 && record.exitCode !== 130;
}

/** Strip ANSI SGR/color sequences for display (the CLI colors its messages). */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * The bounded reason tail for a record listing: last few non-empty log lines,
 * ANSI-stripped. Reads whole (job logs are small; the CLI is not a server),
 * capped at 6 lines so a pathological log cannot bloat a job payload.
 */
export async function reasonTail(record: JobRecord, maxLines = 6): Promise<string[] | undefined> {
	if (!wantsReasonTail(record)) return undefined;
	const raw = await tailJobLog(record.logPath, maxLines);
	const lines = raw.map((l) => stripAnsi(l).trim()).filter((l) => l.length > 0);
	return lines.length ? lines : undefined;
}

/** The /api/jobs + SSE `job` payload shape: every record scored for a reason tail. */
export async function jobsViewList(root: string): Promise<JobView[]> {
	const records = await jobsList(root);
	return Promise.all(
		records.map(async (record) => {
			const tail = await reasonTail(record);
			return tail ? { ...record, tail } : record;
		}),
	);
}

/**
 * The verified-stop affordance attached to the attached-run view (§7.2.1):
 * `ok: true` (command line the dialog shows) is what enables the UI's Stop
 * for a terminal-started run; `ok: false` carries the plain-words reason and
 * never signals anything (the check is read-only).
 */
export type AttachedStopView = { ok: true; pid: number; command: string } | { ok: false; pid: number; reason: string };

/** Attached-run discovery result: a terminal-started live run (never a record). */
export interface AttachedRun {
	pid: number;
	/** The §7.2.1 verification result. Computed per payload (read-only, no signal; see ui/server/attached-stop.ts). */
	stop?: AttachedStopView;
	/** `status.json` phase at the last flush (planning / wave-running / idle …). */
	phase: string;
	task?: string;
	wave?: number;
	/** Best-known start: the wave's startedAt while wave-running, else payload ts. */
	startedAt?: number;
	ts: number;
}

/** Exit-code → record status (§7.3): 0/42/130 ended the job, anything else failed. */
export function statusForExit(code: number): JobRecord["status"] {
	return code === 0 || code === 42 || code === 130 ? "exited" : "failed";
}

/** A job's live pid: the CLI child when known, else the runner (still starting). */
export function jobPid(record: Pick<JobRecord, "pid" | "runnerPid">): number | undefined {
	return record.pid ?? record.runnerPid;
}

/**
 * The pids the running non-handoff records claim (§7.2.1 check 1): a lock
 * holder a running UI job record claims is the ordinary Stop's business — the
 * attached stop must refuse it, never signal it, at BOTH the payload/enablement
 * path and the authoritative POST route (so a hand-crafted or stale POST naming
 * such a pid cannot slip past check 1). Handoff records are excluded — they
 * write the atomic side-car and never hold the run loop's lock, so their pid
 * must not block an attached verification.
 */
export function runningJobPids(records: readonly JobRecord[]): number[] {
	return records
		.filter((j) => j.status === "running" && j.kind !== "handoff" && j.pid !== undefined)
		.map((j) => j.pid!);
}

/** signal-0 probe: live when it does not throw ESRCH; EPERM counts as alive. */
export function pidAlive(pid: number | undefined): boolean {
	if (!Number.isInteger(pid) || !pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
	}
}

export const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function jobsDir(root: string): string {
	return join(root, ".orch", "ui", "jobs");
}

/** A job id: sortable-ish (time prefix) + unique(url-safe for /api/jobs/:id). */
function newJobId(): string {
	return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function recordPath(root: string, id: string): string {
	return join(jobsDir(root), `${id}.json`);
}

export function logPathFor(root: string, id: string): string {
	return join(jobsDir(root), `${id}.log`);
}

/**
 * Atomic JSON write: temp file NEXT TO the target (same dir/filesystem), then
 * rename. Temp names never end in `.json`, so jobsList ignores them.
 */
async function atomicWriteJson(path: string, value: unknown): Promise<void> {
	const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
	try {
		await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
		await rename(tmp, path);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

/** Read one record; corrupt/partial JSON → undefined (records are atomic renames). */
export async function readJobRecord(root: string, id: string): Promise<JobRecord | undefined> {
	if (!JOB_ID_RE.test(id)) return undefined;
	try {
		return JSON.parse(await readFile(recordPath(root, id), "utf8")) as JobRecord;
	} catch {
		return undefined;
	}
}

/** All records, newest first. Bounded by pruneJobs() (last 50, 14 days). */
export async function jobsList(root: string): Promise<JobRecord[]> {
	const dir = jobsDir(root);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const records: JobRecord[] = [];
	for (const name of names.sort().reverse()) {
		if (!name.endsWith(".json")) continue;
		const record = await readJobRecord(root, name.slice(0, -5)).catch(() => undefined);
		if (record && record.kind !== undefined && Array.isArray(record.argv)) records.push(record);
	}
	records.sort((a, b) => b.startedAt - a.startedAt);
	return records;
}

/** Records still reported running (drives "one mutating job at a time" + stop). */
export async function activeJobs(root: string, except: (kind: JobKind) => boolean = () => false): Promise<JobRecord[]> {
	return (await jobsList(root)).filter((j) => j.status === "running" && !except(j.kind));
}

/**
 * Server-start sweep (Appendix B): a record still claimed `running` whose CLI
 * pid is gone → `stale` (exit code usually absent: the runner was killed before
 * it could finalize). Never runs after a record was mid-flight on START — the
 * caller does this before accepting actions.
 */
export async function markStaleRecords(root: string): Promise<number> {
	let marked = 0;
	for (const record of await jobsList(root)) {
		if (record.status !== "running") continue;
		if (pidAlive(jobPid(record))) continue;
		await atomicWriteJson(recordPath(root, record.id), { ...record, status: "stale" });
		marked++;
	}
	return marked;
}

/**
 * Bounded history (Appendix B): drop records (and their logs) older than
 * `maxAgeMs` (14 days) and keep at most the newest `maxJobs`.
 */
export async function pruneJobs(root: string, maxJobs = 50, maxAgeMs = 14 * 24 * 60 * 60_000): Promise<number> {
	const records = await jobsList(root); // newest first
	const drop = new Set<JobRecord>();
	for (const [index, record] of records.entries()) {
		if (index >= maxJobs || Date.now() - record.startedAt > maxAgeMs) drop.add(record);
	}
	if (drop.size === 0) return 0;
	for (const record of drop) {
		await unlink(record.logPath).catch(() => {});
		await unlink(recordPath(root, record.id)).catch(() => {});
	}
	return drop.size;
}

export interface SpawnJobInput {
	kind: JobKind;
	/** Full argv incl. interpreter — argv-only, never a shell string (PRD §11.2). */
	spawnedArgv: string[];
	/** The host-owned launch identity the argv was built from (step (f)). */
	identity: JobLaunchIdentity;
	cwd: string;
	/** Extra env for the job (sanitized by jobEnvironment; never an executable selector). */
	env?: Record<string, string>;
}

/**
 * Create the record, spawn `job-runner.mjs` detached (new process group, argv
 * only, no shell), then patch the record's pid to the runner's. The runner
 * overwrites `pid` with the CLI child's pid as soon as it spawns the CLI.
 */
export async function spawnJob(projectRoot: string, input: SpawnJobInput): Promise<JobRecord> {
	await mkdir(jobsDir(projectRoot), { recursive: true });
	const id = newJobId();
	const logPath = logPathFor(projectRoot, id);
	// Create the log empty (truncates nothing else; ids are unique).
	await writeFile(logPath, "", { flag: "wx" });

	const record: JobRecord = {
		id,
		kind: input.kind,
		argv: input.spawnedArgv,
		identity: input.identity,
		cwd: input.cwd,
		startedAt: Date.now(),
		status: "running",
		logPath,
	};
	await atomicWriteJson(recordPath(projectRoot, id), record);

	const runnerPath = join(import.meta.dirname, "job-runner.mjs");
	const runnerArgv = [process.execPath, runnerPath, "--record", recordPath(projectRoot, id)];
	const child = spawn(runnerArgv[0]!, runnerArgv.slice(1), {
		cwd: projectRoot,
		detached: true, // own process group: the UI server's death cannot take the run down
		stdio: "ignore",
		// Sanitized: the job never inherits an executable selector (the recorded
		// absolute argv is the executable), while KIT_FAUX*/provider keys/are kept.
		env: jobEnvironment({ ...process.env, ...(input.env ?? {}) }),
	});
	child.unref?.();
	// Record the runner's own pid for the liveness fallback ONLY — `pid` stays
	// destined for the CLI child (the lock holder the runner patches next).
	await patchRecordIfAbsent(projectRoot, id, { runnerPid: child.pid });
	return { ...record, runnerPid: child.pid };
}

/** Patch fields into a record read-modify-write (runner writes stay authoritative). */
export async function patchRecord(projectRoot: string, id: string, patch: Partial<JobRecord>): Promise<void> {
	const current = await readJobRecord(projectRoot, id);
	if (!current) return;
	await atomicWriteJson(recordPath(projectRoot, id), { ...current, ...patch });
}

/** Same, but only when none of the patch fields is already set on the record. */
export async function patchRecordIfAbsent(projectRoot: string, id: string, patch: Partial<JobRecord>): Promise<void> {
	const current = await readJobRecord(projectRoot, id);
	if (!current) return;
	const occupied = Object.keys(patch).some((k) => (current as unknown as Record<string, unknown>)[k] !== undefined);
	if (occupied) return;
	await atomicWriteJson(recordPath(projectRoot, id), { ...current, ...patch });
}

/**
 * Tail a job log: last `maxLines` lines (1..5000). No file yet → [].
 */
export async function tailJobLog(logPath: string, maxLines: number): Promise<string[]> {
	const capped = Math.max(1, Math.min(5_000, maxLines));
	let data: string;
	try {
		data = await readFile(logPath, "utf8");
	} catch {
		return [];
	}
	if (!data) return [];
	let tail = (data[data.length - 1] === "\n" ? data.slice(0, -1) : data).split("\n");
	if (tail.length > capped) tail = tail.slice(-capped);
	return tail;
}

/**
 * Attached-run discovery (Appendix B): a live `.orch/status.json.lockedByPid`
 * that NO UI running job holds is a terminal-started run. Best-effort liveness;
 * they are not job records — stop follows §7.2.1's verification
 * (ui/server/attached-stop.ts), which names the process before anything is
 * signalled.
 */
export async function attachedRun(projectRoot: string, jobs: JobRecord[]): Promise<AttachedRun | undefined> {
	let payload: StatusPayloads | undefined;
	try {
		payload = JSON.parse(await readFile(join(projectRoot, ".orch", "status.json"), "utf8")) as StatusPayloads;
	} catch {
		return undefined;
	}
	const holder = payload?.lockedByPid;
	if (!pidAlive(holder)) return undefined;
	if (jobs.some((j) => j.status === "running" && j.pid === holder)) return undefined; // a UI job owns it
	return {
		pid: holder!,
		phase: payload?.phase ?? "unknown",
		task: payload?.task?.id || undefined,
		wave: payload?.task?.wave,
		startedAt: payload?.task?.startedAt ?? payload?.ts,
		ts: payload?.ts ?? Date.now(),
	};
}

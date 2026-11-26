/** Detached job state, bounded reads and launch binding (Appendix B). */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { validateTrustedExecutableFile } from "../../src/sandbox/host-profile.ts";
import { openSafeDirectory, openSafeFile, readSafeText, type SafeDirectory, type SafeReadResult } from "../../src/util/safe-read.ts";
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
 * The UI resolves it once from the host descriptor and binds it with the
 * full launch before detaching. Attached Stop uses the same selected prefix.
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
 * The listing reason uses the last few nonempty lines of a capped job log.
 */
async function reasonTail(root: string, record: JobRecord, maxLines = 6): Promise<string[] | undefined> {
	if (!wantsReasonTail(record)) return undefined;
	const raw = await tailJobLog(root, record.id, maxLines);
	const lines = raw.map((l) => stripAnsi(l).trim()).filter((l) => l.length > 0);
	return lines.length ? lines : undefined;
}

/** The /api/jobs + SSE `job` payload shape: every record scored for a reason tail. */
export async function jobsViewList(root: string): Promise<JobView[]> {
	const records = await jobsList(root);
	return Promise.all(
		records.map(async (record) => {
			const tail = await reasonTail(root, record);
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

/** OS observation only. Untrusted PIDs never reach kill(), including signal 0. */
export function validPid(pid: unknown): pid is number {
	return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff;
}

export interface ProcessIdentity {
	parentPid: number;
	startTime: string;
}

export async function processIdentity(pid: unknown): Promise<ProcessIdentity | undefined> {
	if (!validPid(pid)) return undefined;
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/ +/);
		if (fields[0] === "Z" || fields[0] === "X" || !/^\d+$/.test(fields[19] ?? "")) return undefined;
		return { parentPid: Number(fields[1]), startTime: fields[19]! };
	} catch (err) {
		if (["ENOENT", "ESRCH"].includes((err as NodeJS.ErrnoException).code ?? "")) return undefined;
		throw err;
	}
}

export async function pidAlive(pid: number | undefined): Promise<boolean> {
	return (await processIdentity(pid)) !== undefined;
}

export const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const JOBS = ".orch/ui/jobs";
const RECORD_BYTES = 128 * 1024;
const LOG_TAIL_BYTES = 256 * 1024;

export class JobStateRefusal extends Error {
	constructor(message: string) {
		super(`job state refused: ${message}`);
	}
}

function observed<T>(result: SafeReadResult<T>): T | undefined {
	if (result.kind === "refused") throw new JobStateRefusal(`${result.code}: ${result.message}`);
	return result.kind === "ok" ? result.value : undefined;
}

export function jobsDir(root: string): string {
	return join(root, JOBS);
}

export function logPathFor(root: string, id: string): string {
	return join(jobsDir(root), `${id}.log`);
}

async function jobsDirectory(root: string, create = false): Promise<SafeDirectory | undefined> {
	if (!create) return observed(await openSafeDirectory({ root, path: JOBS }));
	let parent = observed(await openSafeDirectory({ root }));
	for (const name of JOBS.split("/")) {
		if (!parent) break;
		const pinned = parent;
		try {
			await mkdir(join(pinned.descriptorPath, name), { mode: 0o700 }).catch((err) => {
				if (err.code !== "EEXIST") throw err;
			});
			const dir = observed(await pinned.openDirectory(name));
			await pinned.close();
			parent = dir;
		} catch (err) {
			await pinned.close();
			throw err;
		}
	}
	return parent;
}

export async function writeJobRecord(dir: SafeDirectory, record: JobRecord): Promise<void> {
	const path = join(dir.descriptorPath, `${record.id}.json`);
	const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
	try {
		await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
		await rename(tmp, path);
	} finally {
		await unlink(tmp).catch(() => {});
	}
}

function parseRecord(raw: string, root: string, id: string): JobRecord {
	try {
		const record = JSON.parse(raw) as JobRecord;
		if (!record || record.id !== id || record.cwd !== root || record.logPath !== logPathFor(root, id)
			|| !["plan", "run", "verify", "export", "handoff"].includes(record.kind)
			|| !["running", "exited", "failed", "stale"].includes(record.status)
			|| !Array.isArray(record.argv) || !record.argv.every((token) => typeof token === "string" && !token.includes("\0"))
			|| !Number.isFinite(record.startedAt)) throw new Error();
		return record;
	} catch {
		throw new JobStateRefusal(`invalid job record ${id} (including its project or log location)`);
	}
}

export async function readJobInDirectory(dir: SafeDirectory, root: string, id: string): Promise<JobRecord | undefined> {
	if (!JOB_ID_RE.test(id)) return undefined;
	const file = observed(await dir.openFile(`${id}.json`));
	if (!file) return undefined;
	try {
		const raw = observed(await file.readText({ maxBytes: RECORD_BYTES }))!;
		return parseRecord(raw, root, id);
	} finally {
		await file.close();
	}
}

export async function readJobRecord(root: string, id: string): Promise<JobRecord | undefined> {
	const dir = await jobsDirectory(root);
	if (!dir) return undefined;
	try {
		return await readJobInDirectory(dir, root, id);
	} finally {
		await dir.close();
	}
}

async function listJobRecords(root: string, dir: SafeDirectory): Promise<JobRecord[]> {
	const entries = observed(await dir.list({ maxEntries: 1024 })) ?? [];
	const records: JobRecord[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".json")) continue;
		const record = await readJobInDirectory(dir, root, entry.name.slice(0, -5));
		if (record) records.push(record);
	}
	return records.sort((a, b) => b.startedAt - a.startedAt);
}

export async function jobsList(root: string): Promise<JobRecord[]> {
	const dir = await jobsDirectory(root);
	if (!dir) return [];
	try {
		return await listJobRecords(root, dir);
	} finally {
		await dir.close();
	}
}

export async function markStaleRecords(root: string): Promise<number> {
	const dir = await jobsDirectory(root);
	if (!dir) return 0;
	try {
		let marked = 0;
		for (const record of await listJobRecords(root, dir)) {
			if (record.status !== "running" || await pidAlive(jobPid(record))) continue;
			// Give a freshly prepared record a chance to attach its runner.
			if (jobPid(record) == null && Date.now() - record.startedAt < 3_000) continue;
			const current = await readJobInDirectory(dir, root, record.id);
			if (!current || current.status !== "running" || await pidAlive(jobPid(current))) continue;
			await writeJobRecord(dir, { ...current, status: "stale" });
			marked++;
		}
		return marked;
	} finally {
		await dir.close();
	}
}

export async function pruneJobs(root: string, maxJobs = 50, maxAgeMs = 14 * 24 * 60 * 60_000): Promise<number> {
	const dir = await jobsDirectory(root);
	if (!dir) return 0;
	try {
		let dropped = 0;
		for (const [index, record] of (await listJobRecords(root, dir)).entries()) {
			if (record.status === "running" || (index < maxJobs && Date.now() - record.startedAt <= maxAgeMs)) continue;
			await unlink(join(dir.descriptorPath, `${record.id}.log`)).catch(() => {});
			await unlink(join(dir.descriptorPath, `${record.id}.json`)).catch(() => {});
			dropped++;
		}
		return dropped;
	} finally {
		await dir.close();
	}
}

export interface SpawnJobInput {
	kind: JobKind;
	spawnedArgv: string[];
	identity: JobLaunchIdentity;
	cwd: string;
	env?: Record<string, string>;
}

/** Digest of exactly the immutable launch fields, supplied separately by the host. */
export function launchBinding(record: JobRecord): string {
	return createHash("sha256").update(JSON.stringify([
		record.id, record.kind, record.argv, record.identity, record.cwd, record.logPath, record.startedAt,
	])).digest("hex");
}

const RUNNER_PATH = join(import.meta.dirname, "job-runner.mjs");

export function jobRunnerArgs(root: string, id: string, binding: string): string[] {
	return [RUNNER_PATH, "--root", root, "--id", id, "--launch", binding];
}

export async function spawnJob(projectRoot: string, input: SpawnJobInput): Promise<JobRecord> {
	if (input.cwd !== projectRoot) throw new JobStateRefusal("launch working directory differs from the project");
	await validateTrustedExecutableFile(input.identity.node, "job runner interpreter", { targetRoot: projectRoot });
	const cwd = observed(await openSafeDirectory({ root: projectRoot }));
	if (!cwd) throw new JobStateRefusal("project directory is absent");
	try {
		const dir = await jobsDirectory(projectRoot, true);
		if (!dir) throw new JobStateRefusal("job directory disappeared during launch");
		try {
			const id = `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
			const record: JobRecord = {
				id, kind: input.kind, argv: input.spawnedArgv, identity: input.identity,
				cwd: projectRoot, startedAt: Date.now(), status: "running", logPath: logPathFor(projectRoot, id),
			};
			await writeJobRecord(dir, record);
			try {
				const child = spawn(input.identity.node, jobRunnerArgs(projectRoot, id, launchBinding(record)), {
					cwd: cwd.descriptorPath,
					detached: true,
					stdio: "ignore",
					env: jobEnvironment({ ...process.env, ...(input.env ?? {}) }),
				});
				await new Promise<void>((resolve, reject) => {
					child.once("spawn", resolve);
					child.once("error", reject);
				});
				child.unref();
				return { ...record, runnerPid: child.pid };
			} catch (err) {
				await writeJobRecord(dir, { ...record, status: "failed", exitCode: 127,
					endedAt: Date.now(), detail: `runner spawn failed: ${(err as Error).message}` });
				throw err;
			}
		} finally {
			await dir.close();
		}
	} finally {
		await cwd.close();
	}
}

export async function tailJobLog(root: string, id: string, maxLines: number): Promise<string[]> {
	if (!JOB_ID_RE.test(id)) throw new JobStateRefusal("invalid log id");
	const file = observed(await openSafeFile({ root, path: `${JOBS}/${id}.log` }));
	if (!file) return [];
	try {
		const tail = observed(await file.readTailText({ maxBytes: LOG_TAIL_BYTES }))!;
		if (!tail.text) return [];
		return tail.text.replace(/\n$/, "").split("\n").slice(-Math.max(1, Math.min(5000, maxLines)));
	} finally {
		await file.close();
	}
}

export async function readJobStatus(root: string): Promise<StatusPayloads | undefined> {
	const raw = observed(await readSafeText({ root, path: ".orch/status.json", maxBytes: 1024 * 1024 }));
	if (raw === undefined) return undefined;
	try {
		const payload = JSON.parse(raw) as StatusPayloads;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)
			|| (payload.lockedByPid !== undefined && !validPid(payload.lockedByPid))) throw new Error();
		return payload;
	} catch {
		throw new JobStateRefusal("malformed .orch/status.json");
	}
}

export async function readJobLock(root: string): Promise<number | undefined> {
	const raw = observed(await readSafeText({ root, path: ".orch/lock", maxBytes: 256 }));
	if (raw === undefined) return undefined;
	const pidLine = raw.split("\n")[0] ?? "";
	const pid = Number(pidLine);
	if (!/^\d+$/.test(pidLine) || !validPid(pid)) throw new JobStateRefusal("unfinished or malformed .orch/lock");
	return pid;
}

export async function attachedRun(projectRoot: string, jobs: JobRecord[]): Promise<AttachedRun | undefined> {
	const payload = await readJobStatus(projectRoot);
	const holder = await readJobLock(projectRoot);
	if (!payload || holder === undefined || payload.lockedByPid !== holder || !await pidAlive(holder)) return undefined;
	if (jobs.some((job) => job.status === "running" && job.pid === holder)) return undefined;
	return {
		pid: holder,
		phase: payload.phase ?? "unknown",
		task: payload.task?.id || undefined,
		wave: payload.task?.wave,
		startedAt: payload.task?.startedAt ?? payload.ts,
		ts: payload.ts ?? Date.now(),
	};
}

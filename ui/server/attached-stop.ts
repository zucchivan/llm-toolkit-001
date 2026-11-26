/** Linux process verification behind ordinary and attached Stop (§7.2.1). */
import { existsSync } from "node:fs";
import { open, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
	TrustedInstallationError,
	currentTrustedInstallation,
	requireLaunchPrefix,
	type TrustedLaunchPrefix,
} from "../../src/sandbox/trusted-exec.ts";
import type { TrustedInstallationDescriptor } from "../../src/sandbox/types.ts";
import { JOB_ID_RE, jobRunnerArgs, launchBinding, processIdentity, readJobLock, readJobStatus, validPid, JobStateRefusal } from "./jobs.ts";
import type { JobRecord } from "./jobs.ts";
import type { AttachedStopView } from "./jobs.ts";

/** The subcommands that legitimately hold `.orch/lock` long enough to be worth interrupting. */
export const STOPPABLE_SUBCOMMANDS = ["plan", "run"] as const;

/** How long a command-line display may get before it is cut (never silently — an ellipsis states it). */
const COMMAND_DISPLAY_CAP = 240;

export type AttachedStopFailCode =
	| "no-holder"
	| "state-refused"
	| "stale"
	| "transient-self"
	| "ui-job"
	| "moved"
	| "platform"
	| "cwd"
	| "identity"
	| "subcommand"
	| "cli-unresolved"
	| "signal";

/** One verification round's outcome. A failure NEVER signals anything. */
export type AttachedStopCheck =
	| { ok: true; pid: number; command: string; argv: string[]; cwd: string; startTime: string }
	| { ok: false; status: 409 | 501; code: AttachedStopFailCode; pid?: number; error: string };

export interface VerifyOpts {
	/** The pid the client confirmed (the dialog echo). The server still derives the truth itself and refuses a mismatch. */
	expectedPid?: number;
	/** Pids that running UI job records already claim — a holder there belongs to the ordinary stop path. */
	uiJobPids?: readonly number[];
	/**
	 * The host-owned descriptor the UI entry built at startup. The verified
	 * argv is the SAME launch identity `ui/server/actions.ts` records for its
	 * own jobs; omitting it uses the process descriptor (direct callers/tests).
	 */
	installation?: TrustedInstallationDescriptor;
}

function fail(status: 409 | 501, code: AttachedStopFailCode, pid: number | undefined, error: string): Extract<AttachedStopCheck, { ok: false }> {
	return { ok: false, status, code, ...(pid !== undefined ? { pid } : {}), error };
}

/** Linux process identity is required for signalling. */
function procAvailable(): boolean {
	return existsSync("/proc/self");
}

/** The process's argv, byte-precise (NUL-separated `/proc/<pid>/cmdline`); undefined when unreadable. */
async function readProcArgv(pid: number): Promise<string[] | undefined> {
	if (!validPid(pid)) return undefined;
	try {
		const file = await open(`/proc/${pid}/cmdline`);
		const window = Buffer.allocUnsafe(128 * 1024 + 1);
		let length: number;
		try {
			({ bytesRead: length } = await file.read(window));
		} finally {
			await file.close();
		}
		if (length === window.length) return undefined;
		const buf = window.subarray(0, length);
		const tokens: string[] = [];
		let start = 0;
		for (let i = 0; i < buf.length; i++) {
			if (buf[i] === 0) {
				tokens.push(buf.subarray(start, i).toString("utf8"));
				start = i + 1;
			}
		}
		if (start < buf.length) tokens.push(buf.subarray(start).toString("utf8")); // argv's final token has no trailing NUL
		return tokens;
	} catch {
		return undefined;
	}
}

/** The process's working directory, realpathed; undefined when unreadable (deleted dir, permissions). */
async function procCwd(pid: number): Promise<string | undefined> {
	try {
		return await readlink(`/proc/${pid}/cwd`);
	} catch {
		return undefined;
	}
}

/** The process's executable, realpathed; undefined when unreadable (gone, permissions). */
async function procExe(pid: number): Promise<string | undefined> {
	try {
		return await realpath(`/proc/${pid}/exe`);
	} catch {
		return undefined;
	}
}

/** Display a argv as a quoted, cap-stated command line (for the dialog/toast). */
function displayArgv(argv: readonly string[]): string {
	const quoted = argv.map((t) => (/[\s"]/.test(t) ? `"${t.replaceAll('"', '\\"')}"` : t));
	const line = quoted.join(" ");
	return line.length > COMMAND_DISPLAY_CAP ? `${line.slice(0, COMMAND_DISPLAY_CAP - 1)}…` : line;
}

/**
 * Canonical form of one argv token, resolved against the verified project cwd
 * when it is not absolute; undefined when it names no file (a flag, a
 * subcommand, a gone path).
 */
async function canonicalToken(token: string, cwd: string): Promise<string | undefined> {
	if (!token || token.length > 4096) return undefined;
	const abs = token[0] === "/" ? token : join(cwd, token);
	try {
		return await realpath(abs);
	} catch {
		return undefined;
	}
}

/**
 * Match the prefix at the start of argv, canonical token by token. Both sides are canonicalized against the verified cwd, so a
 * symlinked or relative spelling of the SAME files still matches, while a
 * different executable, loader or entry never does.
 */
async function matchLaunchPrefix(argv: readonly string[], prefix: readonly string[], cwd: string): Promise<number> {
	const wanted: string[] = [];
	for (const token of prefix) {
		const canonical = await canonicalToken(token, cwd);
		if (canonical === undefined) return -1;
		wanted.push(canonical);
	}
	if (argv.length < wanted.length) return -1;
	for (let i = 0; i < wanted.length; i++) {
		if (await canonicalToken(argv[i]!, cwd) !== wanted[i]) return -1;
	}
	return 0;
}

/**
 * One full verification round (§7.2.1 checks 1–4). Pure reads: this NEVER
 * signals; the only signal site is `attachedStopAction()` after check 5.
 * The pinned lock and status must agree on the live holder. The browser's
 * pid is only a confirmation echo.
 */
export async function verifyAttachedStop(projectRoot: string, opts: VerifyOpts = {}): Promise<AttachedStopCheck> {
	if (!procAvailable()) {
		return fail(501, "platform", undefined, "safe attached stop requires /proc — stop the run from its terminal");
	}
	let holder: number | undefined;
	try {
		const payload = await readJobStatus(projectRoot);
		const lock = await readJobLock(projectRoot);
		holder = payload?.lockedByPid;
		if (holder !== undefined && lock !== holder) {
			return fail(409, "state-refused", holder, "status and lock do not identify the same holder — nothing was signalled");
		}
	} catch (err) {
		if (!(err instanceof JobStateRefusal)) throw err;
		return fail(409, "state-refused", undefined, err.message);
	}
	const live = await processIdentity(holder);
	if (holder === undefined || !live) {
		return fail(
			409, holder === undefined ? "no-holder" : "stale", holder,
			holder === undefined
				? "no run holds .orch/lock right now — .orch/status.json names no holder; there is nothing to stop"
				: `the pid .orch/status.json names (${holder}) is not alive anymore — a stale side-car flush; the next .orch open recovers the lock, and nothing was signalled`,
		);
	}
	if (holder === process.pid) {
		return fail(409, "transient-self", holder, "the only holder in .orch/status.json is this ui server's own brief readout window — a timing blip, not a run; nothing was signalled");
	}
	if ((opts.uiJobPids ?? []).includes(holder)) {
		return fail(409, "ui-job", holder, `pid ${holder} is a job this ui launched — use its ordinary Stop button (the record's stop path signals the same pid)`);
	}
	if (opts.expectedPid !== undefined && opts.expectedPid !== holder) {
		return fail(409, "moved", holder, `the lock holder changed: it is pid ${holder} now, not the pid ${opts.expectedPid} shown when you confirmed — re-check and confirm the new identity`);
	}


	const argv = await readProcArgv(holder);
	const cwd = await procCwd(holder);
	if (argv === undefined) {
		return fail(409, "identity", holder, `pid ${holder} is alive but its command line could not be read from /proc — cannot verify it as this project's run loop; nothing was signalled`);
	}

	// 3. working directory
	if (cwd === undefined) {
		return fail(409, "cwd", holder, `pid ${holder} is alive but its working directory could not be read from /proc — cannot verify it as this project's run loop; nothing was signalled`);
	}
	const rootReal = projectRoot;
	if (cwd !== rootReal) {
		return fail(409, "cwd", holder, `pid ${holder} is alive but its working directory is ${cwd}, not this project (${rootReal}) — nothing was signalled`);
	}

	// 4. command identity — the SAME host-owned launch identity the UI records
	// for its own jobs (one descriptor, one argv prefix; no re-resolution chain).
	let launch: TrustedLaunchPrefix;
	try {
		const installation = opts.installation ?? (await currentInstallationForStop());
		launch = await requireLaunchPrefix(installation, "cli", { targetRoot: projectRoot });
	} catch (err) {
		const reason = err instanceof TrustedInstallationError ? `${err.code}: ${err.message}` : (err as Error).message;
		return fail(409, "cli-unresolved", holder, `the trusted CLI entry this ui launches cannot be resolved (${reason}) — cannot verify the attached run's identity against it; nothing was signalled`);
	}
	// A project record may be absent or modified. The actual parent still
	// identifies children of our detached runner as ordinary Stop targets.
	const parentArgs = await readProcArgv(live.parentPid);
	const parentJobId = parentArgs?.[5];
	const parentBinding = parentArgs?.[7];
	if (parentJobId && JOB_ID_RE.test(parentJobId) && parentBinding && /^[a-f0-9]{64}$/.test(parentBinding)
		&& sameArgv(parentArgs, [launch.node, ...jobRunnerArgs(projectRoot, parentJobId, parentBinding)])
		&& await procExe(live.parentPid) === launch.node && await procCwd(live.parentPid) === projectRoot) {
		return fail(409, "ui-job", holder, `pid ${holder} is a child of the ui job runner — use ordinary Stop`);
	}
	const launchNode = await canonicalToken(launch.node, cwd);
	const exe = await procExe(holder);
	if (exe === undefined || launchNode === undefined || exe !== launchNode) {
		return fail(
			409,
			"identity",
			holder,
			`pid ${holder} is alive in this project, but its executable (${exe ?? "unreadable"}) is not the trusted node interpreter this ui launches (${launchNode ?? launch.node}) — the ui only signals a run loop it can name; stop it from its terminal`,
		);
	}
	const prefixIdx = await matchLaunchPrefix(argv, launch.argv, cwd);
	if (prefixIdx < 0) {
		return fail(
			409,
			"identity",
			holder,
			`pid ${holder} is alive in this project, but its command line (${displayArgv(argv)}) does not match this ui's trusted CLI launch identity for the installed CLI entry (${displayArgv([...launch.argv])}) — the ui only signals a run loop it can name; stop it from its terminal`,
		);
	}
	const sub = argv[prefixIdx + launch.argv.length];
	if (!(STOPPABLE_SUBCOMMANDS as readonly string[]).includes(sub ?? "")) {
		return fail(409, "subcommand", holder, `pid ${holder} runs ${sub ? `the CLI subcommand '${sub}'` : "the CLI with no subcommand"} — the ui only interrupts the plan/run loops that own .orch/lock; nothing was signalled`);
	}

		try {
		if (await readJobLock(projectRoot) !== holder || (await readJobStatus(projectRoot))?.lockedByPid !== holder
			|| (await processIdentity(holder))?.startTime !== live.startTime) {
			return fail(409, "moved", holder, "the process or holder changed during verification — nothing was signalled");
		}
	} catch (err) {
		if (!(err instanceof JobStateRefusal)) throw err;
		return fail(409, "state-refused", holder, err.message);
	}
	return { ok: true, pid: holder, command: displayArgv(argv), argv, cwd, startTime: live.startTime };
}

/** Corroborate a job against its detached runner and the runner's real child. */
export async function verifyJobProcess(root: string, record: JobRecord, installation?: TrustedInstallationDescriptor): Promise<string | undefined> {
	const { pid, runnerPid, identity } = record;
	if (record.status !== "running" || !identity || !validPid(pid) || !validPid(runnerPid)
		|| pid === process.pid || runnerPid === process.pid) return undefined;
	const child = await processIdentity(pid);
	const runner = await processIdentity(runnerPid);
	if (!child || !runner || child.parentPid !== runnerPid) return undefined;
	const launch = await requireLaunchPrefix(installation ?? await currentTrustedInstallation(), "cli", { targetRoot: root });
	if (identity.node !== launch.node || !launch.argv.every((token, i) => token === record.argv[i])) return undefined;
	const expectedRunner = [launch.node, ...jobRunnerArgs(root, record.id, launchBinding(record))];
	const runnerArgs = await readProcArgv(runnerPid);
	const childArgs = await readProcArgv(pid);
	if (!sameArgv(runnerArgs, expectedRunner) || !sameArgv(childArgs, record.argv)
		|| await procExe(runnerPid) !== launch.node || await procExe(pid) !== launch.node
		|| await procCwd(runnerPid) !== root || await procCwd(pid) !== root) return undefined;
	const fresh = await processIdentity(pid);
	if (fresh?.startTime !== child.startTime || fresh.parentPid !== runnerPid
		|| (await processIdentity(runnerPid))?.startTime !== runner.startTime) return undefined;
	return child.startTime;
}

function sameArgv(actual: string[] | undefined, expected: readonly string[]): boolean {
	return actual?.length === expected.length && actual.every((token, i) => token === expected[i]);
}

/** The process descriptor for direct callers (tests); production passes the UI entry's descriptor. */
async function currentInstallationForStop(): Promise<TrustedInstallationDescriptor> {
	return await currentTrustedInstallation();
}

/**
 * The /api/jobs payload's `stop` affordance for an attached run: one
 * read-only verification round (a failed check never signals anything —
 * §7.2.1). `ok: true` is what enables the attached Stop affordance in the UI.
 */
export async function attachedStopView(
	projectRoot: string,
	pid: number,
	uiJobPids: readonly number[],
	installation?: TrustedInstallationDescriptor,
): Promise<AttachedStopView> {
	const check = await verifyAttachedStop(projectRoot, { expectedPid: pid, uiJobPids, ...(installation ? { installation } : {}) });
	if (check.ok) return { ok: true, pid: check.pid, command: check.command };
	return { ok: false, pid, reason: check.error };
}

export type AttachedStopResult =
	| { ok: true; pid: number; command: string }
	| { ok: false; fail: { status: 409 | 501; code: AttachedStopFailCode; pid?: number; error: string } };

/**
 * The action behind POST /api/actions `{ kind: "stop", target: "attached" }`
 * (§7.2.1 check 5): one verification round, an immediate re-verification
 * round (the run may have exited or the holder changed), then EXACTLY ONE
 * SIGINT to the verified pid. Never SIGTERM/SIGKILL; never more than one
 * signal per call. Any failed check answers with its plain-words reason and
 * no signal.
 */
export async function attachedStopAction(projectRoot: string, opts: VerifyOpts = {}): Promise<AttachedStopResult> {
	const first = await verifyAttachedStop(projectRoot, opts);
	if (!first.ok) return { ok: false, fail: { status: first.status, code: first.code, pid: first.pid, error: first.error } };

	// re-verify immediately before the signal (the confidence round trips fast;
	// a run can still exit in the sliver after it — that is accepted and
	// reported, never retried, never re-signalled).
	const second = await verifyAttachedStop(projectRoot, { ...opts, expectedPid: first.pid });
	if (!second.ok) {
		return { ok: false, fail: { status: second.status, code: second.code, pid: second.pid, error: `${second.error}` } };
	}
	if (second.startTime !== first.startTime) {
		return { ok: false, fail: fail(409, "moved", second.pid, "the holder process changed — nothing was signalled") };
	}
	try {
		process.kill(second.pid, "SIGINT"); // the kit's clean-close path: exit 130, resumable
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code ?? "?";
		const sameRound = second.pid;
		return {
			ok: false,
			fail: {
				status: 409,
				code: "signal",
				pid: sameRound,
				error:
					code === "ESRCH"
						? `the run exited between the verification and the signal — pid ${second.pid} is gone, nothing was signalled (its outcome is in the side-cars)`
						: commandNotAllowed(code, second.pid),
			},
		};
	}
	return { ok: true, pid: second.pid, command: second.command };
}

function commandNotAllowed(code: string, pid: number): string {
	if (code === "EPERM") return `cannot signal the verified pid ${pid}: permission denied (EPERM) — the run belongs to another user; nothing was signalled`;
	return `cannot signal the verified pid ${pid}: ${code} — nothing was signalled`;
}

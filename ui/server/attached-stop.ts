/**
 * Verified attached stop (M5-slice-3, ui/PRD.md §7.2.1):
 *
 * A terminal-started run (a live `.orch/status.json` holder that no UI job
 * record claims) may be interrupted from the UI ONLY when its process identity
 * verifies, checked server-side straight off the operating system. Variant A:
 * NO seam change — `lockedByPid` already rides `status.json`, and `/proc/`
 * carries the rest (Linux-only v1; on machines without `/proc` the check
 * refuses with a plain reason and nothing is ever signalled).
 *
 * The whole contract, per check (ALL must pass; any failure answers with its
 * plain-words reason and sends NO signal — never SIGTERM, never SIGKILL):
 *   1. holder truth  — a FRESH `status.json` read names a live `lockedByPid`
 *                      that is not this server's own readout window and not a
 *                      pid a running UI job record already claims;
 *   2. platform      — `/proc` exists (liveness itself probes signal-0 on any
 *                      OS; the deeper checks need `/proc`);
 *   3. working dir   — `/proc/<pid>/cwd` realpath equals the project root;
 *   4. command line  — `/proc/<pid>/exe` and `/proc/<pid>/cmdline` match the
 *                      SAME descriptor/argv identity this UI launches its own
 *                      jobs from (M1-P01 step (f): `[node, ...(loader), entry]`
 *                      selected and validated from the host descriptor — no
 *                      independent `resolveCli`, no PATH/target fallback),
 *                      followed by a lock-holding subcommand (`plan`/`run`).
 *                      Nothing else in the argv is checked.
 *   5. one signal    — the full check re-runs immediately before signalling
 *                      (the run may have exited or the holder changed), then
 *                      EXACTLY ONE SIGINT is sent; the kit's SIGINT
 *                      clean-close path leaves durable state resumable
 *                      (exit 130).
 *
 * Lock-busy/staleness never auto-kills anything (§17): every failure above
 * ends in a reason, not a signal. This module is READ-ONLY until the very
 * last, re-verified step: `attachedStopView()` (the /api/jobs payload) never
 * signals at all.
 */
import { existsSync } from "node:fs";
import { readFile, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "../../src/util/fsx.ts";
import type { StatusPayloads } from "../../src/engine/harness.ts";
import {
	TrustedInstallationError,
	currentTrustedInstallation,
	requireLaunchPrefix,
	type TrustedLaunchPrefix,
} from "../../src/sandbox/trusted-exec.ts";
import type { TrustedInstallationDescriptor } from "../../src/sandbox/types.ts";
import { pidAlive } from "./jobs.ts";
import type { AttachedStopView } from "./jobs.ts";

/** The subcommands that legitimately hold `.orch/lock` long enough to be worth interrupting. */
export const STOPPABLE_SUBCOMMANDS = ["plan", "run"] as const;

/** How long a command-line display may get before it is cut (never silently — an ellipsis states it). */
const COMMAND_DISPLAY_CAP = 240;

export type AttachedStopFailCode =
	| "no-holder"
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
	| { ok: true; pid: number; command: string; argv: string[]; cwd: string }
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

function fail(status: 409 | 501, code: AttachedStopFailCode, pid: number | undefined, error: string): AttachedStopCheck {
	return { ok: false, status, code, ...(pid !== undefined ? { pid } : {}), error };
}

/** `/proc` availability (Linux); the liveness probe works everywhere, the deeper checks do not. */
function procAvailable(): boolean {
	return existsSync("/proc/self");
}

/** The process's argv, byte-precise (NUL-separated `/proc/<pid>/cmdline`); undefined when unreadable. */
async function readProcArgv(pid: number): Promise<string[] | undefined> {
	try {
		const buf = await readFile(`/proc/${pid}/cmdline`);
		const tokens: string[] = [];
		let start = 0;
		for (let i = 0; i < buf.length; i++) {
			if (buf[i] === 0) {
				if (i > start) tokens.push(buf.subarray(start, i).toString("utf8"));
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
		return await realpath(await readlink(`/proc/${pid}/cwd`));
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
 * The index of the ONE argv position where the recorded launch identity starts
 * (`[node, ...(loader), entry]`, canonical token by token); -1 when none
 * matches. Both sides are canonicalized against the verified cwd, so a
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
	for (let i = 0; i + wanted.length <= argv.length; i++) {
		let matches = true;
		for (let j = 0; j < wanted.length; j++) {
			const actual = await canonicalToken(argv[i + j]!, cwd);
			if (actual !== wanted[j]) {
				matches = false;
				break;
			}
		}
		if (matches) return i;
	}
	return -1;
}

/**
 * One full verification round (§7.2.1 checks 1–4). Pure reads: this NEVER
 * signals; the only signal site is `attachedStopAction()` after check 5.
 * The truth source is a FRESH side-car read — the browser's pid is only a
 * confirmation echo, never the target.
 */
export async function verifyAttachedStop(projectRoot: string, opts: VerifyOpts = {}): Promise<AttachedStopCheck> {
	// 1. holder truth — straight from the side-car, never from the client
	const payload = await readJson<StatusPayloads>(join(projectRoot, ".orch", "status.json")).catch(() => undefined);
	const holder = payload?.lockedByPid;
	if (holder === undefined || !pidAlive(holder)) {
		return fail(
			409,
			holder === undefined ? "no-holder" : "stale",
			holder,
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

	// 2. platform — Linux-only v1; refusal (never a signal) anywhere without /proc
	if (!procAvailable()) {
		return fail(501, "platform", holder, "safe attached stop verifies the process identity through /proc, and this machine has none — macOS variant B (the runner recording its argv into status.json) is deferred; stop it from its terminal");
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
	const rootReal = await realpath(projectRoot).catch(() => projectRoot);
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
			`pid ${holder} is alive in this project, but its command line (${displayArgv(argv)}) is not this ui's trusted CLI launch identity (${displayArgv([...launch.argv])}) — the ui only signals a run loop it can name; stop it from its terminal`,
		);
	}
	const sub = argv[prefixIdx + launch.argv.length];
	if (!(STOPPABLE_SUBCOMMANDS as readonly string[]).includes(sub ?? "")) {
		return fail(409, "subcommand", holder, `pid ${holder} runs ${sub ? `the CLI subcommand '${sub}'` : "the CLI with no subcommand"} — the ui only interrupts the plan/run loops that own .orch/lock; nothing was signalled`);
	}

	return { ok: true, pid: holder, command: displayArgv(argv), argv, cwd };
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

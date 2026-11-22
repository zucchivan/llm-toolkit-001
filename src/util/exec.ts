/** Bounded, non-interactive child process execution for gates and git plumbing. */
import { spawn } from "node:child_process";

export interface ExecOutcome {
	code: number | null;
	stdout: string;
	stderr: string;
	/** Signal name when the process was killed (e.g. timeout SIGTERM). */
	signaledBy?: string;
	/** The deadline fired and the process group was terminated. */
	timedOut?: boolean;
	/** The stream exceeded its capture cap while running; the kept text is the tail only. */
	stdoutCapped?: boolean;
	stderrCapped?: boolean;
}

/** Per-stream capture guard (bytes): bounded buffering WHILE RUNNING, tail kept. */
export const STREAM_CAP = 256 * 1024;

const SIGTERM_GRACE_MS = 1_000;

/** Sliding per-stream window: keeps the LAST `cap` bytes and flags the overflow. */
class StreamWindow {
	private chunks: Buffer[] = [];
	private total = 0;
	capped = false;

	constructor(private readonly cap: number) {}

	push(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.total += chunk.length;
		if (this.total <= this.cap) return;
		this.capped = true;
		const joined = Buffer.concat(this.chunks);
		this.chunks = [joined.subarray(Math.max(0, joined.length - this.cap))];
		this.total = this.chunks[0]!.length;
	}

	text(): string {
		return Buffer.concat(this.chunks).toString("utf8");
	}
}

/**
 * Spawn cwd-anchored argv (no shell), capture both streams into bounded
 * per-stream windows, enforce a timeout, and support an external abort signal.
 * stdin is closed immediately: gate recipes must never block on prompts
 * ("wasteful beats interactive"). Env is inherited — M0 gates run on the host
 * (the engineering plan's §2 environment table strips env only behind the M1
 * sandbox boundary; this is admission, not containment).
 *
 * On POSIX the child gets its own process group (`detached`), so the deadline
 * terminates DESCENDANTS (spawned shells/tools), not just the direct child:
 * SIGTERM first, SIGKILL after a short grace.
 */
export function exec(argv: readonly string[], inputs: { cwd: string; timeoutMs: number; env?: Record<string, string | undefined>; signal?: AbortSignal }): Promise<ExecOutcome> {
	return new Promise((resolve) => {
		const proc = spawn(argv[0] ?? "", argv.slice(1), {
			cwd: inputs.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: inputs.env ? { ...process.env, ...inputs.env } : undefined,
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		const stdout = new StreamWindow(STREAM_CAP);
		const stderr = new StreamWindow(STREAM_CAP);
		let done = false;
		let timedOut = false;
		let escalated: NodeJS.Timeout | undefined;

		// Kill the whole process group when possible (child may have spawned
		// descendants); fall back to the direct child on Windows or failure.
		const killGroup = (signalName: NodeJS.Signals): void => {
			if (proc.pid === undefined) return;
			if (process.platform !== "win32") {
				try {
					process.kill(-proc.pid, signalName);
					return;
				} catch {
					/* group already gone; fall through to the direct child */
				}
			}
			try {
				proc.kill(signalName);
			} catch {
				/* already exited */
			}
		};

		const killTimer = setTimeout(() => {
			if (done) return;
			timedOut = true;
			killGroup("SIGTERM");
			escalated = setTimeout(() => {
				if (!done) killGroup("SIGKILL");
			}, SIGTERM_GRACE_MS);
		}, inputs.timeoutMs);

		if (inputs.signal) {
			if (inputs.signal.aborted) killGroup("SIGTERM");
			else inputs.signal.addEventListener("abort", () => { if (!done) killGroup("SIGTERM"); }, { once: true });
		}

		proc.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
		proc.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));

		const finish = (outcome: ExecOutcome): void => {
			done = true;
			clearTimeout(killTimer);
			if (escalated) clearTimeout(escalated);
			resolve(outcome);
		};

		proc.on("close", (code, signal) => {
			finish({
				code,
				stdout: stdout.text(),
				stderr: stderr.text(),
				signaledBy: signal ?? undefined,
				...(timedOut ? { timedOut: true } : {}),
				...(stdout.capped ? { stdoutCapped: true } : {}),
				...(stderr.capped ? { stderrCapped: true } : {}),
			});
		});
		proc.on("error", () => {
			finish({ code: null, stdout: stdout.text(), stderr: stderr.text(), signaledBy: "spawn" });
		});
	});
}

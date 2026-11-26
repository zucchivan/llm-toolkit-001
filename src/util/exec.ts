/** Bounded, non-interactive child process execution for gates, Git and trusted host tools. */
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

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

type OverflowMode = "tail" | "head" | "refuse";

/**
 * Per-stream capture window.
 * - `tail` (default): keeps the LAST `cap` bytes and flags the overflow.
 * - `head`: keeps the FIRST `cap` bytes and flags the overflow (display patches).
 * - `refuse`: a stream past `cap` kills the child and reports the overflow; the
 *   kept bytes are never a successful result (machine-read Git objects).
 */
class StreamWindow {
	private chunks: Buffer[] = [];
	private total = 0;
	capped = false;

	private readonly cap: number;
	private readonly mode: OverflowMode;

	constructor(cap: number, mode: OverflowMode) {
		this.cap = cap;
		this.mode = mode;
	}

	push(chunk: Buffer): void {
		if (this.mode === "head") {
			const room = this.cap - this.total;
			if (room > 0) {
				const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
				this.chunks.push(kept);
				this.total += kept.length;
			}
			if (chunk.length > Math.max(room, 0)) this.capped = true;
			return;
		}
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

	bytes(): Buffer {
		return Buffer.concat(this.chunks);
	}
}

interface BoundedSpawnInput {
	argv: readonly string[];
	cwd: string;
	timeoutMs: number;
	env: NodeJS.ProcessEnv;
	input?: Buffer | string;
	cap: number;
	overflow: OverflowMode;
	signal?: AbortSignal;
	/** Include the exact stdout bytes (binary blob/Tree reads). */
	binary?: boolean;
}

/**
 * Spawn literal argv (no shell), capture both streams into bounded per-stream
 * windows, enforce a timeout, and support an external abort signal. This is the
 * one spawn primitive behind both the legacy gate `exec` and the trusted
 * absolute-argv/exact-env seam.
 *
 * On POSIX the child gets its own process group (`detached`), so the deadline
 * terminates DESCENDANTS (spawned shells/tools), not just the direct child:
 * SIGTERM first, SIGKILL after a short grace.
 */
function spawnBounded(inputs: BoundedSpawnInput): Promise<ExecOutcome & { stdoutBytes?: Buffer }> {
	return new Promise((resolve) => {
		const proc = spawn(inputs.argv[0] ?? "", inputs.argv.slice(1), {
			cwd: inputs.cwd,
			stdio: [inputs.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			env: inputs.env,
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		const stdout = new StreamWindow(inputs.cap, inputs.overflow);
		const stderr = new StreamWindow(inputs.cap, inputs.overflow);
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

		const refuseOverflow = (): void => {
			if (inputs.overflow !== "refuse" || done) return;
			killGroup("SIGTERM");
			escalated ??= setTimeout(() => {
				if (!done) killGroup("SIGKILL");
			}, SIGTERM_GRACE_MS);
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

		proc.stdout!.on("data", (chunk: Buffer) => {
			stdout.push(chunk);
			if (stdout.capped) refuseOverflow();
		});
		proc.stderr!.on("data", (chunk: Buffer) => {
			stderr.push(chunk);
			if (stderr.capped) refuseOverflow();
		});

		const finish = (outcome: ExecOutcome & { stdoutBytes?: Buffer }): void => {
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
				...(inputs.binary ? { stdoutBytes: stdout.bytes() } : {}),
				...(timedOut ? { timedOut: true } : {}),
				...(stdout.capped ? { stdoutCapped: true } : {}),
				...(stderr.capped ? { stderrCapped: true } : {}),
			});
		});
		proc.on("error", () => {
			finish({ code: null, stdout: stdout.text(), stderr: stderr.text(), signaledBy: "spawn", ...(inputs.binary ? { stdoutBytes: stdout.bytes() } : {}) });
		});
		if (inputs.input !== undefined) {
			proc.stdin!.on("error", () => { /* EPIPE: the child exited before reading stdin */ });
			proc.stdin!.end(inputs.input);
		}
	});
}

/**
 * Legacy spawn for host gate recipes: cwd-anchored argv (no shell), stdin
 * closed (or an explicit input), inherited process env plus `inputs.env`.
 * M0 gates run on the host; trusted Git/gh calls use `execTrusted` below and
 * never merge the inherited environment.
 */
export function exec(argv: readonly string[], inputs: { cwd: string; timeoutMs: number; env?: Record<string, string | undefined>; signal?: AbortSignal }): Promise<ExecOutcome> {
	return spawnBounded({
		argv,
		cwd: inputs.cwd,
		timeoutMs: inputs.timeoutMs,
		env: inputs.env ? { ...process.env, ...inputs.env } : process.env,
		cap: STREAM_CAP,
		overflow: "tail",
		...(inputs.signal ? { signal: inputs.signal } : {}),
	});
}

export interface TrustedExecInput {
	cwd: string;
	timeoutMs: number;
	/** Exact host-built environment; the inherited process env is NEVER merged. */
	env: Readonly<Record<string, string>>;
	/** Bytes written to stdin, then closed (plumbing input). */
	input?: Buffer | string;
	/** Per-stream byte cap; defaults to `STREAM_CAP`. */
	maxOutputBytes?: number;
	/** Default `tail`; Git machine reads use `refuse`, display diffs use `head`. */
	overflow?: OverflowMode;
	/** Return the exact stdout bytes as well as the decoded text. */
	binary?: boolean;
	signal?: AbortSignal;
}

export interface TrustedExecOutcome extends ExecOutcome {
	/** Exact stdout bytes when `binary` was requested (blob/Object reads). */
	stdoutBytes?: Buffer;
	/** A stream passed the cap (tail/head kept a slice; refuse killed the child). */
	overflowed?: boolean;
	/** The seam refused before spawning anything. */
	refused?: "argv" | "env";
}

function trustedRefusal(reason: string, refused: "argv" | "env"): TrustedExecOutcome {
	return { code: null, stdout: "", stderr: `trusted exec refused: ${reason}`, signaledBy: "trusted-exec", refused };
}

/**
 * The trusted host-execution seam: a fixed literal argv whose `argv[0]` is an
 * absolute, resolver-selected installation path, and an exact host-built
 * environment with no inherited values. A bare/relative program name or an
 * unsafe environment is refused BEFORE any spawn (no PATH lookup exists here).
 */
export function execTrusted(argv: readonly string[], inputs: TrustedExecInput): Promise<TrustedExecOutcome> {
	if (argv.length === 0 || typeof argv[0] !== "string" || !isAbsolute(argv[0])) {
		return Promise.resolve(trustedRefusal("argv[0] must be a selected absolute installation path", "argv"));
	}
	for (const arg of argv) {
		if (typeof arg !== "string" || arg.includes("\0")) return Promise.resolve(trustedRefusal("argv must be NUL-free strings", "argv"));
	}
	if (!inputs.env || typeof inputs.env !== "object" || Array.isArray(inputs.env)) {
		return Promise.resolve(trustedRefusal("environment must be an explicit host-built object", "env"));
	}
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(inputs.env)) {
		if (!key || key.includes("=") || key.includes("\0") || typeof value !== "string" || value.includes("\0")) {
			return Promise.resolve(trustedRefusal(`environment entry ${JSON.stringify(key)} is invalid`, "env"));
		}
		env[key] = value;
	}
	const cap = inputs.maxOutputBytes ?? STREAM_CAP;
	if (!Number.isSafeInteger(cap) || cap <= 0) return Promise.resolve(trustedRefusal("output cap must be a positive integer", "env"));
	const overflow = inputs.overflow ?? "tail";
	if (overflow !== "tail" && overflow !== "head" && overflow !== "refuse") {
		return Promise.resolve(trustedRefusal("overflow mode is invalid", "env"));
	}
	return spawnBounded({
		argv,
		cwd: inputs.cwd,
		timeoutMs: inputs.timeoutMs,
		env,
		cap,
		overflow,
		...(inputs.binary ? { binary: true } : {}),
		...(inputs.input !== undefined ? { input: inputs.input } : {}),
		...(inputs.signal ? { signal: inputs.signal } : {}),
	}).then((outcome) => ({
		...outcome,
		...(outcome.stdoutCapped || outcome.stderrCapped ? { overflowed: true } : {}),
	}));
}

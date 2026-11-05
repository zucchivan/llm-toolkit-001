/** Bounded, non-interactive child process execution for gates and git plumbing. */
import { spawn } from "node:child_process";

export interface ExecOutcome {
	code: number | null;
	stdout: string;
	stderr: string;
	/** Signal name when the process was killed (e.g. timeout SIGTERM). */
	signaledBy?: string;
}

const STREAM_CAP = 256 * 1024; // per stream capture guard

/**
 * Spawn cwd-anchored argv (no shell), capture both streams (tail-capped),
 * enforce a timeout. stdin is closed immediately: gate recipes must never
 * block on prompts ("wasteful beats interactive"). Env is inherited.
 */
export function exec(argv: readonly string[], inputs: { cwd: string; timeoutMs: number; env?: Record<string, string | undefined> }): Promise<ExecOutcome> {
	return new Promise((resolve) => {
		const proc = spawn(argv[0] ?? "", argv.slice(1), {
			cwd: inputs.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: inputs.env ? { ...process.env, ...inputs.env } : undefined,
		});
		let stdout = "";
		let stderr = "";
		let done = false;
		const killTimer = setTimeout(() => {
			if (done) return;
			try {
				proc.kill("SIGTERM");
			} catch {
				/* already exited */
			}
		}, inputs.timeoutMs);

		proc.stdout!.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		proc.stderr!.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		proc.on("close", (code, signal) => {
			done = true;
			clearTimeout(killTimer);
			// Enforce per-stream caps from the tail.
			resolve({
				code,
				stdout: cut(stdout, STREAM_CAP),
				stderr: cut(stderr, STREAM_CAP),
				signaledBy: signal ?? undefined,
			});
		});
		proc.on("error", () => {
			done = true;
			clearTimeout(killTimer);
			resolve({ code: null, stdout, stderr, signaledBy: "spawn" });
		});
	});
}

function cut(text: string, cap: number): string {
	if (text.length <= cap) return text;
	return text.slice(text.length - cap);
}

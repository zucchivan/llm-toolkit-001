/**
 * Cross-process advisory lock backed by `open(2)` with O_EXCL.
 *
 * pi-durable allows exactly one process to own a storage at a time (see
 * docs/api-map.md §3.1). Before any command opens `.orch/durable.sqlite`
 * it must hold `.orch/lock`. The lock file records the owning PID so a stale
 * lock (crashed process) can be detected and recovered.
 */
import { open, stat } from "node:fs/promises";
import { constants, readFileSync, unlinkSync, existsSync } from "node:fs";

export const STALE_LOCK_MS = 30_000;

export interface LockHandle {
	/** Release the lock. Idempotent. */
	release(): void;
}

function readPid(path: string): { pid?: number; at?: number } {
	try {
		const raw = readFileSync(path, "utf8");
		// Format: "<pid>\n<iso timestamp>\n" (timestamp written after acquire).
		const [pidLine, tsLine] = raw.split("\n");
		const pid = Number.parseInt(pidLine ?? "", 10);
		const at = tsLine ? Date.parse(tsLine) : undefined;
		return { pid: Number.isFinite(pid) ? pid : undefined, at: Number.isFinite(at) ? at : undefined };
	} catch {
		return {};
	}
}

/**
 * Acquire the lock file. Refuses politely (throws `LockBusy`) when a live
 * process owns it. Recovers: (a) a lock whose recorded PID is dead, or
 * (b) a lock with no readable PID older than STALE_LOCK_MS (crash before the
 * PID line landed; writes are atomic so this window is small).
 */
export async function acquireLock(path: string, hint: string): Promise<LockHandle> {
	if (existsSync(path)) {
		const { pid, at } = readPid(path);
		if (pid !== undefined && Number.isInteger(pid) && pid > 0) {
			let alive = false;
			try {
				pidAlive(pid);
				alive = true;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException)?.code;
				if (code === "EPERM") alive = true; // exists but not ours
			}
			if (alive) {
				throw new LockBusyError(hint, pid, path);
			}
			// Dead owner: stale lock, fall through and recover below.
		} else {
			const info = await stat(path).catch(() => undefined);
			if (info && Date.now() - info.mtimeMs < STALE_LOCK_MS) {
				// Refuse: a live process may be between create() and its PID write.
				throw new LockBusyError(hint, undefined, path);
			}
			// Old, unreadable lock: stale, recover below.
		}
		try {
			unlinkSync(path);
		} catch {
			/* another process recovered it first; retry the create race below */
		}
	}

	// O_EXCL create: atomic first-writer-wins.
	for (;;) {
		let fd;
		try {
			fd = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") {
				// Lost the race; re-issue the polite refusal with the new owner.
				const { pid } = readPid(path);
				throw new LockBusyError(hint, pid, path);
			}
			throw err;
		}
		// Write PID, then stamp the timestamp (plaintext, two writes).
		await fd.write(`${process.pid}\n${new Date().toISOString()}\n`);
		await fd.close();
		return { release };
	}

	function release(): void {
		try {
			// Only remove when we still own it (PID matches).
			if (readPid(path).pid === process.pid) unlinkSync(path);
		} catch {
			/* already gone */
		}
	}
}

/** signal-0 probe: live when it does not throw as ESRCH */
function pidAlive(pid: number): void {
	process.kill(pid, 0);
}

export class LockBusyError extends Error {
	readonly path: string;
	readonly pid?: number;
	constructor(hint: string, pid: number | undefined, path: string) {
		super(
			`another <project> process owns ${path}` +
				(pid ? ` (pid ${pid})` : " (starting)") +
				` — ${hint} is busy; when it exits, rerun this command`,
		);
		this.path = path;
		this.pid = pid;
	}
}

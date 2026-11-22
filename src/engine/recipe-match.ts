/**
 * Recipe match evaluation (M0-P07): ALL `match` regexes must match the
 * captured stdout (stderr is never matched; an empty list is vacuously true).
 * Patterns are compiled BEFORE any recipe executes, and evaluation runs in a
 * terminable `worker_threads` job bounded by the remaining recipe deadline —
 * a repository regex (e.g. catastrophic backtracking) fails its check instead
 * of blocking the host event loop. Overrun is a failed check, never a pass.
 */
import { Worker } from "node:worker_threads";

export interface MatchOutcome {
	matched: boolean;
	/** Set when matching could not be completed inside the deadline. */
	reason?: "match-overrun" | "invalid";
	/** First pattern that did not match (for compact feedback). */
	failedPattern?: string;
}

/** Compile every pattern up front; a single invalid regex fails validation. */
export function compilePatterns(patterns: readonly string[], context: string): RegExp[] {
	return patterns.map((source) => {
		try {
			return new RegExp(source);
		} catch (err) {
			throw new Error(`${context}: invalid match regex ${JSON.stringify(source)} — fix the pattern or remove it (${(err as Error).message})`);
		}
	});
}

/**
 * Eval-worker source (CommonJS by definition for eval workers). It only tests
 * the pre-validated patterns against the bounded stdout — no filesystem, no
 * network, no env access.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { patterns, stdout } = workerData;
try {
	let failedPattern = null;
	for (const pattern of patterns) {
		if (!new RegExp(pattern).test(stdout)) { failedPattern = pattern; break; }
	}
	parentPort.postMessage({ matched: failedPattern === null, failedPattern });
} catch (err) {
	parentPort.postMessage({ matched: false, error: String(err && err.message || err) });
}
`;

/**
 * Test ALL patterns against stdout under `deadlineMs`. Terminable: a worker
 * that does not answer within the remaining recipe deadline is killed and the
 * check fails as `match-overrun`.
 */
export async function matchStdout(patterns: readonly string[], stdout: string, deadlineMs: number): Promise<MatchOutcome> {
	if (patterns.length === 0) return { matched: true };
	if (!(deadlineMs > 0)) return { matched: false, reason: "match-overrun" };
	return await new Promise<MatchOutcome>((resolve) => {
		let settled = false;
		let worker: Worker | undefined;
		const finish = (outcome: MatchOutcome): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker?.terminate();
			resolve(outcome);
		};
		const timer = setTimeout(() => finish({ matched: false, reason: "match-overrun" }), deadlineMs);
		worker = new Worker(WORKER_SOURCE, {
			eval: true,
			workerData: { patterns: [...patterns], stdout },
		});
		worker.on("message", (msg: { matched?: boolean; failedPattern?: string | null; error?: string }) => {
			if (msg.error) return finish({ matched: false, reason: "invalid" });
			finish({ matched: msg.matched === true, ...(msg.failedPattern ? { failedPattern: msg.failedPattern } : {}) });
		});
		worker.on("error", (err: Error) => finish({ matched: false, reason: "invalid", failedPattern: err?.message }));
	});
}

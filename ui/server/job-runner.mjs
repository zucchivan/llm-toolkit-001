#!/usr/bin/env node
/**
 * job-runner — detached runner for one UI action (ui/PRD.md Appendix B).
 *
 *   node job-runner.mjs --record <path-to-job-record.json>
 *
 * Spawned DETACHED (own process group, argv-only, no shell) by the UI server;
 * survives UI server/browser death. It reads the record for { argv, cwd,
 * logPath } and:
 *   1. spawns the CLI child argv-only, stdout+stderr fd-attached to the log;
 *   2. patches the record's `pid` to the CLI child's pid (the lock holder —
 *      status.json and /api/jobs correlate through it);
 *   3. on CLI exit writes { endedAt, exitCode, signal?, status } atomically, then exits.
 *
 * SIGINT/SIGTERM are forwarded to the CLI child and NOT honored by the runner —
 * it stays alive to observe the child's exit (graceful stop: the CLI closes
 * durable state, exits 130, the record finalizes). A runner killed hard leaves
 * a `running` record whose pid no longer exists → `stale` on next server start.
 */
import { open, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { constants } from "node:os";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: { record: { type: "string" } },
	strict: true,
});

function fail(message) {
	process.stderr.write(`job-runner: ${message}\n`);
	process.exit(1);
}

if (!values.record) fail("--record <path> is required");

/** Read the record; crash loudly (a dead runner = detectable stale record). */
const record = await readFile(values.record, "utf8")
	.then((text) => JSON.parse(text))
	.catch((err) => fail(`cannot read record ${values.record}: ${err.message}`));

if (!Array.isArray(record.argv) || record.argv.length === 0) fail(`record ${values.record} has no argv`);
if (!record.logPath) fail(`record ${values.record} has no logPath`);

/** statusForExit mirror: 0/42/130 → exited, else failed (§7.3). */
function statusForExit(code) {
	return code === 0 || code === 42 || code === 130 ? "exited" : "failed";
}

async function atomicWriteJson(path, value) {
	const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
	try {
		await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
		await rename(tmp, path);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

async function patchRecord(patch) {
	// Read-modify-write so a concurrent server-side patch of other fields survives.
	const current = await readFile(values.record, "utf8").then((text) => JSON.parse(text));
	await atomicWriteJson(values.record, { ...current, ...patch });
}

const log = await open(record.logPath, "a").catch((err) => fail(`cannot open log ${record.logPath}: ${err.message}`));
const env = { ...process.env, KIT_UI_JOB: "1" };

let child;
try {
	child = spawn(record.argv[0], record.argv.slice(1), {
		cwd: record.cwd ?? process.cwd(),
		stdio: ["ignore", log.fd, log.fd], // fd-attached: the CLI's own writes land when it flushes
		env,
	});
} catch (err) {
	await patchRecord({ endedAt: Date.now(), exitCode: 127, status: "failed", detail: `spawn failed: ${err.message}` });
	process.exit(0);
}

// Attach outcome listeners BEFORE any await: a spawn error (ENOENT/EACCES) can
// fire within microtasks — an unobserved 'error' event would kill the runner
// and leave the record unfinalized.
const outcomeP = new Promise((resolve) => {
	child.on("error", (err) => resolve({ signal: undefined, error: err.message }));
	child.on("close", (code, signal) => resolve({ signal, error: undefined, exitCode: code }));
});

// The record's lock-holder pid is the CLI child (correlates with status.json).
await patchRecord({ pid: child.pid }).catch(() => {});

// Signals: forward, do not die (staying alive is what makes the exit record truthful).
// The child may already be gone — a throw inside the handler would kill the
// runner before it can finalize the record.
process.on("SIGINT", () => { try { child.kill("SIGINT"); } catch {} });
process.on("SIGTERM", () => { try { child.kill("SIGTERM"); } catch {} });

const outcome = await outcomeP;

const signum = outcome.signal ? (constants.signals[outcome.signal] ?? 15) : 0; // null signal ⇒ plain exit
const code =
	outcome.error !== undefined ? 127 : outcome.signal ? 128 + signum : (outcome.exitCode ?? 127);

await log.close().catch(() => {});
const patch = {
	endedAt: Date.now(),
	exitCode: code,
	status: statusForExit(code),
};
if (outcome.signal) patch.signal = outcome.signal;
if (outcome.error) patch.detail = outcome.error;
await patchRecord(patch);
process.exit(0);

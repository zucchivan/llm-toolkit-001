#!/usr/bin/env node
/**
 * job-runner — detached runner for one UI action (ui/PRD.md Appendix B).
 *
 *   node job-runner.mjs --record <path-to-job-record.json>
 *
 * Spawned DETACHED (own process group, argv-only, no shell) by the UI server;
 * survives UI server/browser death. It reads the record for
 * { argv, identity, cwd, logPath } and:
 *   0. revalidates the recorded canonical argv against the recorded host-owned
 *      launch identity (M1-P01 step (f)): the argv must start with exactly
 *      [node, ...(loader), entry], every recorded path must still be an
 *      absolute, regular, non-symlink, operator/root-owned, non-group/writable
 *      file, and the identity must belong to THIS installation. There is no
 *      re-resolution here: no descriptor/profile read, no PATH, no target
 *      `.bin`, no `KIT_*` value. A mismatch refuses BEFORE any spawn;
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
import { lstat, open, readFile, realpath, rename, writeFile, unlink } from "node:fs/promises";
import { constants } from "node:os";
import { isAbsolute, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
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

// ---------------------------------------------------------------------------
// Step 0 — revalidate the recorded launch identity (before ANY spawn)
// ---------------------------------------------------------------------------

/**
 * This runner's own installation root, proven from its module URL exactly like
 * the host descriptor's running-installation identity (…/<root>/ui/server/
 * job-runner.mjs). Never derived from cwd, argv, PATH or the record.
 */
function runnerInstallationRoot() {
	const runnerPath = fileURLToPath(import.meta.url);
	const serverDir = dirname(runnerPath);
	const uiDir = dirname(serverDir);
	if (basename(serverDir) !== "server" || basename(uiDir) !== "ui") return undefined;
	return dirname(uiDir);
}

const RUNNER_ROOT = runnerInstallationRoot();

function refusal(message) {
	return new Error(`refused: ${message}`);
}

function assertRecordedPath(value, label) {
	if (typeof value !== "string" || value.length === 0) throw refusal(`the launch identity has no ${label}`);
	if (!isAbsolute(value)) throw refusal(`the launch identity's ${label} is not absolute: ${value}`);
}

async function validateRecordedFile(path, label) {
	let info;
	try {
		info = await lstat(path);
	} catch (err) {
		throw refusal(`the recorded ${label} is gone or unreadable (${err.message}); rerun the action from the ui`);
	}
	if (info.isSymbolicLink() || !info.isFile()) {
		throw refusal(`the recorded ${label} is not a regular non-symlink file: ${path}`);
	}
	if ((info.mode & 0o022) !== 0) throw refusal(`the recorded ${label} became group/world writable: ${path}`);
	if (typeof process.getuid === "function" && info.uid !== process.getuid() && info.uid !== 0) {
		throw refusal(`the recorded ${label} is no longer owned by the operator or root: ${path}`);
	}
	let actual;
	try {
		actual = await realpath(path);
	} catch (err) {
		throw refusal(`cannot canonicalize the recorded ${label} (${err.message})`);
	}
	if (actual !== path) throw refusal(`the recorded ${label} now traverses a symlink: ${path} -> ${actual}`);
}

/**
 * Validate the record against its own host-owned identity. This is a
 * consistency + file-trust recheck of the ONE recorded identity, not a second
 * resolution chain: nothing here can choose a different executable.
 */
async function validateLaunchIdentity(record) {
	if (RUNNER_ROOT === undefined) throw refusal("the runner's own installation root cannot be proven from its module path");
	const identity = record.identity;
	if (identity === null || typeof identity !== "object") throw refusal("the record carries no launch identity");
	if (identity.version !== 1) throw refusal(`unsupported launch identity version ${JSON.stringify(identity.version)}`);
	if (identity.tool !== "cli") throw refusal(`the launch identity is not a cli identity (${JSON.stringify(identity.tool)})`);
	assertRecordedPath(identity.installationRoot, "installation root");
	if (identity.installationRoot !== RUNNER_ROOT) {
		throw refusal(`the record was written by a different installation (${identity.installationRoot}); this runner belongs to ${RUNNER_ROOT}`);
	}
	assertRecordedPath(identity.node, "node interpreter");
	assertRecordedPath(identity.entry, "cli entry");
	if (identity.form === "source") assertRecordedPath(identity.loader, "tsx loader");
	else if (identity.form === "built") {
		if (identity.loader !== undefined) throw refusal("a built entry must not record a loader");
	} else throw refusal(`unknown launch form ${JSON.stringify(identity.form)}`);

	const expected = [identity.node, ...(identity.loader !== undefined ? [identity.loader] : []), identity.entry];
	if (!Array.isArray(identity.argvPrefix) || identity.argvPrefix.length !== expected.length) {
		throw refusal("the record's argvPrefix does not match its launch identity");
	}
	for (let i = 0; i < expected.length; i++) {
		if (identity.argvPrefix[i] !== expected[i]) throw refusal("the record's argvPrefix does not match its launch identity");
	}
	if (!Array.isArray(record.argv) || record.argv.length < expected.length) {
		throw refusal(`the record's argv does not start with the recorded identity prefix (${expected.join(" ")})`);
	}
	for (let i = 0; i < expected.length; i++) {
		if (record.argv[i] !== expected[i]) throw refusal(`argv[${i}] (${record.argv[i]}) is not the recorded launch identity token (${expected[i]})`);
	}
	if (typeof record.cwd !== "string" || !isAbsolute(record.cwd)) throw refusal("the record's cwd is not an absolute path");

	for (const [label, path] of [["node interpreter", identity.node], ["cli entry", identity.entry], ...(identity.loader !== undefined ? [["tsx loader", identity.loader]] : [])]) {
		await validateRecordedFile(path, label);
	}
	return { entry: identity.entry, prefixLength: expected.length };
}

try {
	await validateLaunchIdentity(record);
} catch (err) {
	// Finalize the record with the plain reason — the ui must not show a job
	// that silently stays "running". No log is opened and NOTHING is spawned.
	await patchRecord({ endedAt: Date.now(), exitCode: 127, status: "failed", detail: err.message }).catch(() => {});
	process.exit(0);
}

const log = await open(record.logPath, "a").catch((err) => fail(`cannot open log ${record.logPath}: ${err.message}`));
const env = { ...process.env, KIT_UI_JOB: "1" };

let child;
try {
	// Exactly the revalidated recorded argv: no shell, no lookup, no PATH.
	child = spawn(record.argv[0], record.argv.slice(1), {
		cwd: record.cwd,
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

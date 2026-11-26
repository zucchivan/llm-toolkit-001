#!/usr/bin/env node
/**
 * Detached runner (Appendix B). The host supplies the project, job ID and
 * immutable launch digest as process arguments. The record can supply bytes
 * for that launch only after matching all three.
 */
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { validateTrustedExecutableFile } from "../../src/sandbox/host-profile.ts";
import { runningInstallationFrom } from "../../src/sandbox/trusted-exec.ts";
import { openSafeDirectory } from "../../src/util/safe-read.ts";
import { JOB_ID_RE, launchBinding, readJobInDirectory, statusForExit, writeJobRecord } from "./jobs.ts";

const { values: { root, id, launch } } = parseArgs({
	options: { root: { type: "string" }, id: { type: "string" }, launch: { type: "string" } },
	strict: true,
});

async function run() {
	if (!root || root !== process.cwd() || !id || !JOB_ID_RE.test(id) || !/^[a-f0-9]{64}$/.test(launch ?? "")) {
		throw new Error("host launch authority is missing or invalid");
	}
	const opened = await openSafeDirectory({ root, path: ".orch/ui/jobs" });
	if (opened.kind !== "ok") throw new Error("cannot pin the project's job directory");
	const dir = opened.value;
	try {
		const record = await readJobInDirectory(dir, root, id);
		if (!record) throw new Error("job record is absent");
		const launched = { ...record, runnerPid: process.pid };
		// Refusal finalization writes only to the pinned slot. Never merge new
		// project-record bytes into the runner's in-memory lifecycle.
		try {
			if (record.status !== "running" || launchBinding(record) !== launch) {
				throw new Error("record differs from the host launch binding");
			}
			await validateLaunch(record);
		} catch (error) {
			await writeJobRecord(dir, { ...launched, pid: undefined, endedAt: Date.now(),
				exitCode: 127, status: "failed", detail: `refused: ${error.message}` });
			return;
		}

		let log;
		try {
			// Exclusive creation refuses pre-existing files, hard links, symlinks
			// and special files. The child inherits the opened file, never a path.
			log = await open(join(dir.descriptorPath, `${id}.log`),
				fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
			const outcome = await runChild(dir, launched, log.fd);
			const signalNumber = outcome.signal ? (osConstants.signals[outcome.signal] ?? 15) : 0;
			const code = outcome.signal ? 128 + signalNumber : (outcome.code ?? 127);
			await writeJobRecord(dir, { ...launched, pid: outcome.pid, endedAt: Date.now(),
				exitCode: code, status: statusForExit(code), signal: outcome.signal, detail: outcome.error });
		} catch (error) {
			await writeJobRecord(dir, { ...launched, pid: undefined, endedAt: Date.now(),
				exitCode: 127, status: "failed", detail: `refused: ${error.message}` });
		} finally {
			await log?.close();
		}
	} finally {
		await dir.close();
	}
}

async function validateLaunch(record) {
	const running = runningInstallationFrom(new URL("../../src/sandbox/trusted-exec.ts", import.meta.url).href);
	const identity = record.identity;
	if (identity?.version !== 1 || identity.tool !== "cli" || identity.installationRoot !== running.root
		|| identity.node !== process.execPath || !["built", "source"].includes(identity.form)
		|| (identity.form === "source") !== (typeof identity.loader === "string")) {
		throw new Error("invalid recorded installation identity");
	}
	const prefix = [identity.node, ...(identity.loader === undefined ? [] : [identity.loader]), identity.entry];
	if (JSON.stringify(identity.argvPrefix) !== JSON.stringify(prefix)
		|| !prefix.every((token, i) => record.argv[i] === token)) {
		throw new Error("invalid recorded argv identity");
	}
	for (const path of prefix) {
		await validateTrustedExecutableFile(path, "job launch", {
			targetRoot: root,
			allowRunningInstallationEntry: running.trustedEntries.includes(path)
				|| (path === identity.loader && path === join(running.root, "ui", "node_modules", "tsx", "dist", "cli.mjs")),
		});
	}
}

async function runChild(dir, record, logFd) {
	const child = spawn(record.argv[0], record.argv.slice(1), {
		cwd: "/proc/self/cwd",
		stdio: ["ignore", logFd, logFd],
		env: { ...process.env, KIT_UI_JOB: "1" },
	});
	const outcome = new Promise((resolve) => {
		child.once("error", (error) => resolve({ error: error.message }));
		child.once("close", (code, signal) => resolve({ code, signal, pid: child.pid }));
	});
	// Keep observing the child if the runner itself receives a terminal signal.
	process.on("SIGINT", () => { child.kill("SIGINT"); });
	process.on("SIGTERM", () => { child.kill("SIGTERM"); });
	await writeJobRecord(dir, { ...record, pid: child.pid }).catch(() => {});
	return await outcome;
}

try {
	await run();
} catch (error) {
	process.stderr.write(`job-runner: refused: ${error.message}\n`);
	process.exitCode = 1;
}

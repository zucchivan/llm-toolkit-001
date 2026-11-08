/**
 * Verified attached stop tests (M5-slice-3, ui/PRD.md §7.2.1):
 * the identity of a terminal-spawned runner (liveness + cwd + installed-entry
 * cmdline) verifies before anything is signalled; every failed check is a
 * plain-words reason and NO signal — the foreign holder survives the refusal;
 * the verified path sends EXACTLY ONE SIGINT (a fixture counts them) and the
 * child exits the kit's clean-close code 130. Action-body validation plus the
 * route-level target/pid shapes (400) and the no-holder 409.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { validateAction } from "../server/actions.ts";
import { attachedStopAction, attachedStopView, verifyAttachedStop } from "../server/attached-stop.ts";
import { jobsDir, pidAlive } from "../server/jobs.ts";
import { bake, postAction, actionHeaders, waitFor } from "./actions-helper.ts";

const SKIP = !existsSync("/proc"); // checks 3–4 read /proc; §7.2.1 documents the platform line

/**
 * The runner fixture: `run` installs the kit-shaped SIGINT handler (counts
 * signals to a marker file, exits 130 — the clean-close contract);
 * `plan` exits 0; every other subcommand idles so the child is verifiable but
 * stays alive long enough to be characterized.
 */
const FIXTURE = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const cmd = process.argv[2] ?? "";
const marker = process.env["FIXTURE_SIGINT_MARK"] ?? "";
if (cmd === "run") {
	process.on("SIGINT", () => {
		if (marker) { try { appendFileSync(marker, "SIGINT\\n"); } catch {} }
		process.exit(130);
	});
	try { appendFileSync(process.env["FIXTURE_READY"] ?? "", ""); } catch {} // the handler is now installed — the test may stop us
} else if (cmd === "plan") {
	console.log("PLANNED");
	process.exit(0);
}
const sleepFor = (ms) => new Promise((done) => setTimeout(done, ms));
await sleepFor(30_000); // the test stops it (or the cleanup SIGKILLs); the loop stays live so a SIGINT is processed
process.exit(1);
`;

describe.skipIf(SKIP)("verified attached stop (§7.2.1)", () => {
	let root: string;
	let fixture: string;
	const children: ChildProcess[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "ui-attached-"));
		await mkdir(join(root, ".orch"), { recursive: true });
		fixture = join(root, "fixture-runner.mjs");
		await writeFile(fixture, FIXTURE, "utf8");
	});

	afterEach(async () => {
		for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});

	afterAll(async () => {
		await rm(root, { recursive: true, force: true }).catch(() => {});
	});

	/** Spawn `node <fixture> <cmd…>` exactly like a human's terminal would (cwd = the run's project). */
	function spawnRunner(args: string[], cwd: string, marker?: string, ready?: string): ChildProcess {
		const child = spawn(process.execPath, [fixture, ...args], {
			cwd,
			stdio: "ignore",
			env: {
				...process.env,
				...(marker ? { FIXTURE_SIGINT_MARK: marker } : {}),
				...(ready ? { FIXTURE_READY: ready } : {}),
			},
		});
		children.push(child);
		return child;
	}

	/** Declare the side-car truth: this pid owns the lock right now. */
	async function declareHolder(pid: number, phase = "wave-running"): Promise<void> {
		await writeFile(
			join(root, ".orch", "status.json"),
			JSON.stringify({ lockedByPid: pid, phase, ts: Date.now() }),
			"utf8",
		);
	}

	/** Bounded wait for an exit; the exit code is the observation. */
	function exitOf(child: ChildProcess, budgetMs = 8_000): Promise<number | null | undefined> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(undefined), budgetMs);
			child.once("exit", (code) => {
				clearTimeout(timer);
				resolve(code);
			});
		});
	}

	/** resolveCli must land on the fixture (the same entry the child was spawned with). */
	function withKit(): { restore(): void } {
		process.env["KIT_UI_CLI_BIN"] = fixture;
		return { restore: () => delete process.env["KIT_UI_CLI_BIN"] };
	}

	it("a real terminal-spawned runner verifies; the action sends EXACTLY ONE SIGINT and the child exits 130", { timeout: 30_000 }, async () => {
		const marker = join(root, "sigint-marker.txt");
		const child = spawnRunner(["run"], root, marker, join(root, "fixture-ready.txt"));
		// wait for the handler to be installed before anything may signal it (the
		// /proc cmdline verifies from execve on, but the handler needs the boot)
		await waitFor(async () => existsSync(join(root, "fixture-ready.txt")), (isReady) => isReady, 8_000);
		await declareHolder(child.pid!);
		const kit = withKit();
		try {
			const check = await verifyAttachedStop(root);
			expect(check.ok).toBe(true);
			if (!check.ok) return;
			expect(check.pid).toBe(child.pid);
			expect(check.command).toContain("run");
			expect(check.cwd).toBe(root);

			const action = await attachedStopAction(root);
			expect(action.ok).toBe(true);
			if (!action.ok) return;
			expect(action.pid).toBe(child.pid);

			const code = await exitOf(child);
			expect(code).toBe(130); // resumable — the kit's clean-close contract
			const marks = (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean);
			expect(marks.length).toBe(1); // one re-verified SIGINT — never two, never TERM/KILL
		} finally {
			kit.restore();
		}
	});

	it("a mismatched confirmed pid refuses (the holder changed) — nothing is signalled", async () => {
		const child = spawnRunner(["run"], root);
		await declareHolder(child.pid!);
		const kit = withKit();
		const wrongPid = (child.pid ?? 1) + 500_000;
		try {
			const check = await verifyAttachedStop(root, { expectedPid: wrongPid });
			expect(check).toMatchObject({ ok: false, status: 409, code: "moved" });
			if (check.ok) return;
			expect(check.error).toMatch(/not the pid/);

			const action = await attachedStopAction(root, { expectedPid: wrongPid });
			expect(action).toMatchObject({ ok: false, fail: { status: 409, code: "moved" } });
			expect(pidAlive(child.pid!)).toBe(true); // survived the refused attempt
		} finally {
			kit.restore();
		}
	});

	it("a foreign command in the project dir is refused by identity — plain reason, holder survives", async () => {
		const foreign = spawn(process.execPath, ["-e", "const t = Date.now() + 30000; while (Date.now() < t) {}"], { cwd: root, stdio: "ignore" });
		children.push(foreign);
		await declareHolder(foreign.pid!);
		const kit = withKit();
		try {
			const check = await verifyAttachedStop(root);
			expect(check).toMatchObject({ ok: false, status: 409, code: "identity" });
			if (check.ok) return;
			expect(check.error).toMatch(/command line/);
			expect(check.error).toMatch(/installed CLI entry/);

			const action = await attachedStopAction(root);
			expect(action).toMatchObject({ ok: false, fail: { status: 409, code: "identity" } });
			expect(pidAlive(foreign.pid!)).toBe(true); // the refusal NEVER signals
		} finally {
			kit.restore();
		}
	});

	it("a wrong working directory refuses and names both directories", async () => {
		const child = spawnRunner(["run"], dirname(root)); // the parent dir, not the project
		await declareHolder(child.pid!);
		const kit = withKit();
		try {
			const check = await verifyAttachedStop(root);
			expect(check).toMatchObject({ ok: false, status: 409, code: "cwd" });
			if (check.ok) return;
			expect(check.error).toMatch(/working directory is/);
			expect(check.error).toContain(dirname(root));
			expect(check.error).toContain("not this project");
		} finally {
			kit.restore();
		}
	});

	it("a non-lock-holding subcommand (inspect) is refused — only plan/run loops are interruptible", async () => {
		const child = spawnRunner(["inspect"], root);
		await declareHolder(child.pid!);
		const kit = withKit();
		try {
			const check = await verifyAttachedStop(root);
			expect(check).toMatchObject({ ok: false, status: 409, code: "subcommand" });
			if (check.ok) return;
			expect(check.error).toMatch(/'inspect'/);
			expect(check.error).toMatch(/plan\/run/);
		} finally {
			kit.restore();
		}
	});

	it("no holder, then a dead holder, refuses before any platform work — nothing to signal", async () => {
		await rm(join(root, ".orch", "status.json"), { force: true });
		const absent = await verifyAttachedStop(root);
		expect(absent).toMatchObject({ ok: false, status: 409, code: "no-holder" });

		const ghost = 999_999_999; // above any plausible live pid
		await declareHolder(ghost);
		const stale = await verifyAttachedStop(root);
		expect(stale).toMatchObject({ ok: false, status: 409, code: "stale" });
		if (stale.ok) return;
		expect(stale.error).toMatch(/not alive anymore/);

		const action = await attachedStopAction(root);
		expect(action).toMatchObject({ ok: false, fail: { status: 409, code: "stale" } });
	});

	it("the server's own readout window and a UI-job pid are both refused (not a runner to stop)", async () => {
		await declareHolder(process.pid);
		const own = await verifyAttachedStop(root);
		expect(own).toMatchObject({ ok: false, code: "transient-self" });

		const child = spawnRunner(["run"], root);
		await declareHolder(child.pid!);
		const kit = withKit();
		try {
			const jobbed = await verifyAttachedStop(root, { uiJobPids: [child.pid!] });
			expect(jobbed).toMatchObject({ ok: false, code: "ui-job" });
			if (jobbed.ok) return;
			expect(jobbed.error).toMatch(/ordinary Stop/);
		} finally {
			kit.restore();
		}
	});

	it("attachedStopView shapes the /api/jobs affordance (ok + command; fail + reason)", async () => {
		const child = spawnRunner(["run"], root);
		await declareHolder(child.pid!);
		const kit = withKit();
		try {
			const ok = await attachedStopView(root, child.pid!, []);
			expect(ok).toMatchObject({ ok: true, pid: child.pid });
			if (!ok.ok) return;
			expect(ok.command).toContain("run");

			const foreign = spawn(process.execPath, ["-e", "const t = Date.now() + 30000; while (Date.now() < t) {}"], { cwd: root, stdio: "ignore" });
			children.push(foreign);
			await declareHolder(foreign.pid!);
			const notOk = await attachedStopView(root, foreign.pid!, []);
			expect(notOk).toMatchObject({ ok: false, pid: foreign.pid });
			if (notOk.ok) return;
			expect(notOk.reason).toMatch(/command line/);
		} finally {
			kit.restore();
		}
	});
});

describe("attached stop: action-body validation + routes (target/pid shapes)", () => {
	it("validation: target stays job by default; attached needs a positive integer pid", () => {
		expect(validateAction({ kind: "stop" }).ok).toBe(true);
		expect(validateAction({ kind: "stop", target: "job" }).ok).toBe(true);
		expect(validateAction({ kind: "stop", target: "attached", pid: 1234 }).ok).toBe(true);
		expect(validateAction({ kind: "stop", target: "bogus" })).toMatchObject({ ok: false, status: 400 });
		expect((validateAction({ kind: "stop", target: "bogus" }) as { error: string }).error).toMatch(/"job".*"attached"/);
		expect(validateAction({ kind: "stop", target: "attached" })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "stop", target: "attached", pid: -1 })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "stop", target: "attached", pid: "12" })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "stop", target: "attached", pid: 1.5 })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "stop", pid: 12 })).toMatchObject({ ok: false, status: 400 }); // pid only with target attached
	});

	it("route: target attached without a pid → 400; with no real holder → 409 and nothing signalled", async () => {
		const baked = await bake({ skipJobSweep: true });
		try {
			const headers = actionHeaders(baked.csrf);
			const noPid = await postAction(baked.base, baked.cookie, { kind: "stop", target: "attached" }, headers);
			expect(noPid.status).toBe(400);

			const absent = await postAction(baked.base, baked.cookie, { kind: "stop", target: "attached", pid: 999_999_999 }, headers);
			expect(absent.status).toBe(409);
			const body = (await absent.json()) as { error: string };
			expect(body.error).toMatch(/nothing to stop|not alive/);
		} finally {
			await baked.running.shutdown().catch(() => {});
			await rm(baked.root, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("route: a holder a running UI job record claims refuses with the ordinary-Stop reason — nothing is signalled (§7.2.1 check 1 at the POST gate)", async () => {
		const baked = await bake({ skipJobSweep: true });
		try {
			const headers = actionHeaders(baked.csrf);
			// A real live process in the project dir: alive and not the server's own
			// window, so checks 1a and 1b pass and the clause that must speak is the
			// running-record claim — post-fix even before any /proc identity work.
			const holder = spawn(process.execPath, ["-e", "const t = Date.now() + 30000; while (Date.now() < t) {}"], { cwd: baked.root, stdio: "ignore" });
			try {
				await writeFile(join(baked.root, ".orch", "status.json"), JSON.stringify({ lockedByPid: holder.pid!, phase: "wave-running", ts: Date.now() }), "utf8");
				const record = {
					id: "jobclaim1",
					kind: "run",
					argv: [baked.stubCli, "run"],
					cwd: baked.root,
					pid: holder.pid!,
					startedAt: Date.now(),
					status: "running",
					logPath: join(".orch", "ui", "jobs", "jobclaim1.log"),
				};
				await mkdir(jobsDir(baked.root), { recursive: true });
				await writeFile(join(jobsDir(baked.root), "jobclaim1.json"), JSON.stringify(record), "utf8");

				const res = await postAction(baked.base, baked.cookie, { kind: "stop", target: "attached", pid: holder.pid! }, headers);
				expect(res.status).toBe(409);
				const body = (await res.json()) as { error: string };
				expect(body.error).toMatch(/ordinary Stop/);

				await new Promise((r) => setTimeout(r, 300)); // a stray signal would kill a bare busy loop this fast
				expect(pidAlive(holder.pid!)).toBe(true); // survived — the refusal signalled nothing
			} finally {
				holder.kill("SIGKILL");
			}
		} finally {
			await baked.running.shutdown().catch(() => {});
			await rm(baked.root, { recursive: true, force: true }).catch(() => {});
		}
	});
});

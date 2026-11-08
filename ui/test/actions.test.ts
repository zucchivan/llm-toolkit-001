/**
 * Actions + detached-job contract tests (ui/PRD.md §11.2, §15.1, Appendix B/C):
 * allowlist + per-kind validation (400), argv construction (no shell), job
 * spawn/exit/stale via the real detached runner against a stub CLI, lock-busy
 * 409, stuck-reported-stop 409 + terminal hint, cross-origin mutation 403,
 * X-Kit-Token echo, jobs/log routes, and the server-restart sweep.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildArgv, resolveCli, startAction, stopAction, validateAction } from "../server/actions.ts";
import { markStaleRecords, pruneJobs, statusForExit, jobsList, readJobRecord, tailJobLog } from "../server/jobs.ts";
import { bake, postAction, actionHeaders, waitFor, spawnSleeper, type Baked } from "./actions-helper.ts";

describe("action validation (allowlist, per-kind shapes)", () => {
	it("rejects unknown kinds, unknown fields, non-objects", () => {
		expect(validateAction("nonsense").ok).toBe(false);
		expect(validateAction(null)).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "deploy" })).toMatchObject({ ok: false, status: 400 });
		expect((validateAction({ kind: "deploy" }) as { ok: false; error: string }).error).toMatch(/known: plan, run/);
		expect(validateAction({ kind: "plan", extra: true })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "stop", prd: "x" })).toMatchObject({ ok: false, status: 400 });
	});

	it("run without approve/resume is refused — no silent run", () => {
		expect(validateAction({ kind: "run" })).toMatchObject({ ok: false, status: 400 });
		expect((validateAction({ kind: "run" }) as { error: string }).error).toMatch(/no silent run/);
		expect(validateAction({ kind: "run", approve: true, resume: true })).toMatchObject({ ok: false, status: 400 });
		expect((validateAction({ kind: "run", approve: true, resume: true }) as { error: string }).error).toMatch(/not both/);
		expect(validateAction({ kind: "run", approve: true, resume: true })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "run", approve: true }).ok).toBe(true);
	});

	it("run tasks: non-empty unique ids only", () => {
		expect(validateAction({ kind: "run", approve: true, tasks: [] })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "run", approve: true, tasks: ["a", "a"] })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "run", approve: true, tasks: ["ok id"] })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "run", approve: true, tasks: ["t1", "t2"] }).ok).toBe(true);
	});

	it("handoff notes: non-empty, capped, dash-prefixed is refused (CLI would drop it)", () => {
		expect(validateAction({ kind: "handoff", note: "" })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "handoff", note: "-x" })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "handoff", note: "x".repeat(2001) })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "handoff", note: "note with  spaces &- but leading-dash refused only" }).ok).toBe(true);
	});

	it("verify + plan shapes", () => {
		expect(validateAction({ kind: "verify", task: "t1" }).ok).toBe(true);
		expect(validateAction({ kind: "verify", task: "" })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "plan" }).ok).toBe(true);
		expect(validateAction({ kind: "plan", prd: "docs/prd.md" }).ok).toBe(true);
		expect(validateAction({ kind: "plan", prd: "a\nb" })).toMatchObject({ ok: false, status: 400 });
	});
});

describe("argv construction: CLI only via argv arrays, never a shell", () => {
	it("maps kinds to the human-typed CLI flags", () => {
		const cli = { argv: ["/kit/dist/cli.js"], via: "test" };
		expect(buildArgv(cli, { kind: "plan" })).toEqual(["/kit/dist/cli.js", "plan"]);
		expect(buildArgv(cli, { kind: "plan", prd: "docs/prd.md" })).toEqual(["/kit/dist/cli.js", "plan", "--prd", "docs/prd.md"]);
		expect(buildArgv(cli, { kind: "run", approve: true })).toEqual(["/kit/dist/cli.js", "run", "--approve"]);
		expect(buildArgv(cli, { kind: "run", approve: true, tasks: ["t2", "t3"] })).toEqual(["/kit/dist/cli.js", "run", "--approve", "--tasks", "t2", "--tasks", "t3"]);
		expect(buildArgv(cli, { kind: "run", resume: true })).toEqual(["/kit/dist/cli.js", "run"]);
		expect(buildArgv(cli, { kind: "verify", task: "t1" })).toEqual(["/kit/dist/cli.js", "verify", "--task", "t1"]);
		expect(buildArgv(cli, { kind: "handoff", note: "keep the gate green" })).toEqual(["/kit/dist/cli.js", "handoff", "keep the gate green"]);
		expect(buildArgv(cli, { kind: "export" })).toEqual(["/kit/dist/cli.js", "export"]);
		expect(buildArgv(cli, { kind: "stop" })).toEqual([]);
	});

	it("resolves KIT_UI_CLI_BIN and wraps .js bins through node", async () => {
		const jsBin = join(await mkdtemp(join(tmpdir(), "stubbin-")), "llm-toolkit-001.js");
		await writeFile(jsBin, "#!/usr/bin/env node\n", "utf8");
		const rawBin = join(dirname(jsBin), "llm-toolkit-001");
		await writeFile(rawBin, "#!/usr/bin/env node\n", "utf8");
		process.env["KIT_UI_CLI_BIN"] = jsBin;
		try {
			expect(resolveCli("/anywhere").argv).toEqual([process.execPath, jsBin]);
		} finally {
			delete process.env["KIT_UI_CLI_BIN"];
		}
		process.env["KIT_UI_CLI_BIN"] = rawBin; // no suffix: direct spawn
		try {
			expect(resolveCli("/anywhere").argv).toEqual([rawBin]);
		} finally {
			delete process.env["KIT_UI_CLI_BIN"];
		}
	});
});

describe("exit-code mapping", () => {
	it("0/42/130 → exited; anything else failed", () => {
		expect(statusForExit(0)).toBe("exited");
		expect(statusForExit(42)).toBe("exited");
		expect(statusForExit(130)).toBe("exited");
		expect(statusForExit(1)).toBe("failed");
		expect(statusForExit(7)).toBe("failed");
	});
});

describe("actions over HTTP: auth + validation + conflict + lifecycle", () => {
	let baked: Baked;
	const envStore = new Map<string, string | undefined>();

	beforeEach(async () => {
		baked = await bake({ skipJobSweep: false });
		// route every spawned job's CLI to the stub: resolveCli runs in THIS process
		for (const key of Object.keys(process.env)) if (key.startsWith("KIT_UI_")) envStore.set(key, process.env[key]);
		process.env["KIT_UI_CLI_BIN"] = baked.stubCli;
	});

	afterEach(async () => {
		await baked.running.shutdown().catch(() => {});
		for (const [key, value] of envStore) if (value === undefined) delete process.env[key]; else process.env[key] = value;
		await rm(baked.root, { recursive: true, force: true }).catch(() => {});
	});

	it("mutations: 401 without cookie; 403 wrong/missing X-Kit-Token; 403 cross-origin", async () => {
		const noCookie = await postAction(baked.base, "", { kind: "plan" });
		expect(noCookie.status).toBe(401);
		expect(((await noCookie.json()) as { error: string }).error).toMatch(/reopen the URL/i);

		const missingHeader = await postAction(baked.base, baked.cookie, { kind: "plan" });
		expect(missingHeader.status).toBe(403);
		expect(((await missingHeader.json()) as { error: string }).error).toMatch(/X-Kit-Token/);

		const wrongHeader = await postAction(baked.base, baked.cookie, { kind: "plan" }, { "x-kit-token": "other" });
		expect(wrongHeader.status).toBe(403);

		const crossOrigin = await postAction(baked.base, baked.cookie, { kind: "plan" }, { ...actionHeaders(baked.csrf), origin: "http://evil.example:80" });
		expect(crossOrigin.status).toBe(403);
		expect(((await crossOrigin.json()) as { error: string }).error).toMatch(/not this server's origin/i);

		// the happy same-origin path (what the SPA sends)
		const sameOrigin = await postAction(baked.base, baked.cookie, { kind: "handoff", note: "probe" }, { ...actionHeaders(baked.csrf), origin: baked.base, "sec-fetch-site": "same-origin" });
		expect(sameOrigin.status).toBe(202);
	});

	it("validation errors surface as 400 with plain words; malformed JSON too", async () => {
		const badKind = await postAction(baked.base, baked.cookie, { kind: "delivery" }, actionHeaders(baked.csrf));
		expect(badKind.status).toBe(400);
		const badField = await postAction(baked.base, baked.cookie, { kind: "plan", referer: "x" }, actionHeaders(baked.csrf));
		expect(badField.status).toBe(400);
		const badJson = await postAction(baked.base, baked.cookie, "{not json", actionHeaders(baked.csrf));
		expect(badJson.status).toBe(400);
	});

	it("plan → detached job record → log tail → exit path (stub CLI)", async () => {
		const accept = await postAction(baked.base, baked.cookie, { kind: "plan", prd: "docs/prd.md" }, actionHeaders(baked.csrf));
		expect(accept.status).toBe(202);
		const { jobId, kind, via } = (await accept.json()) as { jobId: string; kind: string; via: string };
		expect(kind).toBe("plan");
		expect(via).toMatch(/KIT_UI_CLI_BIN/);

		const job = (await waitFor(() => readJobRecord(baked.root, jobId), (j) => j !== undefined && j.status !== "running", 8_000))!;
		expect(job.status).toBe("exited");
		expect(job.exitCode).toBe(0);
		expect(job.endedAt).toBeGreaterThan(job.startedAt);
		expect(job.cwd).toBe(baked.root);
		// record argv is the stub CLI spawn — a real argv, no shell (.mjs stubs run via node)
		expect(job.argv).toEqual([process.execPath, baked.stubCli, "plan", "--prd", "docs/prd.md"]);

		const log = await fetch(`${baked.base}/api/jobs/${jobId}/log?n=5`, { headers: { cookie: baked.cookie } });
		expect(log.status).toBe(200);
		const { lines } = (await log.json()) as { lines: string[] };
		expect(lines.join("\n")).toContain("PLANNED");

		// jobs list route
		const list = await fetch(`${baked.base}/api/jobs`, { headers: { cookie: baked.cookie } });
		const payload = (await list.json()) as { jobs: { id: string }[] };
		expect(payload.jobs.map((j) => j.id)).toContain(jobId);
		expect(existsSync(join(baked.root, ".orch", "ui", "jobs", `${jobId}.json`))).toBe(true);
	});

	it("a failing stub becomes status failed with exitCode; second mutating job while running → 409", async () => {
		const accept = await postAction(baked.base, baked.cookie, { kind: "verify", task: "t1" }, actionHeaders(baked.csrf));
		expect(accept.status).toBe(202);
		await waitFor(async () => (await jobsList(baked.root))[0]!, (j) => j.status !== "running", 8_000);
		// After the successful verify the queue drains; start a die-ing export:
		const die = await startAction(baked.root, { kind: "export" });
		expect(die.ok).toBe(true);
		if (die.ok) {
			const job = (await waitFor(() => readJobRecord(baked.root, die.job.id), (j) => j !== undefined && (j.status === "failed" || j.status === "exited"), 8_000))!;
			expect(job.status).toBe("failed"); // die → exit 7
			expect(job.exitCode).toBe(7);
		}
		// Now hold one open (stub run blocks until SIGINT) and check the one-mutation rule.
		const holder = await startAction(baked.root, { kind: "run", approve: true });
		expect(holder.ok).toBe(true);
		const second = await postAction(baked.base, baked.cookie, { kind: "plan" }, actionHeaders(baked.csrf));
		expect(second.status).toBe(409);
		const body = (await second.json()) as { error: string; jobId?: string };
		expect(body.error).toMatch(/one mutating job/);
		// stop the holder (SIGINT → 130, recorded)
		const stop = await postAction(baked.base, baked.cookie, { kind: "stop" }, actionHeaders(baked.csrf));
		expect(stop.status).toBe(202);
		if (holder.ok) {
			const holderJob = (await waitFor(() => readJobRecord(baked.root, holder.job.id), (j) => j !== undefined && (j.status === "exited" || j.status === "failed"), 8_000))!;
			expect(holderJob.status).toBe("exited");
			expect(holderJob.exitCode).toBe(130);
		}
	});

	it("handoff is allowed during a run (side-car write, no lock needed)", async () => {
		const run = await startAction(baked.root, { kind: "run", approve: true });
		expect(run.ok).toBe(true);
		try {
			const accept = await postAction(baked.base, baked.cookie, { kind: "handoff", note: "watch the gate" }, actionHeaders(baked.csrf));
			expect(accept.status).toBe(202);
			const handoffJob = (await waitFor(async () => (await jobsList(baked.root)).find((j) => j.kind === "handoff")!, (j) => j.status !== "running", 8_000))!;
			expect(handoffJob.status).toBe("exited");
			expect(handoffJob.argv[handoffJob.argv.length - 1]).toBe("watch the gate");
			// the note rode the argv (the real CLI writes .orch/pending-handoff.json — see demo e2e)
			const tail = await tailJobLog(handoffJob.logPath, 20);
			expect(tail.join("\n")).toContain("handoff note queued for the next wave: watch the gate");
		} finally {
			if (run.ok) await stopAction(baked.root); // SIGINT the run job
		}
	});

	it("stop with no UI job but a foreign lock holder → 409 with the terminal hint", async () => {
		// fake a live attached run: a real sleeper pid owning .orch/lock (+ a status flush)
		const sleeper = spawnSleeper(6);
		try {
			await writeFile(join(baked.root, ".orch", "lock"), `${sleeper.pid}\n${new Date().toISOString()}\n`, "utf8");
			await writeFile(
				join(baked.root, ".orch", "status.json"),
				JSON.stringify({ lockedByPid: sleeper.pid, phase: "wave-running", ts: Date.now() }),
				"utf8",
			);
			const stop = await postAction(baked.base, baked.cookie, { kind: "stop" }, actionHeaders(baked.csrf));
			expect(stop.status).toBe(409);
			const body = (await stop.json()) as { error: string };
			expect(body.error).toMatch(/from its terminal/);
		} finally {
			sleeper.child.kill("SIGKILL");
		}
	});

	it("stop with nothing running at all → 409 plain", async () => {
		const stop = await postAction(baked.base, baked.cookie, { kind: "stop" }, actionHeaders(baked.csrf));
		expect(stop.status).toBe(409);
		expect(((await stop.json()) as { error: string }).error).toMatch(/nothing is running/);
	});

	it("/api/jobs synthesizes the attached entry from a live status.json pid", async () => {
		const sleeper = spawnSleeper(6);
		try {
			await writeFile(
				join(baked.root, ".orch", "status.json"),
				JSON.stringify({ lockedByPid: sleeper.pid, phase: "wave-running", task: { id: "t1", wave: 2, status: "running" }, ts: Date.now() }),
				"utf8",
			);
			const payload = await waitFor(async () => {
				const res = await fetch(`${baked.base}/api/jobs`, { headers: { cookie: baked.cookie } });
				return (await res.json()) as { attached?: { pid: number; phase: string }; jobs: unknown[] };
			}, (p) => p.attached !== undefined, 4_000);
			expect(payload.attached?.pid).toBe(sleeper.pid);
			expect(payload.attached?.phase).toBe("wave-running");
		} finally {
			sleeper.child.kill("SIGKILL");
		}
	});

	it("a dead-pid running record goes stale on the next server start (the same root, second server)", async () => {
		const first = await bake({ skipJobSweep: false });
		// leave a bogus "running" record with an impossible pid
		const ghostJob = join(first.root, ".orch", "ui", "jobs");
		await mkdir(ghostJob, { recursive: true });
		await writeFile(
			join(ghostJob, "ghost-1.json"),
			JSON.stringify({ id: "ghost-1", kind: "plan", argv: ["x"], cwd: first.root, pid: 2_999_999_999, startedAt: Date.now(), status: "running", logPath: join(ghostJob, "ghost-1.log") }),
			"utf8",
		);
		const marked = await markStaleRecords(first.root);
		expect(marked).toBe(1);
		const record = await readJobRecord(first.root, "ghost-1");
		expect(record?.status).toBe("stale");
		await first.running.shutdown().catch(() => {});
		await rm(first.root, { recursive: true, force: true }).catch(() => {});
	});

	it("prune keeps the newest max and drops old records with their logs", async () => {
		const now = Date.now();
		const ageMs = 14 * 24 * 60 * 60_000;
		const jobDir = join(baked.root, ".orch", "ui", "jobs");
		await mkdir(jobDir, { recursive: true });
		const seeds: Array<[string, number]> = [
			["old-1", now - ageMs - 1],
			["mid-1", now - 3 * 3600_000],
			["new-1", now - 100],
		];
		for (const [id, startedAt] of seeds) {
			const argv = [baked.stubCli, "plan"];
			const argvJson = JSON.stringify(argv);
			await writeFile(
				join(jobDir, `${id}.json`),
				`{"id":${JSON.stringify(id)},"kind":"plan","argv":${argvJson},"cwd":${JSON.stringify(baked.root)},"pid":null,"startedAt":${startedAt},"status":"exited","logPath":${JSON.stringify(join(jobDir, id + ".log"))}}`,
				"utf8",
			);
			await writeFile(join(jobDir, `${id}.log`), `${id} log\n`, "utf8");
		}
		const dropped = await pruneJobs(baked.root, 2, ageMs);
		expect(dropped).toBe(1);
		expect(existsSync(join(jobDir, "old-1.json"))).toBe(false);
		expect(existsSync(join(jobDir, "old-1.log"))).toBe(false);
		expect(existsSync(join(jobDir, "mid-1.json"))).toBe(true);
		expect(existsSync(join(jobDir, "new-1.json"))).toBe(true);
	});
});

describe("lock-busy 409 over HTTP", () => {
	it("mutating job refused while a live holder owns .orch/lock", async () => {
		const baked = await bake({ skipJobSweep: true });
		try {
			const sleeper = spawnSleeper(6);
			try {
				await writeFile(
					join(baked.root, ".orch", "lock"),
					`${sleeper.pid}\n${new Date().toISOString()}\n`,
					"utf8",
				);
				const plan = await postAction(baked.base, baked.cookie, { kind: "plan" }, actionHeaders(baked.csrf));
				expect(plan.status).toBe(409);
				const body = (await plan.json()) as { error: string; holderPid?: number; phase?: string };
				expect(body.holderPid).toBe(sleeper.pid);
				expect(body.error).toMatch(/held by pid/);
			} finally {
				sleeper.child.kill("SIGKILL");
			}
		} finally {
			await baked.running.shutdown().catch(() => {});
			await rm(baked.root, { recursive: true, force: true }).catch(() => {});
		}
	});
});

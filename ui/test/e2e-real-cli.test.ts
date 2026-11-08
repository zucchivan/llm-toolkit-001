/**
 * END-TO-END through the UI server with the REAL kit CLI (faux provider,
 * `npm --prefix ui run test:e2e` sets KIT_FAUX=1):
 *   plan job → readout flips planned → approve & run job → demo waves finish.
 * Mirrors demo acceptance cuts 1–4 (PRD §15.2) at vitest scale: the completed
 * tasks' diff drawer (files/hunks, engine exclusions, cumulative wave label)
 * plus the live in-flight diff inside a gate-stall window.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { startServer, type RunningUiServer } from "../server/server.ts";
import { newToken } from "../server/auth.ts";
import { readOnce } from "../server/readout.ts";
import { jobsList, type JobRecord } from "../server/jobs.ts";
import { resolveCli } from "../server/actions.ts";
import { postAction, actionHeaders, waitFor, spawnSleeper } from "./actions-helper.ts";
import { bakeConfiguredDemo } from "./helpers.ts";

const FAUX = process.env["KIT_FAUX"] === "1";

/**
 * A passing gate that stalls 3s while the tree is un-broken — the implementer
 * wave writes src/list.ts first, so the stall gives the live-diff endpoint a
 * tree WITH content while the wave is still in flight.
 */
const SLOW_GATE = `const fs = require("node:fs");
if (fs.existsSync("src/list.ts") && !fs.readFileSync("src/list.ts", "utf8").includes("BROKEN")) {
	const until = Date.now() + 3000;
	while (Date.now() < until) {}
}
`;

describe.skipIf(!FAUX)("real CLI e2e (KIT_FAUX=1)", () => {
	let root: string;
	let running: RunningUiServer;
	let cookie: string;
	let csrf: string;
	let base: string;

	afterAll(async () => {
		await running?.shutdown().catch(() => {});
		await rm(root, { recursive: true, force: true }).catch(() => {});
	});

	it("plan job → planned readout → run job completes the demo waves (+ per-task diffs)", { timeout: 300_000 }, async () => {
		// project: demo PRD + recipes with the plan-fails-then-fixes gate + one baseline commit
		root = await bakeConfiguredDemo();
		await writeFile(join(root, "evals", "recipes.toml"), '[broken-gate]\ncmd = "node smoke-gate.cjs"\n', "utf8");

		const token = newToken();
		const dist = await mkdtemp(join(tmpdir(), "ui-e2e-dist-"));
		await writeFile(join(dist, "index.html"), "<!doctype html><title>ok</title>", "utf8");
		running = await startServer({ root, token, port: 0, distDir: dist });
		cookie = `kit_ui=${token}; kit_ui_csrf=${token}`;
		csrf = token;
		base = `http://127.0.0.1:${running.port}`;
		const headers = actionHeaders(csrf, base);

		// --- plan through the UI (real CLI, faux planner)
		const plan = await postAction(base, cookie, { kind: "plan", prd: "docs/prd.md" }, headers);
		expect(plan.status).toBe(202);
		const { jobId } = (await plan.json()) as { jobId: string };
		const planJob = (await waitFor(() => recordOf(root, jobId), (j) => j !== undefined && j.status !== "running", 60_000))! as JobRecord;
		expect(planJob.status).toBe("exited");
		expect(planJob.exitCode).toBe(0);
		expect(planJob.pid).toBeDefined(); // the record carries the CLI pid

		// readout flips to planned; review data (full router) is in storage mode
		const planned = (await waitFor(() => readOnce(root), (s) => s.readout.phase === "planned", 10_000))!;
		expect(planned.mode).toBe("storage");
		expect(planned.readout.tasks.map((t) => t.id).sort()).toEqual(["cli-render", "list-parse", "list-query"]);
		expect(planned.readout.storage?.router.tasks.length).toBe(3);

		// --- approve & run through the UI (real CLI, faux implementer/verifier)
		const run = await postAction(base, cookie, { kind: "run", approve: true }, headers);
		expect(run.status).toBe(202);
		const { jobId: runId } = (await run.json()) as { jobId: string };

		const runJob = (await waitFor(() => recordOf(root, runId), (j) => j !== undefined && j.status !== "running", 180_000))! as JobRecord;
		expect(runJob.status).toBe("exited");
		expect([0, 42]).toContain(runJob.exitCode ?? -1); // 42 disappears only with a mid-run sleep

		// completed paper trail: everything terminal, real timeline rows
		const final = (await waitFor(() => readOnce(root), (s) => s.readout.tasks.every((t) => t.status === "done" || t.status === "quarantined"), 60_000))!;
		expect(final.readout.tasks.map((t) => t.status).sort()).toEqual(["done", "done", "done"]);
		const waveSpans = final.readout.timeline.map((s) => `${s.task}#w${s.wave}`);
		expect(waveSpans).toContain("list-parse#w1");
		expect(waveSpans).toContain("list-query#w2"); // the deliberate gate-fail wave then the fix
		expect(final.readout.usage.sessionUsd).toBeGreaterThanOrEqual(0);

		// --- M2 cut 4: every done task has a diff ref + served patch data ---
		for (const task of final.readout.tasks) {
			expect(task.status).toBe("done");
			expect(task.diff?.patch).toBe(`task-${task.id}.patch`);
			expect(task.diff?.stats).toBe(`task-${task.id}.json`);
			expect(task.diff!.bytes).toBeGreaterThan(0);
			expect(task.diff!.truncated).toBe(false);
			// stats side-car shape: task, wave, baseline, totals; the wave reflects
			// the Cumulative semantics (the terminal wave of each task).
			const statsRaw = await readFile(join(root, ".orch", "artifacts", task.diff!.stats!), "utf8");
			const stats = JSON.parse(statsRaw) as { task: string; wave: number; baselineTreeSha: string; totalInsertions: number; totalDeletions: number; truncated: boolean; files: { path: string; status: string }[] };
			expect(stats.task).toBe(task.id);
			expect(stats.wave).toBeGreaterThan(0);
			expect(stats.baselineTreeSha).toMatch(/^[0-9a-f]{40}$/);
			expect(stats.truncated).toBe(false);
			expect(stats.files.length).toBeGreaterThan(0);
		}
		// readout artifact kinds classify them as "diff"
		expect(final.readout.artifacts.filter((a) => a.kind === "diff").length).toBeGreaterThanOrEqual(6); // 3 patches + 3 stats

		// Drawer data: list-parse's patch carries its file hunks; list-query's
		// cumulative patch (wave1 broke, wave2 fixed) shows query.ts and NO engine
		// paths, and the fixed state (no BROKEN token in the final diff).
		const drawerOf = async (task: string): Promise<{ diff: string; statsJson?: { wave: number } }> => {
			const res = await fetch(`${base}/api/tasks/${task}/diff`, { headers: { cookie } });
			expect(res.status).toBe(200);
			return (await res.json()) as { diff: string; statsJson?: { wave: number } };
		};
		const parseDrawer = await drawerOf("list-parse");
		expect(parseDrawer.diff).toContain("src/list.ts");
		expect(parseDrawer.diff).toContain("+export function parseList");
		expect(parseDrawer.diff).not.toContain("router.md");
		expect(parseDrawer.diff).not.toContain("PROMPT.md");
		expect(parseDrawer.diff).not.toMatch(/diff --git a\/\.orch/u);
		const queryDrawer = await drawerOf("list-query");
		expect(queryDrawer.diff).toContain("src/query.ts");
		expect(queryDrawer.diff).not.toContain("BROKEN"); // final state — cumulative patch shows the correction landed
		expect(queryDrawer.statsJson?.wave).toBe(2);

		// diff artifacts exist per task on disk, byte-sized > 0
		for (const id of ["list-parse", "list-query", "cli-render"]) {
			expect((await stat(join(root, ".orch", "artifacts", `task-${id}.patch`))).size).toBeGreaterThan(0);
		}

		// lock is free again: idempotence — our jobs list keeps BOTH records
		const jobs = await jobsList(root);
		expect(jobs.map((j) => j.kind).sort()).toEqual(["plan", "run"]);
	});

	it("live diff: exclusions + content mid-wave; 409 for tasks not in flight", { timeout: 300_000 }, async () => {
		// own project + a slow gate recipe: the sleep runs INSIDE list-parse's wave
		// (after src/list.ts is written) so the live-diff window has real content.
		root = await bakeConfiguredDemo();
		await mkdir(join(root, "evals"), { recursive: true });
		await writeFile(join(root, "slow-gate.cjs"), SLOW_GATE, "utf8");
		await writeFile(join(root, "evals", "recipes.toml"), '[broken-gate]\ncmd = "node smoke-gate.cjs"\n[slow-gate]\ncmd = "node slow-gate.cjs"\n', "utf8");

		const token = newToken();
		const dist = await mkdtemp(join(tmpdir(), "ui-e2e-live-dist-"));
		await writeFile(join(dist, "index.html"), "<!doctype html><title>ok</title>", "utf8");
		running = await startServer({ root, token, port: 0, distDir: dist });
		base = `http://127.0.0.1:${running.port}`;
		cookie = `kit_ui=${token}; kit_ui_csrf=${token}`;
		csrf = token;
		const headers = actionHeaders(csrf, base);

		const plan = await postAction(base, cookie, { kind: "plan", prd: "docs/prd.md" }, headers);
		expect(plan.status).toBe(202);
		const { jobId } = (await plan.json()) as { jobId: string };
		await waitFor(() => recordOf(root, jobId), (j) => j !== undefined && j.status !== "running", 60_000);

		const run = await postAction(base, cookie, { kind: "run", approve: true }, headers);
		expect(run.status).toBe(202);

		try {
		// Wait INSIDE list-parse's wave (the 3s slow-gate window): a 200 with real
		// content. Early fetches legitimately 409 (no wave running yet).
		await waitFor(
			async () => {
				const res = await fetch(`${base}/api/tasks/list-parse/diff/live`, { headers: { cookie } });
				if (res.status !== 200) return undefined;
				const body = (await res.json()) as { diff: string };
				return body.diff.includes("parseList") ? body : undefined;
			},
			(body) => body !== undefined && body.diff.includes("+export function parseList"),
			120_000,
		);
		} catch (err) {
			const { readdir } = await import("node:fs/promises");
			const jobsDir = join(root, ".orch", "ui", "jobs");
			const jobNames = await readdir(jobsDir).catch(() => []);
			console.error("DBG-JOBS", jobNames.join(","));
			for (const name of jobNames.filter((nm) => nm.endsWith(".json"))) {
				console.error("JOB-REC", await readFile(join(jobsDir, name), "utf8").catch(() => "?"));
			}
			for (const name of jobNames.filter((nm) => nm.endsWith(".log"))) {
				console.error("JOB-LOG-TAIL", (await readFile(join(jobsDir, name), "utf8").catch(() => "?")).slice(-900));
			}
			console.error("STATUS-JSON", await readFile(join(root, ".orch", "status.json"), "utf8").catch(() => "none"));
			const dbg = await readOnce(root);
			console.error("DBG-ROW", JSON.stringify(dbg.readout.timeline));
			const wl = await readFile(join(root, ".orch", "wave-log.jsonl"), "utf8").catch(() => "none");
			console.error("DBG-LOG", wl.slice(-1500));
			const rec = await readFile(join(root, ".orch", "ui", "jobs"), "utf8").catch(() => ({}));
			console.error("DBG-JOBS", JSON.stringify(rec).slice(0, 600));
			throw err;
		}
		const inflight = await fetch(`${base}/api/tasks/list-parse/diff/live`, { headers: { cookie } });
		expect(inflight.status).toBe(200);
		const midWave = (await inflight.json()) as { task: string; wave: number; diff: string; truncated: boolean; stats: { files: unknown[] } };
		expect(midWave.task).toBe("list-parse");
		expect(midWave.diff).toContain("src/list.ts");
		expect(midWave.diff).toContain("+export function parseList");
		// engine-owned paths never leak into the live preview
		expect(midWave.diff).not.toContain("router.md");
		expect(midWave.diff).not.toContain("PROMPT.md");
		expect(midWave.diff).not.toMatch(/diff --git a\/\.orch/u);

		// nothing got persisted by the live compute
		const persisted = await readFile(join(root, ".orch", "artifacts", "task-list-parse.patch"), "utf8").catch(() => "<absent>");
		expect(persisted).toBe("<absent>");

		// a task that is NOT in flight → 409 with the current holder named
		const other = await fetch(`${base}/api/tasks/cli-render/diff/live`, { headers: { cookie } });
		expect(other.status).toBe(409);
		expect((await other.json()) as { currentTask?: string }).toMatchObject({ currentTask: "list-parse" });

		// the wave resolves and the final readout keeps the persisted refs
		const final = await waitFor(() => readOnce(root), (s) => s.readout.tasks.every((t) => t.status === "done" || t.status === "quarantined"), 240_000);
		expect(final.readout.tasks.filter((t) => t.diff).length).toBeGreaterThanOrEqual(3);
		expect((await stat(join(root, ".orch", "artifacts", "task-list-parse.patch"))).size).toBeGreaterThan(0);
	});

	it("attached stop refused: an unverifiable holder is answered with the reason and signal NOTHING (§7.2.1)", async () => {
		// fake a foreign live run: a real sleeper pid owning .orch/lock from the
		// PROJECT cwd (so the check reaches the command line) — its cmd is not
		// this project's installed CLI entry, so the identity check fails
		// BEFORE anything is signalled.
		const foreign = spawn(process.execPath, ["-e", "const t = Date.now() + 30000; while (Date.now() < t) {}"], { cwd: root, stdio: "ignore" });
		const holder = { child: foreign, pid: foreign.pid! };
		try {
			await writeFile(join(root, ".orch", "lock"), `${holder.pid}\n${new Date().toISOString()}\n`, "utf8");
			await writeFile(join(root, ".orch", "status.json"), JSON.stringify({ lockedByPid: holder.pid, phase: "wave-running", ts: Date.now() }), "utf8");

			// the plain default stop keeps the UI-job contract (terminal hint)
			const plain = await postAction(base, cookie, { kind: "stop" }, actionHeaders(csrf, base));
			expect(plain.status).toBe(409);
			expect(((await plain.json()) as { error: string }).error).toMatch(/from its terminal/);

			// the attached target: verification fails on identity — 409, no signal
			const attached = await postAction(base, cookie, { kind: "stop", target: "attached", pid: holder.pid }, actionHeaders(csrf, base));
			expect(attached.status).toBe(409);
			const body = (await attached.json()) as { error: string };
			expect(body.error).toMatch(/command line/);
			expect(body.error).toMatch(/installed CLI entry/);

			const payload = (await (await fetch(`${base}/api/jobs`, { headers: { cookie } })).json()) as { attached?: { pid: number; stop?: { ok: boolean; reason?: string } } };
			expect(payload.attached?.pid).toBe(holder.pid);
			expect(payload.attached?.stop?.ok).toBe(false);
			expect(payload.attached?.stop?.reason).toMatch(/command line/);

			// the holder got NO signal: it is still alive when the test looks again
			await new Promise((r) => setTimeout(r, 300));
			process.kill(holder.pid, 0); // throws ESRCH only if it is gone
		} finally {
			holder.child.kill("SIGKILL");
		}
	});

	it("attached stop verified: the UI SIGINTs the TERMINAL-spawned faux runner once — exit 130, resumable", { timeout: 300_000 }, async () => {
		// a project with a slow gate: wave 1 of list-parse stalls 3s INSIDE the
		// gate — the stop window. Plan through the UI first (approve stamp), then
		// spawn the runner like a terminal would: the SAME entry resolveCli()
		// picks for spawning jobs, cwd = the project root, detached from jobs.
		root = await bakeConfiguredDemo();
		await mkdir(join(root, "evals"), { recursive: true });
		await writeFile(join(root, "slow-gate.cjs"), SLOW_GATE, "utf8");
		await writeFile(join(root, "evals", "recipes.toml"), '[broken-gate]\ncmd = "node smoke-gate.cjs"\n[slow-gate]\ncmd = "node slow-gate.cjs"\n', "utf8");

		const token = newToken();
		const dist = await mkdtemp(join(tmpdir(), "ui-e2e-stop-dist-"));
		await writeFile(join(dist, "index.html"), "<!doctype html><title>ok</title>", "utf8");
		running = await startServer({ root, token, port: 0, distDir: dist });
		base = `http://127.0.0.1:${running.port}`;
		cookie = `kit_ui=${token}; kit_ui_csrf=${token}`;
		csrf = token;
		const headers = actionHeaders(csrf, base);

		const plan = await postAction(base, cookie, { kind: "plan", prd: "docs/prd.md" }, headers);
		expect(plan.status).toBe(202);
		const { jobId } = (await plan.json()) as { jobId: string };
		await waitFor(() => recordOf(root, jobId), (j) => j !== undefined && j.status !== "running", 60_000);

		// terminal-spawned run (NOT a UI job record): same argv shape the human
		// types, cwd on the project, the UI server's job layer left out entirely.
		const child = spawn(resolveCli(root).argv[0]!, [...resolveCli(root).argv.slice(1), "run", "--approve"], {
			cwd: root,
			stdio: "ignore",
			env: { ...process.env }, // KIT_FAUX=1 + KIT_FAUX_SCRIPT ride the test env
		});
		try {
			// attach: the CLI owns the lock and flushes wave-running promptly
			await waitFor(
				async () => {
					try {
						const payload = JSON.parse(await readFile(join(root, ".orch", "status.json"), "utf8")) as { lockedByPid?: number; phase?: string; task?: { id?: string } };
						return payload.lockedByPid === child.pid && payload.phase === "wave-running" && payload.task?.id === "list-parse";
					} catch {
						return false;
					}
				},
				(ok) => ok,
				120_000,
			);

			// the affordance flips to verified on the jobs payload
			const payload = (await waitFor(async () => {
				const jobs = (await (await fetch(`${base}/api/jobs`, { headers: { cookie } })).json()) as { attached?: { pid: number; stop?: { ok: boolean; command?: string } } };
				const attached = jobs.attached;
				if (!attached || attached.pid !== child.pid) return undefined;
				return attached.stop?.ok ? jobs : undefined;
			}, (p) => p !== undefined, 15_000))! as { attached: { pid: number; stop?: { ok: boolean; command?: string } } };
			expect(payload.attached.stop?.command).toContain("run");

			// the confirm dialog's POST — exactly one re-verified SIGINT
			const stop = await postAction(base, cookie, { kind: "stop", target: "attached", pid: child.pid! }, actionHeaders(csrf, base));
			expect(stop.status).toBe(202);
			expect((await stop.json()) as { kind: string; target: string; pid: number }).toMatchObject({ kind: "stop", target: "attached", pid: child.pid });

			const code = await new Promise<number>((done) => {
				const timer = setTimeout(() => done(-1), 60_000);
				child.once("exit", (c) => {
					clearTimeout(timer);
					done(c ?? -1);
				});
			});
			expect(code).toBe(130); // interrupted — durable state stays resumable

			// and the sheet stays honest afterwards: the attachment is gone once the
			// stale flush is superseded (the record-less run left no job record)
			await waitFor(async () => {
				const jobs = (await (await fetch(`${base}/api/jobs`, { headers: { cookie } })).json()) as { attached?: { pid: number } };
				return jobs.attached === undefined;
			}, (gone) => gone, 15_000);
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
	});
});


async function recordOf(projectRoot: string, id: string): Promise<JobRecord | undefined> {
	return (await jobsList(projectRoot)).find((j) => j.id === id);
}

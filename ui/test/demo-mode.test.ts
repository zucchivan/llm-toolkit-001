/**
 * Demo mode (ui/PRD.md §15.2, ui 0.10.0): the official simulated backend.
 * bakeDemoProject must produce a complete, serveable loop project — faux
 * roles, §5 scaffold, the fixture's ONE recipe file (three behavioral gates,
 * M0-P08) with the reviewed gate bytes copied to evals/, one git base commit
 * — and a real server started on it must answer the readout route like any
 * project.
 */
import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../../src/util/exec.ts";
import { loadConfig } from "../../src/config.ts";
import { installTrustedInstallationForTests, runningInstallationFrom, selectInstallation } from "../../src/sandbox/trusted-exec.ts";
import { bakeDemoProject } from "../server/demo.ts";
import { startServer } from "../server/server.ts";
import { readJobRecord } from "../server/jobs.ts";
import { postAction, trustedNodeFixture, waitFor } from "./actions-helper.ts";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

describe("bakeDemoProject", () => {
	it("produces a complete faux-role project with a git base commit", async () => {
		const { root, replay } = await bakeDemoProject(REPO_ROOT);

		const config = await loadConfig(root);
		for (const role of ["planner", "implementer", "verifier"] as const) {
			expect(config.roles[role].provider).toBe("faux");
			expect(config.roles[role].modelId).toMatch(/^kit-/);
		}

		// the fixture + §5 scaffold on disk
		const { readFile } = await import("node:fs/promises");
		const prd = await readFile(join(root, "docs", "prd.md"), "utf8");
		expect(prd.length).toBeGreaterThan(0);
		// M0-P08: the fixture's ONE recipe file carries the three behavioral
		// gates in literal argv form, and evals/ holds the executed copy of the
		// reviewed gate bytes (byte-identical — no duplicate implementation).
		const recipes = await readFile(join(root, "evals", "recipes.toml"), "utf8");
		expect(recipes).toContain("[gate-list]");
		expect(recipes).toContain('["node", "evals/smoke-gate.cjs", "list"]');
		expect(recipes).toContain('match = [\'^a b\\n$\']');
		const gateCopy = await readFile(join(root, "evals", "smoke-gate.cjs"), "utf8");
		const reviewed = await readFile(join(REPO_ROOT, "examples", "demo-prd", "smoke-gate.cjs"), "utf8");
		expect(gateCopy).toBe(reviewed);
		const prompt = await readFile(join(root, "PROMPT.md"), "utf8");
		expect(prompt.length).toBeGreaterThan(0);
		const head = await exec(["git", "rev-parse", "--verify", "HEAD"], { cwd: root, timeoutMs: 15_000 });
		expect(head.code).toBe(0);
		expect(replay.endsWith("smoke.replay")).toBe(true);
	});

	it("bakes through the host-owned installation and refuses an invalid selected Git", async () => {
		installTrustedInstallationForTests(selectInstallation({
			platform: "linux",
			running: runningInstallationFrom("file:///srv/kit/src/sandbox/trusted-exec.ts", "linux"),
			execPath: process.execPath,
			installation: { git: "/nonexistent/kit-ui-demo-git" },
		}));
		try {
			await expect(bakeDemoProject(REPO_ROOT)).rejects.toThrow(/trusted installation refused/);
		} finally {
			installTrustedInstallationForTests(undefined);
		}

		// With the host default selected, the bake commits the same filter-free
		// plumbing tree (config + reviewed gate bytes present).
		const { root } = await bakeDemoProject(REPO_ROOT);
		const tree = await exec(["git", "ls-tree", "-r", "--name-only", "HEAD"], { cwd: root, timeoutMs: 15_000 });
		expect(tree.code).toBe(0);
		expect(tree.stdout).toContain(".orch/config.toml");
		expect(tree.stdout).toContain("evals/smoke-gate.cjs");
	});

	it("a real server on the baked project serves the readout (seam 1)", async () => {
		const { root } = await bakeDemoProject(REPO_ROOT);
		const dist = await mkdtemp(join(tmpdir(), "ui-demo-dist-"));
		await mkdir(join(dist, "assets"), { recursive: true });
		await writeFile(join(dist, "index.html"), "<!doctype html><title>ok</title>", "utf8");
		const running = await startServer({ root, token: "demotoken", port: 0, distDir: dist });
		try {
			// running.url carries the ?token= exchange query — api assertions use a
			// bare-origin base like the other server tests.
			const base = `http://127.0.0.1:${running.port}`;
			const denied = await fetch(`${base}/api/readout`);
			expect(denied.status).toBe(401);
			const ok = await fetch(`${base}/api/readout`, { headers: { cookie: "kit_ui=demotoken" } });
			expect(ok.status).toBe(200);
			const snap = (await ok.json()) as { readout: { seam: number; identity: { root: string } }; mode: string };
			expect(snap.readout.seam).toBe(1);
			expect(snap.readout.identity.root).toBe(root);
		} finally {
			await running.shutdown();
		}
	});

	it("the demo project runs a job through the injected descriptor identity (step (f), no real CLI needed)", async () => {
		const { root } = await bakeDemoProject(REPO_ROOT);
		const stubDir = await mkdtemp(join(tmpdir(), "ui-demo-stub-"));
		const stub = join(stubDir, "stub-cli.mjs");
		await writeFile(stub, await readFile(join(import.meta.dirname, "stub-cli.mjs"), "utf8"), "utf8");
		await chmod(stub, 0o755);
		const node = await trustedNodeFixture();
		const installation = selectInstallation({
			execPath: node,
			installation: { cli: stub, node },
		});
		installTrustedInstallationForTests(installation);
		const dist = await mkdtemp(join(tmpdir(), "ui-demo-dist-"));
		await mkdir(join(dist, "assets"), { recursive: true });
		await writeFile(join(dist, "index.html"), "<!doctype html><title>ok</title>", "utf8");
		const token = "demotoken";
		const running = await startServer({ root, token, port: 0, distDir: dist, installation, skipJobSweep: true });
		try {
			const base = `http://127.0.0.1:${running.port}`;
			const res = await postAction(base, `kit_ui=${token}; kit_ui_csrf=${token}`, { kind: "plan" }, { "x-kit-token": token });
			expect(res.status).toBe(202);
			const { jobId, via } = (await res.json()) as { jobId: string; via: string };
			expect(via).toMatch(/trusted installation/);
			const job = (await waitFor(() => readJobRecord(root, jobId), (j) => j !== undefined && j.status !== "running", 8_000))!;
			expect(job).toMatchObject({ status: "exited", exitCode: 0 });
			expect(job.argv).toEqual([node, stub, "plan"]);
			expect(job.identity).toMatchObject({ version: 1, form: "built", entry: stub });
			const log = await readFile(job.logPath, "utf8");
			expect(log).toContain("PLANNED — 3 task(s)");
		} finally {
			await running.shutdown();
			installTrustedInstallationForTests(undefined);
			await rm(stubDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});

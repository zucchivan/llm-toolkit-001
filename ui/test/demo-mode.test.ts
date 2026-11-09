/**
 * Demo mode (ui/PRD.md §15.2, ui 0.10.0): the official simulated backend.
 * bakeDemoProject must produce a complete, serveable loop project — faux
 * roles, §5 scaffold, broken-gate recipe, one git base commit — and a real
 * server started on it must answer the readout route like any project.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../../src/util/exec.ts";
import { loadConfig } from "../../src/config.ts";
import { bakeDemoProject } from "../server/demo.ts";
import { startServer } from "../server/server.ts";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

describe("bakeDemoProject", () => {
	it("produces a complete faux-role project with a git base commit", async () => {
		const { root, replay } = await bakeDemoProject(REPO_ROOT);

		const config = loadConfig(root);
		for (const role of ["planner", "implementer", "verifier"] as const) {
			expect(config.roles[role].provider).toBe("faux");
			expect(config.roles[role].modelId).toMatch(/^kit-/);
		}

		// the fixture + §5 scaffold on disk
		const { readFile } = await import("node:fs/promises");
		const prd = await readFile(join(root, "docs", "prd.md"), "utf8");
		expect(prd.length).toBeGreaterThan(0);
		const recipes = await readFile(join(root, "evals", "recipes.toml"), "utf8");
		expect(recipes).toContain("[broken-gate]");
		expect(recipes).toContain("node smoke-gate.cjs");
		const prompt = await readFile(join(root, "PROMPT.md"), "utf8");
		expect(prompt.length).toBeGreaterThan(0);
		const head = await exec(["git", "rev-parse", "--verify", "HEAD"], { cwd: root, timeoutMs: 15_000 });
		expect(head.code).toBe(0);
		expect(replay.endsWith("smoke.replay")).toBe(true);
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
});

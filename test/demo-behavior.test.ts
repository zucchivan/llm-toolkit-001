/**
 * M0-P08 — the demo is falsifiable at runtime (§0: "The demo is the first
 * outcome test"). The shipped fixture's three behavioral gates execute the
 * product's modules and CLI — they never grep file contents:
 *
 *   - a case-sensitive queryList fails gate-query; a missing renderList
 *     export fails gate-list AND the independent `node bin/render.js /a/-b`
 *     invocation inside gate-cli;
 *   - the full shipped smoke.replay completes through the REAL CLI, the
 *     wave-1 defect is proven by an executed gate failure (wave 2 repairs it
 *     from the gate feedback), and the completed program satisfies the §0
 *     invocation: exit 0, stdout exactly `a b\n`;
 *   - a task's pending future checks must not fail merely because their task
 *     has not run yet (wave 1 touches only src/, so gate-query/gate-cli skip
 *     via `on`);
 *   - init --with-demo stays a placeholder PRD (not a baked project) and the
 *     generic scaffolds install no active demo gates — only the explicit
 *     demo setup (installDemoGates) does.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/util/exec.ts";
import { initProject } from "../src/init.ts";
import {
	prepareDemoProject,
	writeConfig,
	demoConfigToml,
	gitInit,
	installDemoGates,
	DEMO_ROOT_FIXTURE,
} from "./demo-project.ts";
import { runCli } from "./plan-revision-helpers.ts";

beforeEach(() => {
	process.env["NO_COLOR"] = "1";
});

// Product sources mirroring the shipped replay (single behavior, one truth).
// Correct parser, NO renderer export: isolates the §0 missing-export defect.
const PARSE_ONLY_LIST_TS = `export function parseList(input: string): string[] {
	return input.split("/").flatMap((p) => p.split(",")).map((s) => s.trim()).filter((s) => s.length > 0).map((s) => s.startsWith("-") ? s.slice(1) : s);
}
`;
// The §0-named old defect: the parser DROPS '-b' instead of stripping its dash.
const DROP_DASH_LIST_TS = `export function parseList(input: string): string[] {
	return input.split("/").flatMap((p) => p.split(",")).map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith("-"));
}
export function renderList(items: string[]): string {
	return items.join(" ");
}
`;
const LIST_TS = `export function parseList(input: string): string[] {
	return input.split("/").flatMap((p) => p.split(",")).map((s) => s.trim()).filter((s) => s.length > 0).map((s) => s.startsWith("-") ? s.slice(1) : s);
}
export function renderList(items: string[]): string {
	return items.join(" ");
}
`;
const CASE_SENSITIVE_QUERY_TS = `export function queryList(items: string[], q: string): string[] {
	return items.filter((item) => item.includes(q));
}
`;
const QUERY_TS = `export function queryList(items: string[], q: string): string[] {
	const needle = q.toLowerCase();
	return items.filter((item) => item.toLowerCase().includes(needle));
}
`;
const BIN_JS = `#!/usr/bin/env node
import { parseList, renderList } from '../src/list.ts';
console.log(renderList(parseList(process.argv[2] ?? '-x')));
`;

/** A fresh demo project with the fixture's recipe file + reviewed gate bytes. */
async function bakeDemo(): Promise<string> {
	const project = await prepareDemoProject();
	await installDemoGates(project.root);
	return project.root;
}

/** Run one smoke-gate subcommand against the project's product files. */
const runGate = async (root: string, sub: string) =>
	await exec(["node", "evals/smoke-gate.cjs", sub], { cwd: root, timeoutMs: 30_000 });

describe("the shipped demo gates are behavioral and falsifiable", () => {
	it("a case-sensitive queryList fails gate-query; a missing renderList export fails gate-list and gate-cli", async () => {
		const root = await bakeDemo();
		await mkdir(join(root, "bin"), { recursive: true });
		// The seeded defects, exactly as the replay's waves 1 ship them.
		await writeFile(join(root, "src", "list.ts"), PARSE_ONLY_LIST_TS, "utf8");
		await writeFile(join(root, "src", "query.ts"), CASE_SENSITIVE_QUERY_TS, "utf8");

		const query = await runGate(root, "query");
		expect(query.code).not.toBe(0);
		expect(query.stderr).toContain("must match case-insensitively");

		const list = await runGate(root, "list");
		expect(list.code).not.toBe(0);
		expect(list.stderr).toContain("renderList");

		// gate-cli: the second independent child invocation — the missing
		// renderList export makes `node bin/render.js /a/-b` exit nonzero.
		const cli = await runGate(root, "cli");
		expect(cli.code).not.toBe(0);
		expect(cli.stderr).toContain("bin/render.js");
	});

	it("the repaired program passes all three gates; gate-cli forwards the exact `a b` stdout", async () => {
		const root = await bakeDemo();
		await mkdir(join(root, "bin"), { recursive: true });
		await writeFile(join(root, "src", "list.ts"), LIST_TS, "utf8");
		await writeFile(join(root, "src", "query.ts"), QUERY_TS, "utf8");
		await writeFile(join(root, "bin", "render.js"), BIN_JS, "utf8");

		for (const sub of ["list", "query", "cli"]) {
			const out = await runGate(root, sub);
			expect(out.code, `gate-${sub}`).toBe(0);
		}
		// The cli gate forwards the child's stdout for the recipe's ALL-match.
		expect((await runGate(root, "cli")).stdout).toBe("a b\n");
	});

	it("the executed gate-cli fails on a wrong stdout even with exit 0 (the parser bug)", async () => {
		const root = await bakeDemo();
		await mkdir(join(root, "bin"), { recursive: true });
		// The OLD defect: the parser drops '-b' instead of stripping its dash —
		// render.js exits 0 and prints just "a". Exit 0 is not success: the
		// executed gate checks the exact stdout itself, and the recipe's
		// ALL-match re-proves it through the P07 runner.
		await writeFile(join(root, "src", "list.ts"), DROP_DASH_LIST_TS, "utf8");
		await writeFile(join(root, "bin", "render.js"), BIN_JS, "utf8");
		const cli = await runGate(root, "cli");
		expect(cli.code).not.toBe(0);
		expect(cli.stderr).toContain('must print exactly "a b"');
	});
});

describe("the full shipped replay satisfies the §0 outcome contract", () => {
	it("smoke.replay through the REAL CLI: gate-proven wave-1 failure, wave-2 repair, STATUS: COMPLETE, `node bin/render.js /a/-b` → `a b`", async () => {
		const root = await bakeDemo();
		await writeConfig(root, demoConfigToml());
		await gitInit(root); // source fixture files committed before planning
		await initProject(root);

		const replay = join(DEMO_ROOT_FIXTURE, "smoke.replay");
		const plan = await runCli(root, ["plan"], replay);
		expect(plan.code).toBe(0);
		const revision = /plan revision:\s*([0-9a-f-]{36})/.exec(plan.stdout)?.[1];
		expect(revision).toMatch(/^[0-9a-f-]{36}$/);

		const run = await runCli(root, ["run", "--approve", "--revision", revision!], replay);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("STATUS: COMPLETE");

		// The §0 invocation, executed independently against the completed result.
		const render = await exec(["node", "bin/render.js", "/a/-b"], { cwd: root, timeoutMs: 15_000 });
		expect(render.code).toBe(0);
		expect(render.stdout).toBe("a b\n");

		// The retry is proven by behavior: wave 1 of list-query failed an
		// EXECUTED gate naming the case-insensitivity requirement, and wave 2
		// did the repair.
		const waveLog = (await readFile(join(root, ".orch", "wave-log.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((r) => JSON.parse(r) as Record<string, unknown>);
		const gateFail = waveLog.find((r) => r["kind"] === "gate" && r["verb"] === "fail");
		expect(gateFail?.["task"]).toBe("list-query");
		expect(gateFail?.["wave"]).toBe(1);
		expect(String(gateFail?.["detail"])).toContain("gate-query:false");
		const done = waveLog.find((r) => r["kind"] === "task" && r["task"] === "list-query" && r["verb"] === "done");
		expect(done?.["wave"]).toBe(2);

		// The failed wave's gate log carries the executed reason.
		const queryLogName = (await readdir(join(root, ".orch", "artifacts"))).find((f) => f.startsWith("gate-list-query-"))!;
		const queryLog = await readFile(join(root, ".orch", "artifacts", queryLogName), "utf8");
		expect(queryLog).toContain("gate-query — FAIL");
		expect(queryLog).toContain("must match case-insensitively");

		// Future CLI checks did not fail while their task was still pending:
		// wave 1 of list-parse only touched src/, so gate-query/gate-cli SKIPPED.
		const parseLogName = (await readdir(join(root, ".orch", "artifacts"))).find((f) => f.startsWith("gate-list-parse-"))!;
		const parseLog = await readFile(join(root, ".orch", "artifacts", parseLogName), "utf8");
		expect(parseLog).toContain("gate-list — PASS");
		expect(parseLog).toContain("gate-query (skipped: on src/query.ts,bin/)");
		expect(parseLog).toContain("gate-cli (skipped: on bin/)");
	}, 120_000);

	it("smoke-slow.replay keeps its delay for attach/stop tests", async () => {
		const slow = await readFile(join(DEMO_ROOT_FIXTURE, "smoke-slow.replay"), "utf8");
		expect(slow).toContain('"command":"sleep 6"');
	});
});

describe("demo gates are installed only by explicit demo setup", () => {
	it("init --with-demo stays a placeholder PRD — no baked project, no active gates", async () => {
		// --with-demo writes its placeholder PRD only where no PRD exists (a
		// fixture-seeded project keeps its own docs/prd.md).
		const bare = await mkdtemp(join(tmpdir(), "kit-init-demo-"));
		await initProject(bare, { withDemo: true, projectName: "demo-check" });
		const prd = await readFile(join(bare, "docs", "prd.md"), "utf8");
		expect(prd).toContain("proven by behavior");
		expect(prd).toContain("not a baked project");
		// The template stays empty of active gates; the reviewed gate bytes are
		// NOT copied by init alone.
		const recipes = await readFile(join(bare, "evals", "recipes.toml"), "utf8");
		expect(recipes).not.toMatch(/^\[gate-list\]/m);
		await expect(readFile(join(bare, "evals", "smoke-gate.cjs"), "utf8")).rejects.toThrow();
	});

	it("prepareDemoProject alone installs no active demo gates; installDemoGates is the explicit demo setup", async () => {
		const project = await prepareDemoProject();
		await initProject(project.root);
		const recipes = await readFile(join(project.root, "evals", "recipes.toml"), "utf8");
		expect(recipes).not.toMatch(/^\[gate-list\]/m); // init's template only
		await expect(readFile(join(project.root, "evals", "smoke-gate.cjs"), "utf8")).rejects.toThrow();

		await installDemoGates(project.root);
		const demoRecipes = await readFile(join(project.root, "evals", "recipes.toml"), "utf8");
		expect(demoRecipes).toContain("[gate-list]");
		expect(demoRecipes).toContain('argv = ["node", "evals/smoke-gate.cjs", "cli"]');
		// The executed bytes are the reviewed fixture bytes (no duplicate copy).
		const copy = await readFile(join(project.root, "evals", "smoke-gate.cjs"), "utf8");
		expect(copy).toBe(await readFile(join(DEMO_ROOT_FIXTURE, "smoke-gate.cjs"), "utf8"));
	});
});

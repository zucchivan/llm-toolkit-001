/**
 * M0-P07 — recipe parity: the wave gates and the baseline probe share ONE
 * bounded no-shell runner (`src/engine/recipe-runner.ts`) with an injected
 * execArgv capability, so they observe identical literal argv tokens, the
 * same ALL-match stdout semantics, the same caps/deadline failures, and the
 * same "invalid input starts no command" preflight.
 */
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { loadRecipes, runGates } from "../src/engine/gates.ts";
import { hostExecArgv, runRecipe } from "../src/engine/recipe-runner.ts";
import type { ExecArgvCapability } from "../src/engine/recipe-runner.ts";
import { probeGates } from "../src/adoption/probe.ts";
import { refreshGates } from "../src/adoption/workflow.ts";
import { bakeProject } from "./fixtures2.ts";
import { buildFauxModels } from "./fixtures.ts";
import { demoConfigToml } from "./demo-project.ts";
import { captureBaselineTree } from "../src/util/git.ts";

/** Records the argv tokens the runner actually hands to the capability. */
function capture(target: Array<{ argv: string[]; cwd: string }>, inner: ExecArgvCapability = hostExecArgv): ExecArgvCapability {
	return async (argv, cwd, timeoutMs, signal) => {
		target.push({ argv: [...argv], cwd });
		return await inner(argv, cwd, timeoutMs, signal);
	};
}

/** Tripwire capability: any recipe execution fails the test. */
const noExec: ExecArgvCapability = async () => {
	throw new Error("no command may start");
};

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "kit-recipe-parity-"));
	await mkdir(join(root, "evals"), { recursive: true });
	return root;
}

async function writeRecipes(root: string, toml: string): Promise<void> {
	await writeFile(join(root, "evals", "recipes.toml"), toml, "utf8");
}

/** Prints its observed argv (args after the script) as one JSON line: the
 * child-side parity witness. Node resolves argv[1] to an absolute path, so
 * the script itself is excluded. */
const TOKEN_ECHO = "console.log(JSON.stringify(process.argv.slice(2)))";

/** Wave-side gate run over a freshly baked demo project (2s recipe deadline). */
async function waveGate(toml: string) {
	const { kit } = await bakeProject({ buildFauxModels, configToml: demoConfigToml().replace("timeoutSec = 30", "timeoutSec = 2") });
	await writeFile(join(kit.loop.paths.root, "evals", "recipes.toml"), toml, "utf8");
	const baseline = await captureBaselineTree(kit.loop.paths.root);
	return await runGates(kit, { id: "t", targetPaths: [], baselineTreeSha: baseline });
}

describe("recipe parity: wave gates and baseline probe share the one runner", () => {
	it("observes identical literal argv tokens for spaced/empty/metacharacter arguments", async () => {
		const root = await tempRoot();
		await writeFile(join(root, "token-echo.cjs"), TOKEN_ECHO, "utf8");
		// TOML literal strings keep backslashes literal: '"\$HOME"' is the regex
		// matching the two characters $HOME, quoted. All five must match (ALL).
		await writeRecipes(root, [
			`[token-echo]`,
			`argv = ["node", "token-echo.cjs", "a b", "", "/a/-b", "$HOME", "x|y"]`,
			`match = ['"a b"', '""', '"/a/-b"', '"\\$HOME"', '"x\\|y"']`,
			``,
		].join("\n"));

		const probeSeen: Array<{ argv: string[]; cwd: string }> = [];
		const probe = await probeGates(root, {
			interactive: false, confirmed: true, timeoutMs: 15_000,
			execute: capture(probeSeen),
		});
		expect(probeSeen[0]?.argv).toEqual(["node", "token-echo.cjs", "a b", "", "/a/-b", "$HOME", "x|y"]);
		expect(probeSeen[0]?.cwd).toBe(root);
		expect(probe.allPassed).toBe(true);
		const probeJson = probe.results[0]?.tail.trim();

		// Wave side: the SAME recipe through runGates must observe the same
		// tokens and the same stdout witness.
		const { kit } = await bakeProject({ buildFauxModels, configToml: demoConfigToml().replace("timeoutSec = 30", "timeoutSec = 2") });
		await writeFile(join(kit.loop.paths.root, "token-echo.cjs"), TOKEN_ECHO, "utf8");
		await writeFile(join(kit.loop.paths.root, "evals", "recipes.toml"), (await readFile(join(root, "evals", "recipes.toml"), "utf8")), "utf8");
		const baseline = await captureBaselineTree(kit.loop.paths.root);
		const waveSeen: Array<{ argv: string[]; cwd: string }> = [];
		const gate = await runGates(kit, { id: "t", targetPaths: [], baselineTreeSha: baseline }, {}, { capability: capture(waveSeen) });

		expect(waveSeen[0]?.argv).toEqual(probeSeen[0]?.argv); // identical literal tokens
		expect(waveSeen[0]?.cwd).toBe(kit.loop.paths.root); // each side runs in its own project
		const waveEcho = gate.results.find((r) => r.name === "token-echo");
		expect(waveEcho?.passed).toBe(true);
		expect(waveEcho?.matched).toBe(true);
		expect(waveEcho?.tail.trim()).toBe(probeJson);
	}, 60_000);

	it("fails when only ONE of two patterns matches (ALL-match, was any-match) in both callers", async () => {
		const root = await tempRoot();
		await writeFile(join(root, "token-echo.cjs"), TOKEN_ECHO, "utf8");
		await writeRecipes(root, `[one-of-two]\nargv = ["node", "-e", "console.log('token-echo.cjs')"]\nmatch = ['token-echo.cjs', 'NEVER_MATCHES']\n`);

		const probe = await probeGates(root, { interactive: false, confirmed: true, timeoutMs: 15_000 });
		expect(probe.allPassed).toBe(false);
		expect(probe.results[0]?.passed).toBe(false);
		expect(probe.messages.join("\n")).toContain("NEVER_MATCHES");

		const wave = await waveGate(`[one-of-two]\nargv = ["node", "-e", "console.log('token-echo.cjs')"]\nmatch = ['token-echo.cjs', 'NEVER_MATCHES']\n`);
		const row = wave.results.find((r) => r.name === "one-of-two");
		expect(row?.passed).toBe(false);
		expect(row?.reason).toContain("NEVER_MATCHES");
	}, 30_000);

	it("fails on timeout in both callers and never passes a timed-out run", async () => {
		const root = await tempRoot();
		await writeRecipes(root, `[slow]\nargv = ["node", "-e", "setTimeout(() => {}, 10000)"]\n`);

		const probe = await probeGates(root, { interactive: false, confirmed: true, timeoutMs: 400 });
		expect(probe.allPassed).toBe(false);
		expect(probe.messages.join("\n")).toContain("timeout");

		// Runner level: a timed-out run with plausible output still fails.
		const outcome = await runRecipe(root, { name: "slow", argv: ["node", "-e", "setTimeout(() => {}, 10000)"] }, { timeoutMs: 400 });
		expect(outcome.timedOut).toBe(true);
		expect(outcome.passed).toBe(false);
		expect(outcome.failure).toBe("timeout");
		expect(outcome.exit).not.toBe(0);

		// Wave side uses the configured [gates] timeoutSec (2s here).
		const wave = await waveGate(`[slow]\nargv = ["node", "-e", "setTimeout(() => {}, 10000)"]\n`);
		const slow = wave.results.find((r) => r.name === "slow");
		expect(slow?.passed).toBe(false);
		expect(slow?.reason).toContain("timeout");
	}, 30_000);

	it("fails output_capped when required stdout is truncated (a tail is not evidence) in both callers", async () => {
		const root = await tempRoot();
		// 'b' is printed FIRST so a sliding 256 KiB tail window would drop it;
		// the capped run must fail as output_capped instead of proving a tail.
		const printer = "process.stdout.write('b\\n');process.stdout.write('a'.repeat(300*1024))";
		await writeRecipes(root, `[capped]\nargv = ["node", "-e", ${JSON.stringify(printer)}]\nmatch = ["b"]\n`);

		const probe = await probeGates(root, { interactive: false, confirmed: true, timeoutMs: 15_000 });
		expect(probe.allPassed).toBe(false);
		expect(probe.messages.join("\n")).toContain("output_capped");

		const outcome = await runRecipe(root, { name: "capped", argv: ["node", "-e", printer], match: ["b"] }, { timeoutMs: 15_000 });
		expect(outcome.stdoutCapped).toBe(true);
		expect(outcome.failure).toBe("output-capped");
		expect(outcome.passed).toBe(false);

		const wave = await waveGate(`[capped]\nargv = ["node", "-e", ${JSON.stringify(printer)}]\nmatch = ["b"]\n`);
		const row = wave.results.find((r) => r.name === "capped");
		expect(row?.passed).toBe(false);
		expect(row?.reason).toContain("output_capped");
	}, 30_000);

	it("runs match evaluation in a terminable worker so a pathological regex cannot block the host event loop", async () => {
		const root = await tempRoot();
		const printer = "process.stdout.write('a'.repeat(80)+'b')";
		await writeRecipes(root, `[backtrack]\nargv = ["node", "-e", ${JSON.stringify(printer)}]\nmatch = ["(a+)+$"]\n`);

		const startedAt = performance.now();
		const probe = await probeGates(root, { interactive: false, confirmed: true, timeoutMs: 500 });
		const elapsed = performance.now() - startedAt;
		expect(probe.allPassed).toBe(false);
		expect(probe.messages.join("\n")).toContain("deadline");
		expect(elapsed).toBeLessThan(5_000); // terminated, not backtracked for hours
	});

	it("starts no command when cwd escapes (parent or symlink), the regex is invalid, or both forms exist", async () => {
		const root = await tempRoot();
		// The symlink target deliberately lives OUTSIDE the project root.
		const outer = await mkdtemp(join(tmpdir(), "kit-recipe-outer-"));
		await symlink(outer, join(root, "link"));

		// parent escape + symlink escape + missing cwd
		for (const cwd of ["../outside", "link", "does-not-exist"]) {
			const probeSeen: Array<{ argv: string[]; cwd: string }> = [];
			await writeRecipes(root, `[escape]\nargv = ["node", "-e", "console.log('RAN')"]\ncwd = ${JSON.stringify(cwd)}\n`);
			const probe = await probeGates(root, { interactive: false, confirmed: true, timeoutMs: 15_000, execute: capture(probeSeen, noExec) });
			expect(probeSeen, `probe must not start a command for cwd ${cwd}`).toEqual([]);
			expect(probe.errors?.length).toBe(1);
			expect(probe.messages.join("\n")).toMatch(/recipe cwd/);
		}

		// invalid regex
		await writeRecipes(root, `[bad-regex]\nargv = ["node", "-e", "console.log('RAN')"]\nmatch = ["("]\n`);
		const regexSeen: Array<{ argv: string[]; cwd: string }> = [];
		const regexProbe = await probeGates(root, { interactive: false, confirmed: true, timeoutMs: 15_000, execute: capture(regexSeen, noExec) });
		expect(regexSeen).toEqual([]);
		expect(regexProbe.errors?.[0]).toContain("invalid match regex");

		// both command forms at once: refused at load, before any consent
		await writeRecipes(root, `[both]\ncmd = "node -e x"\nargv = ["node", "-e", "x"]\n`);
		await expect(probeGates(root, { interactive: false, confirmed: true, timeoutMs: 15_000, execute: noExec }))
			.rejects.toThrow(/exactly ONE command form/);

		// Wave side: identical refusals, and the injected capability proves no
		// recipe command started for any of the three cases.
		const waveSeen: Array<{ argv: string[]; cwd: string }> = [];
		for (const [label, toml] of [
			["cwd escape", `[escape]\nargv = ["node", "-e", "console.log('RAN')"]\ncwd = "../outside"\n`],
			["invalid regex", `[bad-regex]\nargv = ["node", "-e", "console.log('RAN')"]\nmatch = ["("]\n`],
			["both forms", `[both]\ncmd = "node -e x"\nargv = ["node", "-e", "x"]\n`],
		] as const) {
			const { kit } = await bakeProject({ buildFauxModels, configToml: demoConfigToml().replace("timeoutSec = 30", "timeoutSec = 2") });
			await writeFile(join(kit.loop.paths.root, "evals", "recipes.toml"), toml, "utf8");
			const baseline = await captureBaselineTree(kit.loop.paths.root);
			const before = waveSeen.length;
			const gate = await runGates(kit, { id: "t", targetPaths: [], baselineTreeSha: baseline }, {}, { capability: capture(waveSeen, noExec) });
			expect(gate.allPassed, label).toBe(false);
			expect(waveSeen.length, label).toBe(before); // no command started
			expect(gate.results.some((r) => r.passed === false && /no command started|recipe file refused/.test(r.reason ?? "")), label).toBe(true);
		}
	}, 60_000);

	it("an empty match list is vacuously true", async () => {
		const root = await tempRoot();
		await writeRecipes(root, `[quiet]\nargv = ["node", "-e", ""]\nmatch = []\n`);
		const probe = await probeGates(root, { interactive: false, confirmed: true, timeoutMs: 15_000 });
		expect(probe.allPassed).toBe(true);
	});

	it("loads and runs the template's spaced-argument example exactly as documented", async () => {
		const template = await readFile(join(process.cwd(), "template", "evals", "recipes.toml"), "utf8");
		const start = template.indexOf("# [render-args]");
		expect(start).toBeGreaterThan(0);
		const uncommented = template.slice(start).split("\n").map((line) => line.startsWith("# ") ? line.slice(2) : line).join("\n");

		const root = await tempRoot();
		await writeRecipes(root, uncommented);
		await mkdir(join(root, "bin"), { recursive: true });
		await writeFile(join(root, "bin", "render.js"), TOKEN_ECHO, "utf8");

		const loaded = loadRecipes({ root } as never);
		expect(loaded.recipes).toEqual([
			{ name: "render-args", argv: ["node", "bin/render.js", "/a/-b", "a b", ""], match: ["a b"] },
		]);

		const probe = await probeGates(root, { interactive: false, confirmed: true, timeoutMs: 15_000 });
		expect(probe.allPassed).toBe(true);
		const observed = JSON.parse(probe.results[0]!.tail.trim()) as string[];
		// The child observes the documented tokens after the script name (node
		// resolves the script path itself); the loaded form asserted the full set.
		expect(observed).toEqual(["/a/-b", "a b", ""]);
	}, 30_000);

	it("a legacy whitespace cmd still runs, but shell syntax in cmd is refused with a pointer at argv", async () => {
		const root = await tempRoot();
		await writeFile(join(root, "token-echo.cjs"), TOKEN_ECHO, "utf8");
		await writeRecipes(root, `[legacy]\ncmd = "node   token-echo.cjs"\n`);
		const seen: Array<{ argv: string[]; cwd: string }> = [];
		const probe = await probeGates(root, { interactive: false, confirmed: true, timeoutMs: 15_000, execute: capture(seen) });
		expect(seen[0]?.argv).toEqual(["node", "token-echo.cjs"]);
		expect(probe.allPassed).toBe(true);

		for (const bad of [
			`[quoted]\ncmd = "echo 'a b'"`,
			`[piped]\ncmd = "npm test | tee log"`,
			`[redirect]\ncmd = "npm test > out.txt"`,
			`[expanded]\ncmd = "npm run $TARGET"`,
			`[chained]\ncmd = "npm test && npm run lint"`,
			`[globbed]\ncmd = "node bin/*.js"`,
		]) {
			await writeRecipes(root, `${bad}\n`);
			const refused: Array<{ argv: string[]; cwd: string }> = [];
			// Form refusals happen at load time, before probe consent, so they reject.
			await expect(probeGates(root, { interactive: false, confirmed: true, timeoutMs: 15_000, execute: capture(refused, noExec) }))
				.rejects.toThrow(/argv/);
			expect(refused, bad).toEqual([]);
		}
	});

	it("refreshing an unchanged legacy recipe creates no spurious write (canonical argv keeps fingerprints stable)", async () => {
		const root = await mkdtemp(join(tmpdir(), "kit-recipe-stable-"));
		await writeFile(join(root, "package.json"), JSON.stringify({ name: "app", private: true, scripts: { test: "node --test" } }), "utf8");
		const first = await refreshGates(root, { interactive: false, acceptRecommended: true });
		expect(first.wroteRecipes).toBe(true);
		const before = await readFile(join(root, "evals", "recipes.auto.toml"), "utf8");
		expect(before).toContain('cmd = "npm test"'); // legacy cmd rendering preserved

		const second = await refreshGates(root, { interactive: false, acceptRecommended: true });
		expect(second.wroteRecipes).toBe(false);
		expect(await readFile(join(root, "evals", "recipes.auto.toml"), "utf8")).toBe(before);
	});
});

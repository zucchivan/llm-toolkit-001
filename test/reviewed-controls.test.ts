/**
 * M1-P01 step (c) — reviewed control inputs are read through the host boundary.
 *
 * This file is named by the packet's strict target/verification lists. It
 * covers the step (c) wiring that is inside the packet: the reviewed control
 * bundle (`loadPlanControls`) and the gate-time recipe read (`loadRecipesSafe`)
 * both resolve the project root once and read root-relative through the
 * no-follow, capped reader. Full `evals/**` identity coverage and
 * call-site-coverage review stay in step (d).
 *
 * A genuine ENOENT remains a defined "absent" input; a symlink (leaf or
 * ancestor), directory, escaping name, oversized file or unavailable primitive
 * refuses the load. The gate integration asserts an EFFECT count: a refused
 * recipe file starts no command at all.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRecipeFileSafe, loadRecipes, loadRecipesSafe, runGates } from "../src/engine/gates.ts";
import { loadPlanControls } from "../src/engine/plans.ts";
import { captureBaselineTree } from "../src/util/git.ts";
import type { ExecArgvCapability } from "../src/engine/recipe-runner.ts";
import { bakeProject } from "./fixtures2.ts";
import { buildFauxModels } from "./fixtures.ts";
import { demoConfigToml } from "./demo-project.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix = "kit-reviewed-controls-"): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

describe("reviewed controls: root-relative no-follow reads", () => {
	it("reads the named controls and keeps genuine absence distinct from empty content", async () => {
		const root = await tempRoot();
		await mkdir(join(root, ".orch"), { recursive: true });
		await mkdir(join(root, "evals"), { recursive: true });
		const absent = await loadPlanControls(root);
		expect(absent).toEqual({
			remediations: null,
			promptSha256: null,
			checklistSha256: null,
			recipesSha256: null,
			recipesAutoSha256: null,
		});

		await writeFile(join(root, "PROMPT.md"), "RULES\n", "utf8");
		await writeFile(join(root, "evals", "recipes.toml"), "[gate-a]\nargv = [\"node\", \"-e\", \"\"]\n", "utf8");
		await writeFile(join(root, ".orch", "gate-remediations.json"), JSON.stringify({ version: 1, remediations: [] }), "utf8");
		const present = await loadPlanControls(root);
		expect(present.remediations).toEqual([]); // approved EMPTY, not absent
		expect(present.promptSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(present.recipesSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(present.checklistSha256).toBeNull();
		expect(present.recipesAutoSha256).toBeNull();
	});

	it("refuses a symlinked or directory control instead of hashing the link target", async () => {
		const root = await tempRoot();
		const outside = await tempRoot("kit-reviewed-outside-");
		await mkdir(join(root, ".orch"), { recursive: true });
		await mkdir(join(root, "evals"), { recursive: true });
		await writeFile(join(outside, "recipes.toml"), "[stolen]\nargv = [\"node\", \"-e\", \"\"]\n", "utf8");

		await symlink(join(outside, "recipes.toml"), join(root, "evals", "recipes.toml"));
		await expect(loadPlanControls(root)).rejects.toThrow(/regular file/);

		await rm(join(root, "evals", "recipes.toml"));
		await mkdir(join(root, "evals", "recipes.toml")); // a directory is not a control file
		await expect(loadPlanControls(root)).rejects.toThrow(/regular file/);
	});

	it("refuses a control reached through a symlinked ancestor directory", async () => {
		const root = await tempRoot();
		const outside = await tempRoot("kit-reviewed-outside-");
		await writeFile(join(outside, "recipes.toml"), "[stolen]\nargv = [\"node\", \"-e\", \"\"]\n", "utf8");
		await symlink(outside, join(root, "evals"));
		await expect(loadPlanControls(root)).rejects.toThrow(/regular file/);
	});
});

describe("gate recipe read: same boundary, same parser", () => {
	it("keeps the human-over-generated precedence and absence-as-empty-gates for the safe read", async () => {
		const root = await tempRoot();
		await mkdir(join(root, "evals"), { recursive: true });
		expect((await loadRecipesSafe({ root } as never, root)).recipes).toEqual([]);

		await writeFile(join(root, "evals", "recipes.auto.toml"), "[gate-a]\nargv = [\"node\", \"-e\", \"generated\"]\n[gate-b]\nargv = [\"node\", \"-e\", \"generated\"]\n", "utf8");
		await writeFile(join(root, "evals", "recipes.toml"), "[gate-b]\nargv = [\"node\", \"-e\", \"human\"]\n", "utf8");
		const safe = await loadRecipesSafe({ root } as never, root);
		expect(safe).toEqual(loadRecipes({ root } as never));
		expect(safe.recipes.find((recipe) => recipe.name === "gate-b")).toEqual({ name: "gate-b", argv: ["node", "-e", "human"] });
	});

	it("refuses a symlinked recipe file and an invalid TOML with the loader's own plain words", async () => {
		const root = await tempRoot();
		const outside = await tempRoot("kit-reviewed-outside-");
		await mkdir(join(root, "evals"), { recursive: true });
		await writeFile(join(outside, "recipes.toml"), "[stolen]\nargv = [\"node\", \"-e\", \"\"]\n", "utf8");
		await symlink(join(outside, "recipes.toml"), join(root, "evals", "recipes.toml"));
		await expect(loadRecipeFileSafe(root, "recipes.toml")).rejects.toThrow(/unreadable\/invalid: .*symbolic link/);
		await expect(loadRecipesSafe({ root } as never, root)).rejects.toThrow(/unreadable\/invalid/);

		await rm(join(root, "evals", "recipes.toml"));
		await writeFile(join(root, "evals", "recipes.toml"), "[broken-gate\nmatch = \"x\"\n", "utf8");
		await expect(loadRecipeFileSafe(root, "recipes.toml")).rejects.toThrow(/evals\/recipes\.toml is unreadable\/invalid/);
	});

	it("a refused recipe file fails the recipes check and starts NO command", async () => {
		const { kit } = await bakeProject({ buildFauxModels, configToml: demoConfigToml() });
		try {
			const root = kit.loop.paths.root;
			const outside = await tempRoot("kit-reviewed-outside-");
			await writeFile(join(outside, "recipes.toml"), "[gate-should-not-run]\nargv = [\"node\", \"-e\", \"\"]\n", "utf8");
			await rm(join(root, "evals", "recipes.toml"), { force: true });
			await rm(join(root, "evals", "recipes.auto.toml"), { force: true });
			await symlink(join(outside, "recipes.toml"), join(root, "evals", "recipes.toml"));

			let commandsStarted = 0;
			const tripwire: ExecArgvCapability = async () => {
				commandsStarted += 1;
				throw new Error("no command may start from a refused recipe file");
			};
			const baseline = await captureBaselineTree(root);
			const outcome = await runGates(kit, { id: "t", targetPaths: [], baselineTreeSha: baseline }, {}, { capability: tripwire });
			expect(commandsStarted).toBe(0);
			expect(outcome.results.some((result) => result.name === "gate-should-not-run")).toBe(false);
			const recipes = outcome.results.find((result) => result.name === "recipes");
			expect(recipes?.passed).toBe(false);
			expect(recipes?.tail).toMatch(/unreadable\/invalid/);
			expect(outcome.allPassed).toBe(false);
		} finally {
			await kit.loop.close().catch(() => {});
			kit.lock.release();
		}
	}, 30_000);
});

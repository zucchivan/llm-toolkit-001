/**
 * M1-P01 steps (c)–(d) — reviewed control inputs and their identity.
 *
 * This file is named by the packet's strict target/verification lists. It
 * covers the step (c) wiring that is inside the packet (the reviewed control
 * bundle and the gate-time recipe read both resolve the project root once and
 * read root-relative through the no-follow, capped reader) and the step (d)
 * identity expansion: EVERY `evals/**` regular-file byte (executable assertion
 * scripts and binary fixtures included), the actual configured/`--prd` file,
 * approved remediations and the effective verification/delivery/routing/
 * admission settings are bound; `budgets.sessionUsd` alone is not drift.
 *
 * A genuine ENOENT remains a defined "absent" input; a symlink (leaf or
 * ancestor), non-regular/hard-linked file, escaping name, oversized file or
 * unavailable primitive refuses the load. The gate integration asserts an
 * EFFECT count: a refused recipe file starts no command at all.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRecipeFileSafe, loadRecipes, loadRecipesSafe, recipeBundleFromTree, runGates } from "../src/engine/gates.ts";
import { controlsDigest, controlsSha256, loadPlanControls, reviewBindingRefusal, reviewedBaseTreeRefusal } from "../src/engine/plans.ts";
import { parseConfig } from "../src/config.ts";
import { captureBaselineTree } from "../src/util/git.ts";
import type { ExecArgvCapability } from "../src/engine/recipe-runner.ts";
import { bakeProject } from "./fixtures2.ts";
import { buildFauxModels } from "./fixtures.ts";
import { execFileSync } from "node:child_process";
import { controlsForTree, discard, materializeRead } from "../src/engine/workspace.ts";
import { resolveTree } from "../src/util/git-objects.ts";
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
	it("reads the reviewed control tree and keeps genuine absence distinct from empty content", async () => {
		const root = await tempRoot();
		await mkdir(join(root, ".orch"), { recursive: true });
		const noEvals = await loadPlanControls(root);
		expect(noEvals).toEqual({ remediations: null, evals: null, prompt: null, settings: null });

		await mkdir(join(root, "evals"), { recursive: true });
		const emptyEvals = await loadPlanControls(root);
		expect(emptyEvals).toEqual({ remediations: null, evals: [], prompt: null, settings: null });

		await writeFile(join(root, "PROMPT.md"), "RULES\n", "utf8");
		await writeFile(join(root, "evals", "recipes.toml"), "[gate-a]\nargv = [\"node\", \"-e\", \"\"]\n", "utf8");
		await writeFile(join(root, "evals", "assert.cjs"), "process.exit(0);\n", { encoding: "utf8", mode: 0o755 });
		await writeFile(join(root, ".orch", "gate-remediations.json"), JSON.stringify({ version: 1, remediations: [] }), "utf8");
		const present = await loadPlanControls(root);
		expect(present.remediations).toEqual([]); // approved EMPTY, not absent
		expect(present.prompt?.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(present.evals?.map((file) => file.path)).toEqual(["evals/assert.cjs", "evals/recipes.toml"]);
		expect(present.evals?.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
		expect(present.settings).toBeNull(); // file-only capture: no config was supplied
	});

	it("refuses a symlinked or directory control instead of hashing the link target", async () => {
		const root = await tempRoot();
		const outside = await tempRoot("kit-reviewed-outside-");
		await mkdir(join(root, ".orch"), { recursive: true });
		await mkdir(join(root, "evals"), { recursive: true });
		await writeFile(join(outside, "recipes.toml"), "[stolen]\nargv = [\"node\", \"-e\", \"\"]\n", "utf8");

		await symlink(join(outside, "recipes.toml"), join(root, "evals", "recipes.toml"));
		await expect(loadPlanControls(root)).rejects.toThrow(/regular file/);

		// A directory is not a regular-file byte; the identity capture lists the
		// files only, and the GATE reader refuses the directory leaf so no recipe
		// can be parsed or executed from it.
		await rm(join(root, "evals", "recipes.toml"));
		await mkdir(join(root, "evals", "recipes.toml"));
		const captured = await loadPlanControls(root);
		expect(captured.evals).toEqual([]);
		await expect(loadRecipeFileSafe(root, "recipes.toml")).rejects.toThrow(/unreadable\/invalid/);
	});

	it("refuses a control reached through a symlinked ancestor directory", async () => {
		const root = await tempRoot();
		const outside = await tempRoot("kit-reviewed-outside-");
		await writeFile(join(outside, "recipes.toml"), "[stolen]\nargv = [\"node\", \"-e\", \"\"]\n", "utf8");
		await symlink(outside, join(root, "evals"));
		await expect(loadPlanControls(root)).rejects.toThrow(/regular file/);
	});
});

describe("review identity: every reviewed byte and effective policy setting (M1-P01 step d)", () => {
	async function reviewProject(): Promise<{ root: string; config: ReturnType<typeof parseConfig> }> {
		const root = await tempRoot();
		await mkdir(join(root, ".orch"), { recursive: true });
		await mkdir(join(root, "docs"), { recursive: true });
		await mkdir(join(root, "evals", "fixtures"), { recursive: true });
		await writeFile(join(root, "docs", "prd.md"), "# PRD\n", "utf8");
		await writeFile(join(root, "PROMPT.md"), "RULES\n", "utf8");
		await writeFile(join(root, "evals", "checklist.md"), "CHECKS\n", "utf8");
		await writeFile(join(root, "evals", "assert.cjs"), "process.exit(0);\n", { encoding: "utf8", mode: 0o755 });
		await writeFile(join(root, "evals", "fixtures", "binary.bin"), Buffer.from([0, 1, 2, 255]));
		await writeFile(join(root, ".orch", "gate-remediations.json"), JSON.stringify({ version: 1, remediations: [] }), "utf8");
		return { root, config: parseConfig(demoConfigToml(), root) };
	}

	it("uses the original reviewed objects for binding, projection and recipe loading despite replace refs", async () => {
		const { root, config } = await reviewProject();
		const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: root, encoding: "utf8" }).trim();
		const recipe = '[reviewed]\nargv = ["node", "--version"]\n';
		const recipePath = "evals/recipes.toml";
		await writeFile(join(root, recipePath), recipe);
		git("init", "-q");
		git("add", "evals", "PROMPT.md", "docs");
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "reviewed");
		const baseCommit = git("rev-parse", "HEAD");
		const tree = await resolveTree(root, baseCommit);
		const controls = await loadPlanControls(root, { prdPath: "docs/prd.md", config });
		const identity = {
			planRevision: "11111111-1111-4111-8111-111111111111",
			definitionSha256: "0".repeat(64), baseCommit, baseBranch: git("branch", "--show-current"),
			prdPath: "docs/prd.md", prdSha256: controls.prd!.sha256, controlsSha256: controlsDigest(controls)!,
		};
		await writeFile(join(root, "alternate.txt"), '[different]\nargv = ["node", "--help"]\n');
		git("replace", git("rev-parse", `HEAD:${recipePath}`), git("hash-object", "-w", "alternate.txt"));
		expect(await reviewedBaseTreeRefusal(root, baseCommit, controls)).toBeUndefined();
		expect(await reviewBindingRefusal(root, identity, config)).toBeUndefined();
		const source = { root, oid: tree };
		const projection = await materializeRead(source, await controlsForTree(source, []));
		try {
			expect(await readFile(join(projection.viewPath, recipePath), "utf8")).toBe(recipe);
			expect((await recipeBundleFromTree(root, tree)).files).toContainEqual({ path: recipePath, contents: recipe });
		} finally {
			await discard(projection);
		}
	});

	it("binds every evals/** regular-file byte, the actual PRD, remediations and effective settings", async () => {
		const { root, config } = await reviewProject();
		const digest = () => controlsSha256(root, { prdPath: "docs/prd.md", config });
		const base = await digest();
		expect(base).toMatch(/^[0-9a-f]{64}$/);

		// An executable assertion script is a reviewed byte, not just a recipe name.
		await writeFile(join(root, "evals", "assert.cjs"), "process.exit(1);\n", "utf8");
		const scriptChanged = await digest();
		expect(scriptChanged).not.toBe(base);
		await writeFile(join(root, "evals", "assert.cjs"), "process.exit(0);\n", "utf8");
		expect(await digest()).toBe(base);

		// A binary eval fixture is hashed as bytes (no text decode requirement).
		await writeFile(join(root, "evals", "fixtures", "binary.bin"), Buffer.from([0, 1, 2, 254]));
		expect(await digest()).not.toBe(base);
		await writeFile(join(root, "evals", "fixtures", "binary.bin"), Buffer.from([0, 1, 2, 255]));
		expect(await digest()).toBe(base);

		// The ACTUAL configured/--prd file, every non-recipe eval and PROMPT.md.
		await writeFile(join(root, "docs", "prd.md"), "# PRD v2\n", "utf8");
		expect(await digest()).not.toBe(base);
		await writeFile(join(root, "docs", "prd.md"), "# PRD\n", "utf8");
		await writeFile(join(root, "evals", "checklist.md"), "CHECKS v2\n", "utf8");
		expect(await digest()).not.toBe(base);
		await writeFile(join(root, "evals", "checklist.md"), "CHECKS\n", "utf8");
		await writeFile(join(root, "PROMPT.md"), "RULES v2\n", "utf8");
		expect(await digest()).not.toBe(base);
		await writeFile(join(root, "PROMPT.md"), "RULES\n", "utf8");

		// Approved remediations are approval state, not just file presence.
		await writeFile(join(root, ".orch", "gate-remediations.json"), JSON.stringify({ version: 1, remediations: [{ gapId: "g1" }] }), "utf8");
		expect(await digest()).not.toBe(base);
		await writeFile(join(root, ".orch", "gate-remediations.json"), JSON.stringify({ version: 1, remediations: [] }), "utf8");
		expect(await digest()).toBe(base);

		// Raising ONLY the session ceiling is not control drift (§3 transition 1).
		const raised = parseConfig(demoConfigToml().replace("sessionUsd = 25.0", "sessionUsd = 999.0"), root);
		expect(await digest()).toBe(base);
		expect(await controlsSha256(root, { prdPath: "docs/prd.md", config: raised })).toBe(base);

		// Effective verification / delivery / routing / breaker policy is.
		const verification = parseConfig(
			demoConfigToml().replace("[gates]\ntimeoutSec = 30", "[gates]\ntimeoutSec = 30\nskepticSecondPass = false"),
			root,
		);
		expect(await controlsSha256(root, { prdPath: "docs/prd.md", config: verification })).not.toBe(base);
		const delivery = parseConfig(demoConfigToml().replace('mode = "none"', 'mode = "commit"'), root);
		expect(await controlsSha256(root, { prdPath: "docs/prd.md", config: delivery })).not.toBe(base);
		const routing = parseConfig(demoConfigToml().replace('modelId = "kit-impl"', 'modelId = "kit-impl-2"'), root);
		expect(await controlsSha256(root, { prdPath: "docs/prd.md", config: routing })).not.toBe(base);
		const breaker = parseConfig(demoConfigToml().replace("maxConsecutiveErrors = 3", "maxConsecutiveErrors = 1"), root);
		expect(await controlsSha256(root, { prdPath: "docs/prd.md", config: breaker })).not.toBe(base);
	});

	it("reviewBindingRefusal names PRD vs control drift and tolerates a session-ceiling edit", async () => {
		const { root, config } = await reviewProject();
		const controls = await loadPlanControls(root, { prdPath: "docs/prd.md", config });
		const identity = {
			planRevision: "11111111-1111-4111-8111-111111111111",
			definitionSha256: "0".repeat(64),
			baseCommit: null,
			baseBranch: null,
			prdPath: "docs/prd.md",
			prdSha256: controls.prd!.sha256,
			controlsSha256: controlsDigest(controls)!,
		};
		expect(await reviewBindingRefusal(root, identity, config)).toBeUndefined();
		const raised = parseConfig(demoConfigToml().replace("sessionUsd = 25.0", "sessionUsd = 50.0"), root);
		expect(await reviewBindingRefusal(root, identity, raised)).toBeUndefined();

		await writeFile(join(root, "evals", "checklist.md"), "TAMPERED CHECKS\n", "utf8");
		expect(await reviewBindingRefusal(root, identity, config)).toMatch(/reviewed controls changed/);
		await writeFile(join(root, "evals", "checklist.md"), "CHECKS\n", "utf8");
		expect(await reviewBindingRefusal(root, identity, config)).toBeUndefined();

		await writeFile(join(root, "docs", "prd.md"), "# OTHER PRD\n", "utf8");
		expect(await reviewBindingRefusal(root, identity, config)).toMatch(/reviewed PRD docs\/prd\.md changed/);
		await writeFile(join(root, "docs", "prd.md"), "# PRD\n", "utf8");
		expect(await reviewBindingRefusal(root, identity, config)).toBeUndefined();

		await rm(join(root, "docs", "prd.md"));
		expect(await reviewBindingRefusal(root, identity, config)).toMatch(/reviewed PRD docs\/prd\.md is absent/);
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

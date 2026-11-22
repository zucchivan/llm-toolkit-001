import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRecipeFile, loadRecipes, recipesEquivalent } from "../src/engine/gates.ts";
import { cmdArgv, validateArgv } from "../src/engine/recipe-runner.ts";

async function rootWithFiles(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "kit-recipes-"));
	await mkdir(join(root, "evals"), { recursive: true });
	for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content, "utf8");
	return root;
}

describe("adopted gate recipe loading", () => {
	it("loads generated recipes and lets a human duplicate name override them", async () => {
		const root = await rootWithFiles({
			"evals/recipes.auto.toml": '[unit-test]\ncmd = "npm test"\ncwd = "packages/web"\n[generated-only]\ncmd = "npm run check"\n',
			"evals/recipes.toml": '[unit-test]\ncmd = "npm run test:human"\n[build]\ncmd = "npm run build"\n',
		});

		const loaded = loadRecipes({ root } as never);
		expect(loaded.recipes).toMatchObject([
			{ name: "unit-test", cmd: "npm run test:human" },
			{ name: "generated-only", cmd: "npm run check" },
			{ name: "build", cmd: "npm run build" },
		]);
	});

	it("loads the §3 argv form with literal spaced/empty/metacharacter tokens", async () => {
		const root = await rootWithFiles({
			"evals/recipes.toml": '[render]\nargv = ["node", "bin/render.js", "/a/-b", "a b", ""]\nmatch = ["a b"]\non = ["src/"]\n',
		});
		expect(loadRecipeFile(root, "recipes.toml")).toEqual([
			{ name: "render", argv: ["node", "bin/render.js", "/a/-b", "a b", ""], match: ["a b"], on: ["src/"] },
		]);
	});

	it("refuses invalid recipes at load time, with an instruction to use argv", async () => {
		for (const toml of [
			`[both]\ncmd = "npm test"\nargv = ["npm", "test"]`, // two command forms
			`[neither]\nname = "x"`, // no command form
			`[quoted]\ncmd = "echo 'a b'"`, // shell quoting
			`[piped]\ncmd = "npm test | tee log"`, // pipes
			`[redirect]\ncmd = "npm run build > log"`, // redirections
			`[expanded]\ncmd = "npm run $TARGET"`, // expansions
			`[empty-exec]\nargv = ["", "x"]`, // empty executable
			`[too-many]\nargv = ${JSON.stringify(Array.from({ length: 129 }, (_, i) => `t${i}`))}`, // >128 tokens
			`[match-type]\ncmd = "npm test"\nmatch = "a b"`, // match must be an array
			`[on-type]\ncmd = "npm test"\non = [42]`, // on must be an array of strings
		]) {
			const root = await rootWithFiles({ "evals/recipes.toml": `${toml}\n` });
			expect(() => loadRecipeFile(root, "recipes.toml"), toml).toThrow(/recipes\.toml: \[/);
		}
	});

	it("treats an empty match list as vacuous and compares recipes by canonical argv", async () => {
		const root = await rootWithFiles({ "evals/recipes.toml": '[quiet]\ncmd = "npm test"\nmatch = []\n' });
		expect(loadRecipeFile(root, "recipes.toml")).toEqual([{ name: "quiet", cmd: "npm test" }]);
		expect(recipesEquivalent({ name: "q", cmd: "npm test" }, { name: "q", argv: ["npm", "test"] })).toBe(true);
		expect(recipesEquivalent({ name: "q", cmd: "npm test" }, { name: "q", cmd: "npm run test" })).toBe(false);
		expect(recipesEquivalent({ name: "q", cwd: "a", cmd: "npm test" }, { name: "q", cwd: "b", cmd: "npm test" })).toBe(false);
	});

	it("validates argv budgets directly: NUL, byte cap, and token cap", () => {
		expect(() => validateArgv(["no\0l"], "c")).toThrow(/NUL/);
		expect(() => validateArgv(["x".repeat(32 * 1024 + 1)], "c")).toThrow(/byte budget/);
		expect(() => cmdArgv("npm ".repeat(130) + "test", "c")).toThrow(/at most 128 tokens/);
	});
});

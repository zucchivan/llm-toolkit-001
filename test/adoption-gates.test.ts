import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRecipes } from "../src/engine/gates.ts";

describe("adopted gate recipe loading", () => {
	it("loads generated recipes and lets a human duplicate name override them", async () => {
		const root = await mkdtemp(join(tmpdir(), "kit-recipes-"));
		await mkdir(join(root, "evals"), { recursive: true });
		await writeFile(join(root, "evals", "recipes.auto.toml"), '[unit-test]\ncmd = "npm test"\ncwd = "packages/web"\n[generated-only]\ncmd = "npm run check"\n', "utf8");
		await writeFile(join(root, "evals", "recipes.toml"), '[unit-test]\ncmd = "npm run test:human"\n[build]\ncmd = "npm run build"\n', "utf8");

		const loaded = loadRecipes({ root } as never);
		expect(loaded.recipes).toMatchObject([
			{ name: "unit-test", cmd: "npm run test:human" },
			{ name: "generated-only", cmd: "npm run check" },
			{ name: "build", cmd: "npm run build" },
		]);
	});
});

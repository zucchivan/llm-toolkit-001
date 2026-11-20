import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeGates, type ProbePrompt } from "../src/adoption/probe.ts";

async function rootWithRecipe(recipe: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "kit-probe-"));
	await mkdir(join(root, "evals"), { recursive: true });
	await writeFile(join(root, "evals", "recipes.toml"), recipe, "utf8");
	return root;
}
const yes: ProbePrompt = { ask: async () => "y" };

describe("baseline gate probing", () => {
	it("requires separate execution consent and reports failures as pre-existing", async () => {
		const root = await rootWithRecipe('[test]\ncmd = "npm test"\n');
		let executions = 0;
		const runner = async () => { executions++; return { code: 1, stdout: "", stderr: "existing failure" }; };
		const skipped = await probeGates(root, { interactive: false, execute: runner });
		expect(skipped.consented).toBe(false);
		expect(executions).toBe(0);

		const probed = await probeGates(root, { interactive: false, confirmed: true, execute: runner });
		expect(probed.consented).toBe(true);
		expect(probed.allPassed).toBe(false);
		expect(probed.results[0]).toMatchObject({ name: "test", passed: false, exit: 1 });
		expect(probed.messages.join("\n")).toContain("pre-existing failure");
	});

	it("runs an approved workspace recipe in its recipe cwd", async () => {
		const root = await rootWithRecipe('[workspace-test]\ncmd = "node check.cjs"\ncwd = "packages/web"\n');
		await mkdir(join(root, "packages", "web"), { recursive: true });
		await writeFile(join(root, "packages", "web", "check.cjs"), "process.stdout.write(process.cwd())", "utf8");
		const result = await probeGates(root, { interactive: true, prompt: yes });
		expect(result.allPassed).toBe(true);
		expect(result.results[0]?.tail).toBe(join(root, "packages", "web"));
	});
});

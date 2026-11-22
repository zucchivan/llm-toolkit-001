import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refreshGates, diffRecipes, serializeRecipes, type AdoptionPrompt } from "../src/adoption/workflow.ts";
import { readJson } from "../src/util/fsx.ts";

async function project(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "kit-workflow-"));
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), content, "utf8");
	}
	return root;
}
const manifest = (scripts: Record<string, string>) => JSON.stringify({ name: "app", private: true, scripts });
class ScriptedPrompt implements AdoptionPrompt {
	constructor(private readonly answers: string[]) {}
	async ask(_question: string): Promise<string> {
		const answer = this.answers.shift();
		if (answer === undefined) throw new Error("unexpected prompt");
		return answer;
	}
}

describe("gate adoption workflow", () => {
	it("makes no changes in non-interactive mode without an explicit decision", async () => {
		const root = await project({ "package.json": manifest({ test: "node --test" }) });
		const result = await refreshGates(root, { interactive: false });
		expect(result.wroteRecipes).toBe(false);
		expect(result.wroteDecisions).toBe(false);
		expect(existsSync(join(root, "evals", "recipes.auto.toml"))).toBe(false);
		expect(existsSync(join(root, ".orch", "gate-decisions.json"))).toBe(false);
	});

	it("generates only after approval and preserves human-owned recipes", async () => {
		const root = await project({
			"package.json": manifest({ test: "node --test", build: "tsc" }),
			"evals/recipes.toml": '[custom]\ncmd = "npm run custom"\n',
		});
		const human = await readFile(join(root, "evals", "recipes.toml"), "utf8");
		const declined = await refreshGates(root, { interactive: true, prompt: new ScriptedPrompt(["a", "n"]) });
		expect(declined.wroteRecipes).toBe(false);
		expect(existsSync(join(root, "evals", "recipes.auto.toml"))).toBe(false);

		const approved = await refreshGates(root, { interactive: true, prompt: new ScriptedPrompt(["a", "y"]) });
		expect(approved.wroteRecipes).toBe(true);
		expect(approved.diff.additions.map((r) => r.name)).toEqual(["build", "unit-test"]);
		expect(await readFile(join(root, "evals", "recipes.toml"), "utf8")).toBe(human);
		expect(await readFile(join(root, "evals", "recipes.auto.toml"), "utf8")).toContain('cmd = "npm test"');
	});

	it("remembers deferrals and reopens them on meaningful evidence changes", async () => {
		const root = await project({ "package.json": manifest({ test: "node --test" }) });
		await refreshGates(root, { interactive: true, prompt: new ScriptedPrompt(["c", "s", "y"]) });
		const quiet = await refreshGates(root, { interactive: true, prompt: new ScriptedPrompt([]) });
		expect(quiet.messages.join("\n")).toContain("no open findings");
		const decisions = await readJson<any>(join(root, ".orch", "gate-decisions.json"));
		expect(decisions.decisions["unit-test"].decision).toBe("deferred");

		await writeFile(join(root, "package.json"), manifest({ test: "vitest run" }), "utf8");
		const reopened = await refreshGates(root, { interactive: true, prompt: new ScriptedPrompt(["s", "y"]) });
		expect(reopened.report.findings.find((f) => f.id === "unit-test")?.reopened).toBe(true);
	});

	it("shows changed commands in the refresh diff", async () => {
		const root = await project({ "package.json": manifest({ test: "node --test" }) });
		await refreshGates(root, { interactive: false, acceptRecommended: true });
		await writeFile(join(root, "package.json"), manifest({ "test:unit": "node --test" }), "utf8");
		const result = await refreshGates(root, { interactive: true, prompt: new ScriptedPrompt(["c", "a", "y"]) });
		expect(result.diff.changes).toHaveLength(1);
		expect(result.diff.changes[0]).toMatchObject({ before: { name: "unit-test", cmd: "npm test" }, after: { name: "unit-test", cmd: "npm run test:unit" } });
		expect(result.report.findings.find((f) => f.id === "unit-test")?.reopened).toBe(true);
	});

	it("reopens generated-command drift and shows the correction for approval", async () => {
		const root = await project({ "package.json": manifest({ test: "node --test" }) });
		await refreshGates(root, { interactive: false, acceptRecommended: true });
		await writeFile(join(root, "evals", "recipes.auto.toml"), '[unit-test]\ncmd = "npm run test:stale"\n', "utf8");

		const result = await refreshGates(root, { interactive: true, prompt: new ScriptedPrompt(["c", "a", "y"]) });
		expect(result.report.findings.find((f) => f.id === "unit-test")?.reopened).toBe(true);
		expect(result.diff.changes).toHaveLength(1);
		expect(result.diff.changes[0]).toMatchObject({ before: { name: "unit-test", cmd: "npm run test:stale" }, after: { name: "unit-test", cmd: "npm test" } });
	});

	it("supports evidence inspection and not-applicable reasons", async () => {
		const root = await project({ "package.json": manifest({ test: "node --test" }) });
		const inspected = await refreshGates(root, { interactive: true, prompt: new ScriptedPrompt(["i", "1", "c", "e", "a", "y"]) });
		expect(inspected.messages.join("\n")).toContain('script "test"');
		expect(inspected.wroteRecipes).toBe(true);

		const other = await project({ "package.json": manifest({ test: "node --test" }) });
		await refreshGates(other, { interactive: true, prompt: new ScriptedPrompt(["n", "unit-test", "covered by an external test service", "s", "y"]) });
		const stored = await readJson<any>(join(other, ".orch", "gate-decisions.json"));
		expect(stored.decisions["unit-test"]).toMatchObject({ decision: "not-applicable", reason: "covered by an external test service" });
		expect(existsSync(join(other, "evals", "recipes.auto.toml"))).toBe(false);
	});

	it("acknowledges new evidence when preserving a reasoned not-applicable decision", async () => {
		const root = await project({ "package.json": manifest({ test: "node --test" }) });
		await refreshGates(root, { interactive: true, prompt: new ScriptedPrompt(["n", "unit-test", "covered externally", "s", "y"]) });
		await writeFile(join(root, "package.json"), manifest({ test: "vitest run" }), "utf8");
		await refreshGates(root, { interactive: true, prompt: new ScriptedPrompt(["s", "y"]) });

		const quiet = await refreshGates(root, { interactive: false });
		expect(quiet.messages.join("\n")).toContain("no open findings");
		const stored = await readJson<any>(join(root, ".orch", "gate-decisions.json"));
		expect(stored.decisions["unit-test"]).toMatchObject({ decision: "not-applicable", reason: "covered externally" });
	});

	it("compares recipes by canonical argv, so a legacy cmd decision equals its argv twin", async () => {
		const cmdForm = { name: "unit-test", cmd: "npm test" };
		const argvForm = { name: "unit-test", argv: ["npm", "test"] };
		const diff = diffRecipes([cmdForm], [argvForm]);
		expect(diff).toEqual({ additions: [], changes: [], removals: [] });
		// A real difference in tokens is still a change.
		const changed = diffRecipes([cmdForm], [{ name: "unit-test", argv: ["npm", "run", "test"] }]);
		expect(changed.changes).toHaveLength(1);
	});

	it("serializes each command form canonically without re-quoting argv tokens", () => {
		const text = serializeRecipes([
			{ name: "unit-test", cmd: "npm test" },
			{ name: "render-args", argv: ["node", "bin/render.js", "/a/-b", "a b", ""], cwd: "packages/web" },
		]);
		expect(text).toContain('cmd = "npm test"');
		expect(text).toContain('argv = ["node","bin/render.js","/a/-b","a b",""]');
		expect(text).toContain('cwd = "packages/web"');
	});

	it("shows refresh removals for approval instead of silently deleting stale gates", async () => {
		const root = await project({ "package.json": manifest({ test: "node --test" }) });
		await refreshGates(root, { interactive: false, acceptRecommended: true });
		await writeFile(join(root, "package.json"), manifest({}), "utf8");
		const result = await refreshGates(root, { interactive: true, prompt: new ScriptedPrompt(["c", "n", "generated gate no longer has evidence", "y"]) });
		expect(result.diff.removals.map((r) => r.name)).toContain("unit-test");
		expect(await readFile(join(root, "evals", "recipes.auto.toml"), "utf8")).not.toContain("[unit-test]");
	});
});

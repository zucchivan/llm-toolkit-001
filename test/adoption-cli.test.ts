import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGatesCommand } from "../src/adoption/cli.ts";
import { formatRemediationBrief, loadApprovedRemediations } from "../src/engine/planner.ts";

async function project(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "kit-gates-cli-"));
	await writeFile(join(root, "package.json"), JSON.stringify({ name: "x", private: true, scripts: { test: "node --test" } }), "utf8");
	return root;
}
const io = () => ({ interactive: false, log: () => {}, error: () => {} });

describe("gates CLI safety and planning handoff", () => {
	it("does not adopt from a non-interactive invocation without an explicit decision", async () => {
		const root = await project();
		expect(await runGatesCommand(root, ["refresh"], io())).toBe(0);
		expect(existsSync(join(root, "evals", "recipes.auto.toml"))).toBe(false);
		expect(await runGatesCommand(root, ["refresh", "--accept", "recommended"], io())).toBe(0);
		expect(existsSync(join(root, "evals", "recipes.auto.toml"))).toBe(true);
	});

	it("feeds only approved remediations into the planner brief, not the PRD", async () => {
		const root = await project();
		const prdPath = join(root, "docs", "prd.md");
		await mkdir(join(root, "docs"), { recursive: true });
		await mkdir(join(root, ".orch"), { recursive: true });
		await writeFile(prdPath, "original PRD", "utf8");
		const remediation = { title: "Add browser journeys", spec: "Review and add critical journeys.", acceptance: ["A repeatable command exists."], targetPaths: ["e2e/"] };
		await writeFile(join(root, ".orch", "gate-remediations.json"), JSON.stringify({ version: 1, remediations: [remediation] }), "utf8");
		expect(await loadApprovedRemediations(root)).toEqual([remediation]);
		expect(formatRemediationBrief([remediation])).toContain("HUMAN-APPROVED GATE-GAP REMEDIATIONS");
		expect(formatRemediationBrief([])).toBe("");
		expect(await readFile(prdPath, "utf8")).toBe("original PRD");
	});
});

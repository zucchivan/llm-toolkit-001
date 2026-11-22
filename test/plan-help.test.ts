import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initProject } from "../src/init.ts";
import { demoConfigToml, prepareDemoProject, writeConfig } from "./demo-project.ts";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const kitCli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function runCli(root: string, args: string[], replay?: string) {
	return execFileAsync(process.execPath, [tsxCli, kitCli, ...args], {
		cwd: root,
		env: {
			...process.env,
			NO_COLOR: "1",
			KIT_FAUX: "1",
			...(replay ? { KIT_FAUX_SCRIPT: replay } : {}),
		},
		timeout: 30_000,
	});
}

describe("plan review guidance", () => {
	it("reviews the mirror and directs changes through the PRD and a replan", async () => {
		const project = await prepareDemoProject();
		await initProject(project.root);
		await writeConfig(project.root, demoConfigToml());
		const replay = join(project.root, "plan.replay");
		await writeFile(replay, `[planner]
{"tasks":[{"id":"one-task","title":"One task","spec":"Implement one task.","dependsOn":[],"acceptance":["When the task runs, the system shall satisfy its criterion."],"targetPaths":["src/"],"priority":0}]}
`, "utf8");

		const { stdout } = await runCli(project.root, ["plan"], replay);

		expect(stdout).toContain("PLANNED");
		expect(stdout).toContain("review router.md (a generated mirror, not editable plan input)");
		expect(stdout).toContain("revise the PRD and rerun llm-toolkit-001 plan");
		expect(stdout).toContain("llm-toolkit-001 run --approve");
		expect(stdout).not.toContain("edit router.md");
	}, 40_000);

	it("keeps approval on run and does not advertise a plan --approve command", async () => {
		const { stdout } = await runCli(process.cwd(), ["--help"]);

		expect(stdout).toContain("plan [--prd path]");
		// M0-P05: approval names the plan revision (no hidden default revision).
		expect(stdout).toContain("run --approve --revision <uuid>");
		expect(stdout).toContain("resume the stored grant");
		expect(stdout).not.toContain("plan --approve");
	}, 40_000);
});

/** Why does the router.md mirror mismatch at gate time? (one-off) */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareDemoProject, writeConfig, demoConfigToml, gitInit } from "./demo-project.ts";
import { openProjectHarness } from "../src/engine/harness.ts";
import { readSessionState } from "../src/engine/state.ts";
import { loadPrd, runPlan } from "../src/engine/planner.ts";
import { renderRouterMd } from "../src/engine/infos.ts";
import { buildFauxModels, fauxAssistantMessage } from "./fixtures.ts";

const LIST_SPEC = JSON.stringify({
	tasks: [{ id: "t1", title: "one", spec: "Add src/list.ts with parseList().", dependsOn: [], acceptance: ["When parseList receives '', the system shall produce []."], targetPaths: ["src/"], priority: 1 }],
});

const project = await prepareDemoProject();
await writeConfig(project.root, demoConfigToml());
await gitInit(project.root);
const { models, faux } = buildFauxModels([fauxAssistantMessage(LIST_SPEC, { stopReason: "stop" })]);

const planKit = await openProjectHarness(project.root, "debug-plan", { modelsOverride: models });
const prdText = await loadPrd(planKit);
await runPlan(planKit, "docs/prd.md", prdText);
await planKit.loop.close();
planKit.lock.release();

const kit = await openProjectHarness(project.root, "debug-run", { modelsOverride: models });
const state1 = await readSessionState(kit.loop.harness);
const mirror1 = renderRouterMd(state1.router.tasks, state1.router.phase, state1.runStatus.prdPath);
const file1 = await readFile(join(project.root, "router.md"), "utf8");

// simulate the baseline commit like the driver does
import { captureBaselineTree } from "../src/util/git.ts";
import { commitState } from "../src/engine/state.ts";
const baseline = await captureBaselineTree(project.root);
await commitState(kit, {
	router: (d) => {
		const t = d.tasks.find((x) => x.id === "t1")!;
		t.baselineTreeSha = baseline;
	},
	rows: [{ ts: Date.now(), kind: "task", task: "t1", verb: "baseline", detail: baseline }],
});
const state2 = await readSessionState(kit.loop.harness);
const mirror2 = renderRouterMd(state2.router.tasks, state2.router.phase, state2.runStatus.prdPath);
const file2 = await readFile(join(project.root, "router.md"), "utf8");

console.log("before baseline: mirror===file?", mirror1 === file1);
console.log("after  baseline: mirror===file?", mirror2 === file2);
if (mirror2 !== file2) {
	console.log("--- mirror:", JSON.stringify(mirror2));
	console.log("--- file:", JSON.stringify(file2));
}
await kit.loop.close();
kit.lock.release();

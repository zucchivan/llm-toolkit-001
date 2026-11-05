/** replicate smoke in tsx for readable state dumps */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { prepareDemoProject, writeConfig, demoConfigToml, gitInit } from "./demo-project.ts";
import { openProjectHarness } from "../src/engine/harness.ts";
import { readSessionState, commitState } from "../src/engine/state.ts";
import { loadPrd, runPlan } from "../src/engine/planner.ts";
import { runWaves } from "../src/engine/waves.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { initProject } from "../src/init.ts";

const LIST_TS = `export function parseList(input: string): string[] {
	return input.split("/").flatMap((part) => part.split(",")).map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith("-"));
}
export function renderList(items: string[]): string {
	return items.join(" ");
}
`;
const BIN_JS = `#!/usr/bin/env node
import { parseList, renderList } from "../src/list.ts";
console.log(renderList(parseList(process.argv[2] ?? "")));
`;
const GATE_JS = `// gate: fail while any src file contains BROKEN
const fs = require("node:fs");
const files = fs.readdirSync("src", { withFileTypes: true }).flatMap((e) => e.isFile() && e.name.endsWith(".ts") ? [fs.readFileSync("src/" + e.name, "utf8")] : []);
if (files.some((text) => text.includes("BROKEN"))) { console.error("BROKEN src"); process.exit(1); }
`;
const implWrites = (xs: [string, string][]) => [...xs.map(([path, content]) => fauxAssistantMessage([fauxToolCall("write", { path, content })], { stopReason: "toolUse" })), fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" })];
const verifyApprove = () => fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass" }], notes: "diff satisfies the criterion" }), { stopReason: "stop" });

const project = await prepareDemoProject();
await writeConfig(project.root, demoConfigToml());
await gitInit(project.root);
await mkdir(join(project.root, "bin"), { recursive: true });
await writeFile(join(project.root, "eval-gate.cjs"), GATE_JS, "utf8");
await writeFile(join(project.root, "evals", "recipes.toml"), `[no-broken-token]\ncmd = "node eval-gate.cjs"\n`, "utf8");
await initProject(project.root);

const { models, faux } = buildFauxModels([]);
faux.appendResponses([
	fauxAssistantMessage(JSON.stringify({
		tasks: [
			{ id: "list-parse", title: "parse + render", spec: "src/list.ts parseList/renderList.", dependsOn: [], acceptance: ["crit1"], targetPaths: ["src/"], priority: 2 },
			{ id: "list-query", title: "query", spec: "queryList case-insensitive filter.", dependsOn: ["list-parse"], acceptance: ["crit2"], targetPaths: ["src/"], priority: 1 },
			{ id: "cli-render", title: "bin", spec: "bin/render.js prints the list.", dependsOn: ["list-query"], acceptance: ["crit3"], targetPaths: ["bin/"], priority: 0 },
		],
	}), { stopReason: "stop" }),
	...implWrites([["src/list.ts", LIST_TS]]),
	verifyApprove(),
	// task 2 wave1 BROKEN
	...implWrites([["src/list.ts", LIST_TS + "\nexport const BROKEN = true;\n"]]),
	// task 2 wave2 fixes both files
	...implWrites([
		["src/list.ts", LIST_TS],
		["src/query.ts", "export function queryList(items: string[], q: string): string[] {\n\treturn items.filter((i) => i.toLowerCase().includes(q.toLowerCase()));\n}\n"],
	]),
	verifyApprove(),
	...implWrites([["bin/render.js", BIN_JS]]),
	verifyApprove(),
]);

const planKit = await openProjectHarness(project.root, "smoke-debug-plan", { modelsOverride: models });
const prdText = await loadPrd(planKit);
await runPlan(planKit, "docs/prd.md", prdText);
await planKit.loop.close();
planKit.lock.release();

const kit = await openProjectHarness(project.root, "smoke-debug-run", { modelsOverride: models });
await commitState(kit, { runStatus: (d) => { d.humanApprovedAt = Date.now(); } });
const summary = await runWaves(kit, { approve: true, tasksFilter: [] }, (e) => console.log("event:", JSON.stringify(e).slice(0, 150)));
console.log("SUMMARY:", JSON.stringify(summary));
console.log("faux pending:", faux.getPendingResponseCount());
const state = await readSessionState(kit.loop.harness);
console.log("tasks:", state.router.tasks.map((t) => ({ id: t.id, status: t.status, wave: t.waveCount })));
console.log("rows:", state.rows.map((r) => `${r.kind}:${r.task}/w${r.wave ?? "?"} ${r.verb}${r.reason ? ` (${r.reason})` : ""}${r.detail ? ` — ${String(r.detail).slice(0, 100)}` : ""}`));
await kit.loop.close();
kit.lock.release();
console.log(`proj: ${project.root}`);

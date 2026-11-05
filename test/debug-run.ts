/** One-off: replicate smoke failure and dump state. NOT part of the suite. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareDemoProject, writeConfig, demoConfigToml, gitInit } from "./demo-project.ts";
import { openProjectHarness } from "../src/engine/harness.ts";
import { readSessionState, commitState } from "../src/engine/state.ts";
import { loadPrd, runPlan } from "../src/engine/planner.ts";
import { runWaves } from "../src/engine/waves.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";

const LIST_TS = "export function parseList(input: string): string[] {\n\treturn input.split('/').flatMap((p) => p.split(',')).map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith('-'));\n}\n";
const implWrites = (xs: [string, string][]) => [...xs.map(([path, content]) => fauxAssistantMessage([fauxToolCall("write", { path, content })], { stopReason: "toolUse" })), fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" })];
const verifyApprove = (notes = "diff satisfies the criterion") =>
	fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass" }], notes }), { stopReason: "stop" });

const GATE_JS = 'const fs = require("node:fs");\nconst files = fs.readdirSync("src", { withFileTypes: true }).flatMap((e) => e.isFile() && e.name.endsWith(".ts") ? [fs.readFileSync("src/" + e.name, "utf8")] : []);\nif (files.some((text) => text.includes("BROKEN"))) {\n\tconsole.error("src contains the BROKEN token");\n\tprocess.exit(1);\n}\n';

const project = await prepareDemoProject();
await writeConfig(project.root, demoConfigToml() + "\n");
await gitInit(project.root);
const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync(join(project.root, "bin"), { recursive: true });
writeFileSync(join(project.root, "eval-gate.cjs"), GATE_JS);
writeFileSync(join(project.root, "evals", "recipes.toml"), '[no-broken-token]\ncmd = "node eval-gate.cjs"\n');

const { models, faux } = buildFauxModels([]);
faux.appendResponses([
	fauxAssistantMessage(JSON.stringify({ tasks: [
		{ id: "t1", title: "one", spec: "Add src/list.ts with parseList().", dependsOn: [], acceptance: [" criterion "], targetPaths: ["src/"], priority: 1 },
		{ id: "t2", title: "two", spec: "Add src/query.ts.", dependsOn: ["t1"], acceptance: [" criterion2 "], targetPaths: ["src/"], priority: 0 },
	] }), { stopReason: "stop" }),
	...implWrites([["src/list.ts", LIST_TS]]),
	verifyApprove(),
	...implWrites([["src/list.ts", LIST_TS + "\nexport const BROKEN = true;\n"]]),
	...implWrites([
		["src/list.ts", LIST_TS],
		["src/query.ts", "export function queryList(items: string[], q: string): string[] {\n\treturn items.filter((i) => i.toLowerCase().includes(q.toLowerCase()));\n}\n"],
	]),
	verifyApprove(),
]);

const planKit = await openProjectHarness(project.root, "debug-plan", { modelsOverride: models });
const prdText = await loadPrd(planKit);
await runPlan(planKit, "docs/prd.md", prdText);
await planKit.loop.close();
planKit.lock.release();

const kit = await openProjectHarness(project.root, "debug-run", { modelsOverride: models });
await commitState(kit, { runStatus: (d) => { d.humanApprovedAt = Date.now(); } });
const summary = await runWaves(kit, { approve: true, tasksFilter: [] }, (e) => console.log("event:", e.kind, JSON.stringify(e).slice(0, 110)));
console.log("SUMMARY:", JSON.stringify(summary));
console.log("faux pending:", faux.getPendingResponseCount());

const state = await readSessionState(kit.loop.harness);
console.log("tasks:", state.router.tasks.map((t) => ({ id: t.id, status: t.status, wave: t.waveCount, fb: t.feedback.map((f) => f.from + ":" + f.text.slice(0, 60)) })));
console.log("rows:", state.rows.filter(r => r.kind !== "wave").map((r) => `${r.kind}:${r.task}/w${r.wave ?? "?"} ${r.verb}${r.reason ? ` (${r.reason})` : ""}${r.detail ? ` — ${String(r.detail).slice(0, 80)}` : ""}`));
const waveLog = await readFile(join(project.root, ".orch", "wave-log.jsonl"), "utf8").catch(() => "(none)");
console.log("waveLog tail:\n" + waveLog.split("\n").slice(-10).join("\n"));
await kit.loop.close();
kit.lock.release();
console.log(`proj: ${project.root}`);

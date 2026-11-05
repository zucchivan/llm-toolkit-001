/** one-off: probe KIT_FAUX run path in-process */
import { prepareDemoProject } from "./demo-project.ts";
import { openProjectHarness } from "../src/engine/harness.ts";
import { maybeFauxModels } from "../src/engine/faux-replay.ts";
import { readSessionState, commitState } from "../src/engine/state.ts";
import { loadPrd, runPlan } from "../src/engine/planner.ts";
import { runWaves } from "../src/engine/waves.ts";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const { writeConfig, gitInit } = await import("./demo-project.ts");
const project = await prepareDemoProject();
await writeConfig(project.root, (await import("./demo-project.ts")).demoConfigToml());
await (await import("./demo-project.ts")).gitInit(project.root);
await mkdir(join(project.root, "evals"), { recursive: true });
await mkdir(join(project.root, "bin"), { recursive: true });
await writeFile(join(project.root, "eval-gate.cjs"), "process.exit(0);\n", "utf8");
await writeFile(join(project.root, "evals", "recipes.toml"), "[ok]\ncmd = \"node eval-gate.cjs\"\n", "utf8");
process.env["KIT_FAUX"] = "1";
process.env["KIT_FAUX_SCRIPT"] = `${project.root}/.smoke.replay`;

await writeFile(join(project.root, ".smoke.replay"), [
	JSON.stringify({ tasks: [{ id: "t1", title: "one", spec: "s", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 }] }),
	JSON.stringify({ tool: "write", path: "src/list.ts", content: "export const x = 1;\n" }),
	"STATUS: COMPLETE",
	JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass" }], notes: "" }),
].join("\n---\n"), "utf8");

const replay = maybeFauxModels()!;
const kit = await openProjectHarness(project.root, "probe", { modelsOverride: replay.models as never });

const prd = await loadPrd(kit);
await runPlan(kit, "docs/prd.md", prd);
await commitState(kit, { runStatus: (d) => { d.humanApprovedAt = Date.now(); } });
const summary = await runWaves(kit, { approve: true, tasksFilter: [] });
console.log("summary:", summary);
const state = await readSessionState(kit.loop.harness);
console.log("tasks:", state.router.tasks.map((t) => ({ id: t.id, status: t.status, wave: t.waveCount })));
console.log("rows govern/task:", state.rows.filter((r) => r.kind !== "wave").map((r) => `${r.kind}:${r.task} ${r.verb} ${r.reason ?? ""}`).join(" | "));
console.log("list contents:", await import("node:fs/promises").then(fs => fs.readFile(join(project.root, "src", "list.ts"), "utf8").catch(() => "<absent>")));
await kit.loop.close();
kit.lock.release();
console.log("proj:", project.root);

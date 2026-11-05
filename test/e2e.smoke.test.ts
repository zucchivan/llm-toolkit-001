/**
 * e2e.smoke (§7): fixture PRD (examples/demo-prd) → REAL plan → run --approve
 * with scripted faux outputs, verifying RouterDoc transitions, router.md sync,
 * .orch/status.json updates, and .orch/wave-log.jsonl rows. Task 2 fails its
 * gate on wave 1, undergoes conversation.reset(), and passes on wave 2.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { initProject } from "../src/init.ts";
import { openProjectHarness } from "../src/engine/harness.ts";
import { readSessionState, commitState } from "../src/engine/state.ts";
import { loadPrd, runPlan, parsePlannerJson, normalizeTasks, parseVerdictStrict, ensureAcyclic } from "../src/engine/planner.ts";
import { runWaves } from "../src/engine/waves.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { prepareDemoProject, writeConfig, demoConfigToml, gitInit } from "./demo-project.ts";
import { readJson, atomicWriteJson } from "../src/util/fsx.ts";

const LIST_TS = `export function parseList(input: string): string[] {
	return input.split("/").flatMap((part) => part.split(",")).map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith("-"));
}
export function renderList(items: string[]): string {
	return items.join(" ");
}
`;
const QUERY_TS = `type $Unused = never;
export function queryList(items: string[], q: string): string[] {
	const needle = q.toLowerCase();
	return items.filter((item) => item.toLowerCase().includes(needle));
}
void $.typeof;
`;
void QUERY_TS;

const BIN_JS = `#!/usr/bin/env node
import { parseList, renderList } from "../src/list.ts";
console.log(renderList(parseList(process.argv[2] ?? "")));
`;

const GATE_JS = `// gate script: fail while any src file contains the BROKEN token
const fs = require("node:fs");
const files = fs.readdirSync("src", { withFileTypes: true }).flatMap((e) => e.isFile() && e.name.endsWith(".ts") ? [fs.readFileSync("src/" + e.name, "utf8")] : []);
if (files.some((text) => text.includes("BROKEN"))) {
	console.error("src contains the BROKEN token");
	process.exit(1);
}
`;

const PLANNER_TASKS = {
	tasks: [
		{ id: "list-parse", title: "parseList + renderList", spec: "Add src/list.ts with parseList() and renderList().", dependsOn: [], acceptance: ["When parseList receives '/foo/bar baz,-qux', the system shall produce ['foo','bar baz','qux']."], targetPaths: ["src/"], priority: 2 },
		{ id: "list-query", title: "queryList filter", spec: "Add queryList(list, q) filtering case-insensitively.", dependsOn: ["list-parse"], acceptance: ["When queryList is called with 'BAZ', the system shall return entries containing 'baz' ignoring case."], targetPaths: ["src/"], priority: 1 },
		{ id: "cli-render", title: "bin/render.js", spec: "bin/render.js prints renderList(parseList(text)).", dependsOn: ["list-query"], acceptance: ["When bin/render.js runs with '/a/-b', the system shall print 'a b'."], targetPaths: ["bin/"], priority: 0 },
	],
};

const implWrites = (writes: { path: string; content: string }[], closing = "STATUS: COMPLETE") => writes.map((w) => fauxAssistantMessage([fauxToolCall("write", w)], { stopReason: "toolUse" })).concat([fauxAssistantMessage(closing, { stopReason: "stop" })]);
const verifyApprove = (notes = "diff satisfies the criterion") =>
	fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass" }], notes }), { stopReason: "stop" });

describe("e2e smoke: fixture plan → run --approve (scripted faux)", () => {
	beforeEach(() => {
		process.env["NO_COLOR"] = "1";
	});

	it("plan → 3 tasks (2 with a failing first wave) → complete, with mirrors + status + wave log", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await gitInit(project.root);
		await mkdir(join(project.root, "bin"), { recursive: true });
		await writeFile(join(project.root, "eval-gate.cjs"), GATE_JS, "utf8");
		await writeFile(
			join(project.root, "evals", "recipes.toml"),
			`[no-broken-token]\ncmd = "node eval-gate.cjs"\n`,
			"utf8",
		);
		await initProject(project.root);

		const { models, faux } = buildFauxModels([]);
		faux.appendResponses([
			// PLAN
			fauxAssistantMessage(JSON.stringify(PLANNER_TASKS), { stopReason: "stop" }),
			// task 1 (list-parse) wave 1
			...implWrites([{ path: "src/list.ts", content: LIST_TS }]),
			verifyApprove(),
			// task 2 (list-query) wave 1: BROKEN write → gate fails → feedback
			...implWrites([{ path: "src/list.ts", content: LIST_TS + "\nexport const BROKEN = true;\n" }]),
			// task 2 wave 2 (after conversation.reset): fixed file + new query module
			...implWrites([
				{ path: "src/list.ts", content: LIST_TS },
				{ path: "src/query.ts", content: `export function queryList(items: string[], q: string): string[] {\n\tconst needle = q.toLowerCase();\n\treturn items.filter((item) => item.toLowerCase().includes(needle));\n}\n` },
			]),
			verifyApprove(),
			// task 3 (cli-render) wave 1
			...implWrites([{ path: "bin/render.js", content: BIN_JS }]),
			verifyApprove(),
		]);

		// PLAN ---------------------------------------------------------------
		const planKit = await openProjectHarness(project.root, "plan", { modelsOverride: models });
		const prdText = await loadPrd(planKit);
		const planOutcome = await runPlan(planKit, "docs/prd.md", prdText);
		expect(planOutcome.tasks.map((t) => t.id)).toEqual(["list-parse", "list-query", "cli-render"]);
		await planKit.loop.close();
		planKit.lock.release();

		const routerMd = await readFile(join(project.root, "router.md"), "utf8");
		expect(routerMd).toContain("list-parse");
		expect(routerMd).toContain("STATUS: PLANNED");

		// APPROVE + RUN ------------------------------------------------------
		const kit = await openProjectHarness(project.root, "run", { modelsOverride: models });
		await commitState(kit, {
			runStatus: (d) => {
				d.humanApprovedAt = Date.now();
			},
		});
		const summary = await runWaves(kit, { approve: true, tasksFilter: [] });
		expect(summary.complete).toBe(true);

		// RouterDoc transitions ----------------------------------------------
		const state = await readSessionState(kit.loop.harness);
		const tasks = new Map(state.router.tasks.map((t) => [t.id, t]));
		expect(tasks.get("list-parse")?.status).toBe("done");
		expect(tasks.get("list-parse")?.waveCount).toBe(1);
		// task 2: wave 1 failed the gate, wave 2 fixed it
		const t2 = tasks.get("list-query");
		expect(t2?.status).toBe("done");
		expect(t2?.waveCount).toBe(2);
		expect(t2?.feedback.some((fb) => fb.from === "gate")).toBe(true);
		expect(tasks.get("cli-render")?.status).toBe("done");

		// paper trail --------------------------------------------------------
		const routerMdAfter = await readFile(join(project.root, "router.md"), "utf8");
		expect(routerMdAfter).toContain("STATUS: COMPLETE — task queue drained");
		expect(routerMdAfter).toContain("done");

		const waveLog = await readFile(join(project.root, ".orch", "wave-log.jsonl"), "utf8");
		const rows = waveLog
			.trim()
			.split("\n")
			.map((r) => JSON.parse(r) as Record<string, unknown>);
		expect(rows.some((r) => r["verb"] === "planned")).toBe(true);
		expect(rows.some((r) => r["kind"] === "gate" && r["verb"] === "fail")).toBe(true);
		expect(rows.some((r) => r["kind"] === "verdict" && r["verdict"] === "approve")).toBe(true);
		expect(rows.filter((r) => r["kind"] === "task" && r["verb"] === "done").length).toBe(3);

		const status = await readJson<{ tasks: { id: string; status: string }[] }>(join(project.root, ".orch", "status.json"));
		expect(status?.tasks.filter((t) => t.status === "done").length).toBe(3);

		// implementer artifacts actually landed
		expect(await readFile(join(project.root, "src", "list.ts"), "utf8")).toContain("parseList");
		expect(await readFile(join(project.root, "src", "query.ts"), "utf8")).toContain("queryList");
		expect(await readFile(join(project.root, "bin", "render.js"), "utf8")).toContain("renderList");
		expect((await readFile(join(project.root, "src", "list.ts"), "utf8")).includes("BROKEN")).toBe(false);

		await kit.loop.close();
		kit.lock.release();
	});

	it("handoff note queued by another process is ingested at the next wave and the file is removed", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await gitInit(project.root);
		await mkdir(join(project.root, "bin"), { recursive: true });
		await writeFile(join(project.root, "eval-gate.cjs"), "process.exit(0);\n", "utf8");
		await writeFile(join(project.root, "evals", "recipes.toml"), "[never-fails]\ncmd = \"node eval-gate.cjs\"\n", "utf8");
		await initProject(project.root);

		const { models, faux } = buildFauxModels([]);
		// planner | impl write | impl answer | 1 verifier approve
		faux.setResponses([
			fauxAssistantMessage(JSON.stringify({ tasks: [{ id: "t1", title: "one", spec: "write src/one.ts", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 }] }), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/one.ts", content: "export const one = 1;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass" }], notes: "" }), { stopReason: "stop" }),
		]);

		const kit = await openProjectHarness(project.root, "test", { modelsOverride: models });
		const { loadPrd, runPlan } = await import("../src/engine/planner.ts");
		await runPlan(kit, "docs/prd.md", await loadPrd(kit));

		// Queue the note exactly like the `handoff` CLI does (atomic side-car).
		await atomicWriteJson(kit.loop.paths.pendingHandoff, { ts: Date.now(), notes: ["keep tree clean"] });

		await runWaves(kit, { approve: true, tasksFilter: [] });
		const dumped = await readSessionState(kit.loop.harness);
		expect(dumped.rows.some((r) => r.kind === "handoff" && r.verb === "handoff-ingested" && (r.detail ?? "").includes("keep tree clean"))).toBe(true);
		// The handoff file is removed after ingestion (single process lock respected).
		await kit.loop.close();
		kit.lock.release();
		await expect(readFile(join(project.root, ".orch", "pending-handoff.json"), "utf8")).rejects.toThrow();
	});

	it("lock refusal: a live lock owner blocks a second open (polite error, exit 1)", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		const first = await openProjectHarness(project.root, "run", { modelsOverride: buildFauxModels([]).models });
		await expect(openProjectHarness(project.root, "status", { modelsOverride: buildFauxModels([]).models })).rejects.toThrow(/owns .*lock|busy/s);
		first.loop.close();
		first.lock.release();
	});

});

export { parsePlannerJson, normalizeTasks, parseVerdictStrict, ensureAcyclic };

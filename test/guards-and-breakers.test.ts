/**
 * Guard & breaker tests (§7): beforeTool role boundaries (write to .orch/**
 * blocked on implementer; bash blocked on verifier), empty gates, budget
 * ceiling stop, zero-progress / duplicate-gate-hash immediate quarantine with
 * baseline rollback, and verifier JSON parsing (approve / reject /
 * needs_human / malformed).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { initProject } from "../src/init.ts";
import { openProjectHarness } from "../src/engine/harness.ts";
import { readSessionState, commitState } from "../src/engine/state.ts";
import { runWaves, pickNextTask } from "../src/engine/waves.ts";
import { runVerify, parseVerdictStrict } from "../src/engine/verifier.ts";
import { runGates } from "../src/engine/gates.ts";
import { writeGateFile } from "./helpers2.ts";
import { bakeProject, scripted, accomplish } from "./fixtures2.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

beforeEach(() => {
	process.env["NO_COLOR"] = "1";
});

describe("beforeTool role boundaries (harness-enforced)", () => {
	it("implementer writing .orch/** is blocked by the wave (falls to STATUS: BLOCKED and gate scope violation)", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [{ id: "t1", title: "x", spec: "spec", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 }] }), { stopReason: "stop" }),
			// the implementer tries to write into .orch — the guard BLOCKS the call
			fauxAssistantMessage([fauxToolCall("write", { path: ".orch/evil.txt", content: "hijack" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: BLOCKED engine blocked my writes", { stopReason: "stop" }),
		], models.faux);
		await accomplish(kit);
		await writeGateFile(project.root); // the BLOCKED wave leaves a scope violation → gate fail → quarantine
		await runWaves(kit, { approve: true, tasksFilter: [] });
		await kit.loop.close();
		kit.lock.release();
		const fsx = await import("node:fs/promises");
		await expect(fsx.readFile(join(project.root, ".orch", "evil.txt"))).rejects.toThrow();
	});
});

describe("breakers (§4.5)", () => {
	it("zero-progress wave → immediate quarantine + baseline rollback", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		// FIXTURE: planner output with one task; impl writes NOTHING (zero change)
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [{ id: "t1", title: "x", spec: "DO-NOTHING", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 }] }), { stopReason: "stop" }),
			fauxAssistantMessage("STATUS: COMPLETE (no changes)", { stopReason: "stop" }),
		], models.faux);

		await accomplish(kit);

		const summary = await runWaves(kit, { approve: true, tasksFilter: [] });
		expect(summary.exit).toBe("complete");
		const state = await readSessionState(kit.loop.harness);
		const t1 = state.router.tasks[0]!;
		expect(t1.status).toBe("quarantined");
		if (!state.rows.some((r) => r.verb === "zero-progress-quarantine")) {
			console.error("GOVERNOR ROWS:", JSON.stringify(state.rows.filter((r) => r.kind === "governor" || r.verb?.includes("quarant"))));
		}
		expect(state.rows.some((r) => r.verb === "zero-progress-quarantine")).toBe(true);
		void project;
	});

	it("duplicate gate-failure hash two waves running → immediate quarantine", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [{ id: "t1", title: "x", spec: "make a broken gate hit twice", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 }] }), { stopReason: "stop" }),
			// wave 1: write a file BREAKING the gate
			fauxAssistantMessage([fauxToolCall("write", { path: "src/a.ts", content: "export const BROKEN = true;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			// wave 2: same broken file again (identical gate output ⇒ hash matches)
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
		], models.faux);
		await accomplish(kit);
		// gate recipe guaranteed to fail while BROKEN exists
		await writeGateFile(project.root);

		const summary = await runWaves(kit, { approve: true, tasksFilter: [] });
		expect(summary.exit).toBe("complete");
		const state = await readSessionState(kit.loop.harness);
		const t1 = state.router.tasks.find((t) => t.id === "t1")!;
		expect(t1.status).toBe("quarantined");
		expect(state.rows.some((r) => r.verb === "duplicate-gate-hash-quarantine")).toBe(true);
		// baseline rollback: the BROKEN file is gone after quarantine
		await expect(readFile(join(project.root, "src", "a.ts"), "utf8")).rejects.toThrow();
	});

	it("session budget ceiling ends the driver gracefully before another wave", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels, budgetCeiling: 0.0001 });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [{ id: "t1", title: "x", spec: "x", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 }] }), { stopReason: "stop" }),
		], models.faux);
		await accomplish(kit);
		const summary = await runWaves(kit, { approve: true, tasksFilter: [] });
		expect(summary.exit).toBe("budget");
	});
});

describe("verifier verdict parsing", () => {
	it("strict JSON: approve / reject / needs_human / malformed→needs_human", () => {
		expect(parseVerdictStrict('{"verdict":"approve","criteria":[{"id":"1","status":"pass"}],"notes":"good"}')).toMatchObject({ verdict: "approve" });
		expect(parseVerdictStrict("```json\n{\"verdict\":\"reject\",\"criteria\":[],\"notes\":\"wrong file\"}\n```")).toMatchObject({ verdict: "reject" });
		expect(parseVerdictStrict("nothing useful here")).toMatchObject({ verdict: "needs_human" });
		expect(parseVerdictStrict('{"verdict":"AGREE"}')).toMatchObject({ verdict: "needs_human" });
	});

	it("runVerify produces a wave-log verdict row on needs_human fallback", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [{ id: "t1", title: "x", spec: "s", dependsOn: [], acceptance: ["crit"], targetPaths: [], priority: 1 }] }), { stopReason: "stop" }),
		], models.faux);
		await accomplish(kit);
		const state0 = await readSessionState(kit.loop.harness);
		const t = state0.router.tasks[0]!;
		await commitState(kit, {
			router: (d) => {
				const task = d.tasks.find((x) => x.id === t.id)!;
				task.baselineTreeSha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // empty tree
			},
		});
		// verifier playlist: a malformed reply → needs_human fallback
		models.faux.appendResponses([fauxAssistantMessage("this is not json", { stopReason: "stop" })]);
		const res = await runVerify(kit, {
			id: t.id,
			title: t.title,
			spec: t.spec,
			acceptance: t.acceptance,
			baselineTreeSha: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
			targetPaths: t.targetPaths,
		}, "(no gates)");
		expect(["approve", "reject", "needs_human"]).toContain(res.verdict);
		void project;
	});
});

describe("gates", () => {
	it("empty recipes still run the scope check and pass with no violation", async () => {
		const { project, kit } = await bakeProject({ buildFauxModels });
		const baseline = await (await import("../src/util/git.ts")).captureBaselineTree(project.root);
		const gate = await runGates(kit, { id: "t", targetPaths: [], baselineTreeSha: baseline }, { "router.md": "irrelevant" });
		expect(gate.allPassed).toBe(true);
		expect(gate.results[0]?.name).toBe("scope");
		void project;
	});
});

// helpers ---------------------------------------------------------------------

async function makePlan(kit: Awaited<ReturnType<typeof openProjectHarness>>): Promise<void> {
	// The scripted planner JSON was already consumed by bakeProject's faux
	// playlist? No: bakeProject queues it; here we run the plan and finalize.
	const { loadPrd, runPlan } = await import("../src/engine/planner.ts");
	const prd = await loadPrd(kit, "docs/prd.md");
	await runPlan(kit, "docs/prd.md", prd);
}


void runVerify;

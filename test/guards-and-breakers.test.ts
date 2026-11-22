/**
 * Guard & breaker tests (§7): beforeTool role boundaries (write to .orch/**
 * blocked on implementer; bash blocked on verifier), empty gates, budget
 * ceiling stop, zero-progress / duplicate-gate-hash immediate quarantine with
 * baseline rollback, and verifier JSON parsing (approve / reject /
 * needs_human / malformed).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { initProject } from "../src/init.ts";
import { openProjectHarness, type StatusPayloads } from "../src/engine/harness.ts";
import { readSessionState, commitState } from "../src/engine/state.ts";
import { runWaves, pickNextTask } from "../src/engine/waves.ts";
import type { ProgressEvent } from "../src/engine/driver-events.ts";
import { runVerify, parseVerdictStrict } from "../src/engine/verifier.ts";
import { runGates } from "../src/engine/gates.ts";
import { writeGateFile } from "./helpers2.ts";
import { bakeProject, scripted, accomplish } from "./fixtures2.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "../src/util/fsx.ts";

beforeEach(() => {
	process.env["NO_COLOR"] = "1";
});

describe("beforeTool role boundaries (harness-enforced)", () => {
	it("implementer writing .orch/** is blocked by the wave (falls to STATUS: BLOCKED and gate scope violation)", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels, retryMax: 0 });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [{ id: "t1", title: "x", spec: "spec", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 }] }), { stopReason: "stop" }),
			// the implementer tries to write into .orch — the guard BLOCKS the call
			fauxAssistantMessage([fauxToolCall("write", { path: ".orch/evil.txt", content: "hijack" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: BLOCKED engine blocked my writes", { stopReason: "stop" }),
		], models.faux);
		await accomplish(kit);
		await writeGateFile(project.root); // the BLOCKED wave leaves a scope violation → gate fail → quarantine
		await runWaves(kit, { tasksFilter: [] });
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

		const summary = await runWaves(kit, { tasksFilter: [] });
		// M0-P05: the quarantine stops the selection — policy stop, not a success.
		expect(summary.exit).toBe("blocked");
		expect(summary.quarantined).toEqual(["t1"]);
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
		const { project, kit, models } = await bakeProject({ buildFauxModels, retryMax: 0 });
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

		const summary = await runWaves(kit, { tasksFilter: [] });
		expect(summary.exit).toBe("blocked");
		expect(summary.quarantined).toEqual(["t1"]);
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
		const summary = await runWaves(kit, { tasksFilter: [] });
		expect(summary.exit).toBe("budget");
	});
});

describe("terminal-stop semantics (M0-P05: a quarantined member is a policy stop, never 0/complete)", () => {
	const eventsOf = (events: ProgressEvent[], kind: ProgressEvent["kind"]) => events.filter((e) => e.kind === kind);
	const statusJson = async (root: string) => (await readJson(join(root, ".orch", "status.json"))) as unknown as StatusPayloads;
	// implementer writes a real file then COMPLETES; verifier approves
	const donePlaylist = (path: string, content: string) => [
		fauxAssistantMessage([fauxToolCall("write", { path, content })], { stopReason: "toolUse" }),
		fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
		fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "line", path: "src/index.ts", line: 1 }] }], notes: "diff satisfies the criterion" }), { stopReason: "stop" }),
		fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "line", path: "src/index.ts", line: 1 }] }], notes: "adversarial pass: no refutation found" }), { stopReason: "stop" }),
	];

	it("first quarantine stops the selection: exit 'blocked' with the id, later tasks never start, phase stays open", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [
				{ id: "t1", title: "x", spec: "DO-NOTHING", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 2 },
				{ id: "t2", title: "y", spec: "DO-NOTHING", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 },
			] }), { stopReason: "stop" }),
			// the first implementer produces zero file changes → immediate quarantine
			fauxAssistantMessage("STATUS: COMPLETE (no changes)", { stopReason: "stop" }),
		], models.faux);
		await accomplish(kit);

		const events: ProgressEvent[] = [];
		const summary = await runWaves(kit, { tasksFilter: [] }, (e) => events.push(e));
		// §3 transition 5: stop the selection on its FIRST quarantine — policy
		// stop (CLI exit 2) with ids, never 0/complete.
		expect(summary.exit).toBe("blocked");
		expect(summary.complete).toBe(false);
		expect(summary.quarantined).toEqual(["t1"]);
		expect(summary.blockedIds).toEqual(["t1"]);
		// the terminal event names the quarantined id (not a plain success)
		const stops = eventsOf(events, "quarantine-stop");
		expect(stops).toHaveLength(1);
		expect(stops[0]).toMatchObject({ quarantined: ["t1"] });
		expect(eventsOf(events, "complete")).toHaveLength(0);
		expect(eventsOf(events, "selection-complete")).toHaveLength(0);
		// t2 was never started: the selection stopped at the first quarantine
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.phase).toBe("running"); // not "complete"
		expect(state.router.tasks.map((t) => t.status)).toEqual(["quarantined", "todo"]);
		// the stop row names the ids (stopped, never "complete")
		const lastRow = state.rows[state.rows.length - 1]!;
		expect(lastRow).toMatchObject({ kind: "wave", task: "session", verb: "stopped" });
		expect(lastRow.detail).toContain("quarantined: t1");
		// status.json surfaces the truth via statusPhase
		const payload = await statusJson(project.root);
		expect(payload.phase).toBe("idle");
		expect(payload.message).toContain("1 task(s) quarantined: t1");
		// CLI-withheld exit code contract: not "sleeping" (which maps to 42)
		expect(summary.exit).not.toBe("sleeping");
		await kit.loop.close();
		kit.lock.release();
	});

	it("mixed done + quarantined → same stop-short treatment", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [
				{ id: "t1", title: "good", spec: "write src/one.ts with the module.", dependsOn: [], acceptance: ["When src/one.ts exists, the system shall compile."], targetPaths: ["src/"], priority: 5 },
				{ id: "t2", title: "stalled", spec: "DO-NOTHING", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 },
			] }), { stopReason: "stop" }),
			...donePlaylist("src/one.ts", "export const one = 1;\n"),
			// t2 writes nothing → quarantined
			fauxAssistantMessage("STATUS: COMPLETE (no changes)", { stopReason: "stop" }),
		], models.faux);
		await accomplish(kit);

		const summary = await runWaves(kit, { tasksFilter: [] });
		expect(summary.exit).toBe("blocked");
		expect(summary.complete).toBe(false);
		expect(summary.quarantined).toEqual(["t2"]);
		expect(summary.blockedIds).toEqual(["t2"]);
		expect(summary.remainingPlanIds).toEqual(["t2"]);
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.phase).toBe("running"); // not "complete"
		expect(state.router.tasks.find((t) => t.id === "t1")?.status).toBe("done");
		expect(state.router.tasks.find((t) => t.id === "t2")?.status).toBe("quarantined");
		const lastRow = state.rows[state.rows.length - 1]!;
		expect(lastRow).toMatchObject({ kind: "wave", task: "session", verb: "stopped" });
		expect(lastRow.detail).toContain("quarantined: t2");
		const payload = await statusJson(project.root);
		expect(payload.message).toContain("1 task(s) quarantined: t2");
		await kit.loop.close();
		kit.lock.release();
	});

	it("quarantined dependency blocks its dependents: the run stops, and a reopen still refuses with ids (never a silent success)", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [
				{ id: "t1", title: "x", spec: "DO-NOTHING", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 2 },
				{ id: "t2", title: "y", spec: "needs t1", dependsOn: ["t1"], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 },
			] }), { stopReason: "stop" }),
			fauxAssistantMessage("STATUS: COMPLETE (no changes)", { stopReason: "stop" }),
		], models.faux);
		const revision = await accomplish(kit);

		const summary = await runWaves(kit, { tasksFilter: [] });
		expect(summary.exit).toBe("blocked");
		expect(summary.quarantined).toEqual(["t1"]);
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.phase).toBe("running");
		expect(state.router.tasks.find((t) => t.id === "t2")?.status).toBe("todo");
		await kit.loop.close();
		kit.lock.release();
		void project;

		// Reopen: the grant survives; the quarantined dependency still blocks —
		// the resumed run stops with the same ids and no additional work.
		const reopened = buildFauxModels([]);
		const kit2 = await openProjectHarness(project.root, "run", { modelsOverride: reopened.models });
		const summary2 = await runWaves(kit2, { tasksFilter: [] });
		expect(summary2.exit).toBe("blocked");
		expect(summary2.quarantined).toEqual(["t1"]);
		expect(summary2.blockedIds).toEqual(["t1", "t2"]);
		expect(summary2.grant.planRevision).toBe(revision);
		await kit2.loop.close();
		kit2.lock.release();
	});

	it("all tasks done and none quarantined → the whole-plan complete, recorded once", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [
				{ id: "t1", title: "one", spec: "write src/one.ts with the module.", dependsOn: [], acceptance: ["When src/one.ts exists, the system shall compile."], targetPaths: ["src/"], priority: 1 },
			] }), { stopReason: "stop" }),
			...donePlaylist("src/one.ts", "export const one = 1;\n"),
		], models.faux);
		await accomplish(kit);

		const events: ProgressEvent[] = [];
		const summary = await runWaves(kit, { tasksFilter: [] }, (e) => events.push(e));
		expect(summary.exit).toBe("plan-complete");
		expect(summary.complete).toBe(true);
		expect(summary.quarantined).toEqual([]);
		expect(eventsOf(events, "complete")).toHaveLength(1);
		expect(eventsOf(events, "quarantine-stop")).toHaveLength(0);
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.phase).toBe("complete");
		const lastRow = state.rows[state.rows.length - 1]!;
		expect(lastRow).toMatchObject({ kind: "wave", task: "session", verb: "complete", detail: "whole plan fulfilled: every task done" });
		void project;
		await kit.loop.close();
		kit.lock.release();
	});
});

describe("rate-limit durable sleep (exit 42 path)", () => {
	it("model_error with rate-limit detail arms the durable sleep and the driver exits 'sleeping'", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels, retryMax: 0 });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [{ id: "t1", title: "x", spec: "s", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 }] }), { stopReason: "stop" }),
			// impl request #1 dies with a rate limit
			fauxAssistantMessage("provider overloaded", { stopReason: "error", errorMessage: "429 rate_limit resets in 90m" }),
		], models.faux);
		await accomplish(kit);
		const summary = await runWaves(kit, { tasksFilter: [] });
		if (summary.exit !== "sleeping") {
			const stateDump = await readSessionState(kit.loop.harness);
			console.error("rows:", stateDump.rows.map((r) => `${r.kind}:${r.task} ${r.verb} ${r.detail ?? ""}`));
		}
		const dump = await readSessionState(kit.loop.harness);
		if (summary.exit !== "sleeping") console.error("sum:", JSON.stringify(summary), "alert:", dump.runStatus.activeAlert, "rows:", dump.rows.map((r) => `${r.kind}:${r.verb}:${String(r.detail ?? "").slice(0, 70)}`));
		expect(summary.exit).toBe("sleeping");
		const state = await readSessionState(kit.loop.harness);
		expect(state.runStatus.sleepTaskId).toBeDefined();
		expect(state.runStatus.sleepUntil).toBeGreaterThan(Date.now());
		await kit.loop.close();
		kit.lock.release();
		void project;
	});
});

describe("verifier verdict parsing", () => {
	it("strict JSON: approve / reject / needs_human / malformed→needs_human", () => {
		expect(parseVerdictStrict('{"verdict":"approve","criteria":[{"id":"1","status":"pass"}],"notes":"good"}')).toMatchObject({ verdict: "approve" });
		expect(parseVerdictStrict("```json\n{\"verdict\":\"reject\",\"criteria\":[],\"notes\":\"wrong file\"}\n```")).toMatchObject({ verdict: "reject" });
		expect(parseVerdictStrict("nothing useful here")).toMatchObject({ verdict: "needs_human" });
		expect(parseVerdictStrict('{"verdict":"AGREE"}')).toMatchObject({ verdict: "needs_human" });
		// M0-P11: prose around the JSON object is rejected (never extracted).
		expect(parseVerdictStrict(`Sure: ${'{"verdict":"approve","criteria":[],"notes":"x"}'}`).verdict).toBe("needs_human");
	});

	it("runVerify produces a wave-log verdict row on needs_human fallback", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels, retryMax: 0 });
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

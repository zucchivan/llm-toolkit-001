/**
 * Budget admission tests (M0-P16): ONE `admitSubmission(stage, checkpoint)`
 * gate guards every paid submission (planner, every implementer retry,
 * primary, skeptic, one-off verify); the Models dispatch guard covers every
 * provider dispatch inside a submission (tool follow-ups, SDK retries,
 * compaction). Refusal is at `>=` (incl. zero ceiling); unpriced observed
 * spend and unknown prices on previously used nonzero classes refuse with
 * distinct reasons — never labeled free. A stop is a PAUSE, never a reject:
 * the paused stage checkpoint persists, the verified candidate survives, and
 * raising the ceiling resumes the same pass without replaying a finished
 * pass or reusing a terminal error key.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { priceUsage, type UsageLike } from "../src/util/budget.ts";
import { admitSubmission, BudgetAdmissionError } from "../src/engine/model-admission.ts";
import { runPlan, loadPrd } from "../src/engine/planner.ts";
import { runWaves } from "../src/engine/waves.ts";
import { runVerify } from "../src/engine/verifier.ts";
import { readSessionState } from "../src/engine/state.ts";
import { ReceiptsDoc } from "../src/engine/receipts.ts";
import { BACKGROUND_CONTEXT } from "../src/engine/kit.ts";
import { bakeProject, scripted, accomplish, reopenProject, replaceSessionUsd } from "./fixtures2.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { fauxProvider } from "./kit-types.ts";
import { demoConfigToml } from "./demo-project.ts";
import { writeGateFile } from "./helpers2.ts";

beforeEach(() => {
	process.env["NO_COLOR"] = "1";
});

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const zeroCeiling = () => replaceSessionUsd(demoConfigToml(), 0);

const PLANNER_ONE_TASK = fauxAssistantMessage(JSON.stringify({
	tasks: [{ id: "t1", title: "one", spec: "write src/one.ts with the module.", dependsOn: [], acceptance: ["When src/one.ts exists, the system shall compile."], targetPaths: ["src/"], priority: 1 }],
}), { stopReason: "stop" });

const implWrites = (content: string) => [
	fauxAssistantMessage([fauxToolCall("write", { path: "src/one.ts", content })], { stopReason: "toolUse" }),
	fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
];
const verdictApprove = (notes = "diff satisfies the criterion") =>
	fauxAssistantMessage(JSON.stringify({
		verdict: "approve",
		criteria: [{ id: "1", status: "pass", evidence: [{ kind: "line", path: "src/one.ts", line: 1 }] }],
		notes,
	}), { stopReason: "stop" });

// ---------------------------------------------------------------------------
// priceUsage classification (unit)
// ---------------------------------------------------------------------------

describe("priceUsage classification", () => {
	const usage = (over: Partial<UsageLike> = {}): UsageLike => ({
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...over,
	});

	it("provider-reported cost wins, cache classes included", () => {
		const priced = priceUsage(
			usage({ input: 10, cacheWrite: 500, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } }),
			{},
		);
		expect(priced).toEqual({ kind: "priced", usd: 10 });
	});

	it("nothing spent prices at zero", () => {
		expect(priceUsage(usage(), {})).toEqual({ kind: "priced", usd: 0 });
	});

	it("catalog prices every token class at its class rate (fixture zero cache rates are simulated zero)", () => {
		const priced = priceUsage(
			usage({ input: 100, output: 50, cacheRead: 20, cacheWrite: 10 }),
			{ providerId: "acme", catalogRates: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } },
		);
		expect(priced.kind).toBe("priced");
		if (priced.kind === "priced") expect(priced.usd).toBeCloseTo((100 * 2 + 50 * 8) / 1e6, 12);
	});

	it("config rates price known input/output when NO cache classes", () => {
		const priced = priceUsage(
			usage({ input: 100, output: 50 }),
			{ providerId: "acme", configRates: { costPerMillionInput: 2, costPerMillionOutput: 8 } },
		);
		expect(priced.kind).toBe("priced");
		if (priced.kind === "priced") expect(priced.usd).toBeCloseTo((100 * 2 + 50 * 8) / 1e6, 12);
	});

	it("unpriced cache deltas are UNKNOWN — never a flat-input approximation", () => {
		const priced = priceUsage(
			usage({ input: 100, output: 50, cacheWrite: 500 }),
			{ providerId: "acme", configRates: { costPerMillionInput: 2, costPerMillionOutput: 8 } },
		);
		expect(priced.kind).toBe("unknown");
		if (priced.kind === "unknown") expect(priced.reason).toMatch(/cache-write/);
	});

	it("faux fixtures may report simulated zero — a known zero, not unknown", () => {
		const priced = priceUsage(
			usage({ input: 0, output: 30, cacheWrite: 900 }),
			{ providerId: "faux" },
		);
		expect(priced).toEqual({ kind: "priced", usd: 0 });
	});

	it("a previously used nonzero class with no price source is UNKNOWN — never labeled free", () => {
		const priced = priceUsage(
			usage({ input: 100, output: 30 }),
			{ providerId: "acme" },
		);
		expect(priced.kind).toBe("unknown");
		if (priced.kind === "unknown") expect(priced.reason).toMatch(/refusing to label it free/);
	});
});

// ---------------------------------------------------------------------------
// admitSubmission refusal semantics (engine-level, fresh harnesses)
// ---------------------------------------------------------------------------

describe("admitSubmission", () => {
	it("refuses at a zero ceiling with a recorded stop and no call", async () => {
		const baked = await bakeProject({ buildFauxModels, configToml: zeroCeiling() });
		const admission = await admitSubmission(baked.kit, "implement", { taskId: "t1", wave: 1 });
		expect(admission.admitted).toBe(false);
		if (!admission.admitted) expect(admission.reason).toMatch(/at or above the ceiling/);
		expect(baked.models.faux.state.callCount).toBe(0);
		const state = await readSessionState(baked.kit.loop.harness);
		expect(state.rows.some((row) => row.kind === "governor" && row.verb === "budget-stop" && row.task === "t1" && row.wave === 1)).toBe(true);
		expect(state.runStatus.activeAlert).toMatch(/budget pause at implement/);
	});

	it("refuses at equality: observed spend equal to the ceiling is already at the ceiling", async () => {
		const baked = await bakeProject({ buildFauxModels });
		await scripted(baked.kit, [PLANNER_ONE_TASK], baked.models.faux);
		await accomplish(baked.kit);
		const spent = (await baked.kit.loop.sessionUsage()).totalUsd;
		const reopened = await reopenProject(baked, replaceSessionUsd(baked.configToml, spent));
		const admission = await admitSubmission(reopened.kit, "implement", { taskId: "t1", wave: 1 });
		expect(admission.admitted).toBe(false);
		if (!admission.admitted) expect(admission.reason).toMatch(/at or above the ceiling/);
		expect(reopened.models.faux.state.callCount).toBe(0);
	});

	it("refuses unpriced observed spend with a distinct reason (never labeled free)", async () => {
		// The verifier role names an unpriced non-faux class: no catalog price,
		// no config rates. A conversation that used it makes the spend
		// unpriceable — the next paid submission pauses on it.
		const configToml = demoConfigToml().replace(
			'[roles.verifier]\nprovider = "faux"\nmodelId = "kit-verifier"',
			'[roles.verifier]\nprovider = "acme"\nmodelId = "ghost"',
		);
		const baked = await bakeProject({ buildFauxModels, configToml });
		const acme = fauxProvider({ provider: "acme", models: [{ id: "ghost", name: "Ghost" }] });
		acme.setResponses([verdictApprove("ghost pass")]);
		baked.models.models.setProvider(acme.provider);
		// Use the acme class once (a real answered call with nonzero tokens).
		const { ConversationKit } = await import("../src/engine/conversations.ts");
		const convKit = new ConversationKit(baked.kit, baked.kit.loop.toolBox);
		const conv = await convKit.createUnit({
			instructions: "unit", guard: { role: "verifier", targetPaths: [] }, tools: "read",
			model: { provider: "acme", modelId: "ghost" }, maxTurns: 4,
		});
		await convKit.submitAndAwait(conv, "ghost-use-once", "reply with anything");
		expect(acme.state.callCount).toBe(1);
		const admission = await admitSubmission(baked.kit, "implement", { taskId: "t1", wave: 1 });
		expect(admission.admitted).toBe(false);
		if (!admission.admitted) expect(admission.reason).toMatch(/unpriceable/);
		expect(baked.models.faux.state.callCount).toBe(0); // no further call
	});
});

// ---------------------------------------------------------------------------
// Every paid submission is guarded
// ---------------------------------------------------------------------------

describe("guarding every paid submission", () => {
	it("the planner conversation is admitted: a zero ceiling refuses plan with no planner call", async () => {
		const baked = await bakeProject({ buildFauxModels, configToml: zeroCeiling() });
		await expect(runPlan(baked.kit, "docs/prd.md", await loadPrd(baked.kit))).rejects.toThrow(BudgetAdmissionError);
		expect(baked.models.faux.state.callCount).toBe(0);
		const state = await readSessionState(baked.kit.loop.harness);
		expect(state.rows.some((row) => row.kind === "governor" && row.verb === "budget-stop" && row.reason === "planner")).toBe(true);
	});

	it("a one-off verify is admitted: refusal throws BudgetAdmissionError with no verifier call", async () => {
		const baked = await bakeProject({ buildFauxModels });
		await scripted(baked.kit, [PLANNER_ONE_TASK], baked.models.faux);
		await accomplish(baked.kit);
		const state = await readSessionState(baked.kit.loop.harness);
		const t = state.router.tasks[0]!;
		// Lower the ceiling to zero after planning: the standalone verify pauses.
		const paused = await reopenProject(baked, zeroCeiling());
		await expect(runVerify(paused.kit, {
			id: t.id, title: t.title, spec: t.spec, acceptance: t.acceptance,
			baselineTreeSha: EMPTY_TREE, targetPaths: t.targetPaths,
		}, "(no gates)")).rejects.toThrow(BudgetAdmissionError);
		expect(paused.models.faux.state.callCount).toBe(0);
	});

	it("a zero ceiling refuses the implementer before the wave starts — exit budget, never quarantine", async () => {
		const baked = await bakeProject({ buildFauxModels });
		await scripted(baked.kit, [PLANNER_ONE_TASK], baked.models.faux);
		await accomplish(baked.kit);
		const paused = await reopenProject(baked, zeroCeiling());
		const summary = await runWaves(paused.kit, { tasksFilter: [] });
		expect(summary.exit).toBe("budget");
		expect(summary.complete).toBe(false);
		expect(paused.models.faux.state.callCount).toBe(0); // the implementer was never dispatched
		const state = await readSessionState(paused.kit.loop.harness);
		expect(state.router.tasks[0]!.status).toBe("todo"); // pause — not a reject, not quarantined
		expect(state.rows.some((row) => row.kind === "wave" && row.verb === "start")).toBe(false);
		expect(state.rows.some((row) => row.kind === "governor" && row.verb === "budget-stop")).toBe(true);
		// Raising the ceiling resumes the SAME wave 1 — no extra wave, no
		// additional charge for the pause.
		const resumed = await reopenProject(paused, replaceSessionUsd(paused.configToml, 25));
		resumed.models.faux.appendResponses([...implWrites("export const one = 1;\n"), verdictApprove(), verdictApprove("adversarial pass")]);
		const summary2 = await runWaves(resumed.kit, { tasksFilter: [] });
		expect(summary2.exit).toBe("plan-complete");
		expect(summary2.ranWaves).toEqual([1]);
	});
});

// ---------------------------------------------------------------------------
// Pause semantics across stages
// ---------------------------------------------------------------------------

describe("budget stops pause the stage, never reject it", () => {
	it("a failed wave that consumed the last allowance gets no repair submission; raising the ceiling continues the same wave", async () => {
		const baked = await bakeProject({ buildFauxModels });
		await scripted(baked.kit, [
			PLANNER_ONE_TASK,
			// wave 1: a BROKEN candidate the gate rejects (recipe gate installed below)
			fauxAssistantMessage([fauxToolCall("write", { path: "src/one.ts", content: "export const BROKEN = true;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
		], baked.models.faux);
		await writeGateFile(baked.project.root);
		await accomplish(baked.kit);
		// Run wave 1 to its failed-candidate rollback, then stop before any repair.
		await expect(runWaves(baked.kit, {
			tasksFilter: [],
			driverFaultInjector(point) {
				if (point === "after-workspace-discard") throw new Error("stop before the wave-2 admission");
			},
		})).rejects.toThrow("stop before the wave-2 admission");
		const spent = (await baked.kit.loop.sessionUsage()).totalUsd;
		// The ceiling exactly equals the observed spend: the repair submission
		// (wave 2) is refused at >= with no call.
		const paused = await reopenProject(baked, replaceSessionUsd(baked.configToml, spent));
		const summary = await runWaves(paused.kit, { tasksFilter: [] });
		expect(summary.exit).toBe("budget");
		expect(paused.models.faux.state.callCount).toBe(0);
		const state = await readSessionState(paused.kit.loop.harness);
		// The wave ended in_progress with its rollback checkpoint pending — the
		// paused stage persists; the task was neither rejected nor quarantined.
		expect(state.router.tasks[0]).toMatchObject({ status: "in_progress", waveCount: 1 });
		expect(state.rows.filter((row) => row.kind === "wave" && row.verb === "start")).toHaveLength(1);
		// Prior usage stays counted while paused.
		expect(state.runStatus.budgetSpentUsd).toBeGreaterThan(0);
		// Raise the ceiling: wave 2 dispatches once (the repair), prior usage
		// counted, and the task completes on the same wave number.
		const repaired = await reopenProject(paused, replaceSessionUsd(paused.configToml, spent + 1));
		repaired.models.faux.appendResponses([
			...implWrites("export const one = 1;\n"),
			verdictApprove(), verdictApprove("adversarial pass"),
		]);
		const summary2 = await runWaves(repaired.kit, { tasksFilter: [] });
		expect(summary2.exit).toBe("plan-complete");
		expect(summary2.ranWaves).toEqual([2]);
		expect(repaired.models.faux.state.callCount).toBe(4); // repair (write + status) + primary + skeptic only
	});

	it("primary consuming the remaining budget stops before skeptic — task not accepted; raising the ceiling continues skeptic without a second primary", async () => {
		const baked = await bakeProject({ buildFauxModels });
		await scripted(baked.kit, [
			PLANNER_ONE_TASK,
			...implWrites("export const one = 1;\n"),
			verdictApprove(),
			verdictApprove("adversarial pass"),
		], baked.models.faux);
		await accomplish(baked.kit);
		await expect(runWaves(baked.kit, {
			tasksFilter: [],
			driverFaultInjector(point) {
				if (point === "after-primary") throw new Error("stop right after the primary receipt");
			},
		})).rejects.toThrow("stop right after the primary receipt");
		const spent = (await baked.kit.loop.sessionUsage()).totalUsd;
		// Ceiling == observed spend: the run pauses before the skeptic pass.
		const paused = await reopenProject(baked, replaceSessionUsd(baked.configToml, spent));
		const summary = await runWaves(paused.kit, { tasksFilter: [] });
		expect(summary.exit).toBe("budget");
		expect(paused.models.faux.state.callCount).toBe(0); // skeptic never dispatched
		const state = await readSessionState(paused.kit.loop.harness);
		expect(state.router.tasks[0]!.status).toBe("in_progress"); // not accepted, not quarantined
		const receipts = await paused.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		const passes = receipts?.events.filter((event) => event.kind === "pass") ?? [];
		expect(passes).toHaveLength(1); // primary receipted; NO skeptic receipt
		expect(passes.map((event) => event.kind === "pass" && event.value.review.pass)).toEqual(["primary"]);
		// The verified candidate is preserved for the next pass.
		const checkpoints = receipts?.events.filter((event) => event.kind === "checkpoint") ?? [];
		expect(checkpoints.at(-1)?.value.candidate).toMatch(/^[0-9a-f]{40}$/);
		// Raise the ceiling: the SAME pending skeptic pass continues — the
		// finished primary is reused (never replayed, no second charge).
		const resumed = await reopenProject(paused, replaceSessionUsd(paused.configToml, spent + 1));
		resumed.models.faux.appendResponses([verdictApprove("adversarial pass")]);
		const summary2 = await runWaves(resumed.kit, { tasksFilter: [] });
		expect(summary2.exit).toBe("plan-complete");
		expect(resumed.models.faux.state.callCount).toBe(1); // exactly the skeptic
		const receipts2 = await resumed.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		const passes2 = receipts2?.events.filter((event) => event.kind === "pass") ?? [];
		expect(passes2).toHaveLength(2); // primary receipt reused, skeptic added once
	});

	it("a verifier pass stopped mid-submission denies its next dispatch (tool follow-up) — and resume reconciles first, mints a new attempt key, and never replays the finished work", async () => {
		// The verifier's FIRST turn is a read tool call whose scripted output is
		// long enough that its catalog-priced cost (output rate 4 USD/1M) exceeds
		// the headroom we leave between the observed spend and the ceiling. The
		// after-response hook folds that turn into the high-water snapshot, so
		// the NEXT dispatch of the same pass (the verdict follow-up) is denied
		// by the Models guard before any further provider call.
		const longPath = `src/${"x".repeat(4000)}`;
		const turn1Text = `read:${JSON.stringify({ path: longPath })}`;
		const turn1CostUsd = (Math.ceil(turn1Text.length / 4) / 1_000_000) * 4;
		const baked = await bakeProject({ buildFauxModels });
		await scripted(baked.kit, [PLANNER_ONE_TASK, ...implWrites("export const one = 1;\n")], baked.models.faux);
		await accomplish(baked.kit);
		await expect(runWaves(baked.kit, {
			tasksFilter: [],
			driverFaultInjector(point) {
				if (point === "after-gates") throw new Error("stop right before the verify stage");
			},
		})).rejects.toThrow("stop right before the verify stage");
		const spent = (await baked.kit.loop.sessionUsage()).totalUsd;
		const paused = await reopenProject(baked, replaceSessionUsd(baked.configToml, spent + turn1CostUsd / 2));
		paused.models.faux.appendResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: longPath })], { stopReason: "toolUse" }),
			verdictApprove(),
			verdictApprove("adversarial pass"),
		]);
		const summary = await runWaves(paused.kit, { tasksFilter: [] });
		expect(summary.exit).toBe("budget");
		expect(paused.models.faux.state.callCount).toBe(1); // ONLY the first read dispatch — the follow-up was denied
		const state = await readSessionState(paused.kit.loop.harness);
		expect(state.rows.some((row) => row.kind === "governor" && row.verb === "budget-stop" && row.reason === "primary")).toBe(true);
		expect(state.rows.some((row) => row.kind === "verdict")).toBe(false); // a stop is never a reject
		expect(state.router.tasks[0]!.status).toBe("in_progress");
		const receiptsPaused = await paused.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		expect(receiptsPaused?.events.filter((event) => event.kind === "pass")).toHaveLength(0);
		// The paused primary checkpoint persists its submission identity.
		const primaryPending = receiptsPaused?.events.filter((event) => event.kind === "checkpoint" && event.value.stage === "primary").at(-1);
		expect(primaryPending?.value.state).toBe("pending");
		expect(primaryPending?.value.submissionKey).toMatch(/^kit:.*:w1:primary$/);

		// Raise the ceiling: resume reconciles the SAME request first (it is
		// terminal — never replayed, its key never reused), checkpoints a NEW
		// submission attempt for the unfinished pass only, and completes both
		// passes without charging again for the finished gates/candidate.
		const resumed = await reopenProject(paused, replaceSessionUsd(paused.configToml, spent + 1));
		resumed.models.faux.appendResponses([verdictApprove(), verdictApprove("adversarial pass")]);
		const summary2 = await runWaves(resumed.kit, { tasksFilter: [] });
		expect(summary2.exit).toBe("plan-complete");
		expect(summary2.ranWaves).toEqual([1]);
		const receipts2 = await resumed.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		const passes2 = receipts2?.events.filter((event) => event.kind === "pass") ?? [];
		expect(passes2).toHaveLength(2);
		const primaryAttempts = receipts2?.events.filter((event) => event.kind === "checkpoint" && event.value.stage === "primary") ?? [];
		// base pending + complete + the resubmitted attempt's pending + complete
		expect(primaryAttempts.at(-1)?.value.submissionKey).toMatch(/#a\d+$/);
		expect(primaryAttempts.at(-1)?.value.state).toBe("complete");
	});
});

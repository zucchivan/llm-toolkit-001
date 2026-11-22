import { describe, expect, it } from "vitest";
import { runVerify } from "../src/engine/verifier.ts";
import type { VerifyTask } from "../src/engine/verifier.ts";
import { runWaves } from "../src/engine/waves.ts";
import { readSessionState } from "../src/engine/state.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { demoConfigToml } from "./demo-project.ts";
import { accomplish, bakeProject, scripted } from "./fixtures2.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const TASK: VerifyTask = {
	id: "t1",
	title: "one",
	spec: "write src/one.ts",
	acceptance: ["When src/one.ts exists, the system shall export one."],
	baselineTreeSha: EMPTY_TREE,
	targetPaths: ["src/"],
};

const verdict = (value: "approve" | "reject" | "needs_human", notes: string, evidencePath = "src/index.ts") =>
	fauxAssistantMessage(JSON.stringify({
		verdict: value,
		criteria: [{
			id: "1",
			status: value === "approve" ? "pass" : value === "reject" ? "fail" : "unverifiable",
			...(value === "approve" ? { evidence: [{ kind: "line", path: evidencePath, line: 1 }] } : {}),
		}],
		notes,
	}), { stopReason: "stop" });

const implWrite = (content: string) => [
	fauxAssistantMessage([fauxToolCall("write", { path: "src/one.ts", content })], { stopReason: "toolUse" }),
	fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
];

describe("default-on adversarial verifier", () => {
	it("omitted config runs a fresh read-only adversarial pass and logs both verdicts and usage", async () => {
		const { kit, models } = await bakeProject({
			buildFauxModels,
			configToml: demoConfigToml().replace(
				'[roles.verifier]\nprovider = "faux"\nmodelId = "kit-verifier"',
				'[roles.verifier]\nprovider = "faux"\nmodelId = "kit-verifier"\ncostPerMillionInput = 1\ncostPerMillionOutput = 4',
			),
		});
		expect(kit.loop.config.gates.skepticSecondPass).toBe(true);
		const contexts: string[] = [];
		models.faux.setResponses([
			(context) => {
				contexts.push(JSON.stringify(context));
				return verdict("approve", "primary approval");
			},
			(context) => {
				contexts.push(JSON.stringify(context));
				return verdict("approve", "adversarial approval");
			},
		]);

		const result = await runVerify(kit, TASK, "scope: pass");
		expect(result.verdict).toBe("approve");
		expect(models.faux.state.callCount).toBe(2);
		expect(models.faux.getPendingResponseCount()).toBe(0);
		expect(contexts[0]).toContain("You are the VERIFIER");
		expect(contexts[1]).toContain("ADVERSARIAL VERIFIER");
		expect(contexts[1]).toContain("regressions");
		expect(contexts[1]).toContain("missing tests");
		expect(contexts[1]).toContain("security or data-loss");
		expect(contexts[1]).not.toContain("primary approval");

		const state = await readSessionState(kit.loop.harness);
		const rows = state.rows.filter((row) => row.kind === "verdict");
		expect(rows.map((row) => row.verb)).toEqual(["verify:approve", "verify:skeptic:approve"]);
		expect(rows.map((row) => row.verdict)).toEqual(["approve", "approve"]);
		for (const row of rows) {
			expect(row.tokens).toBeGreaterThan(0);
			expect(row.costUsd).toBeGreaterThan(0);
		}
		const usage = await kit.loop.sessionUsage();
		expect(rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0)).toBe(usage.tokens);
		expect(rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)).toBeCloseTo(usage.totalUsd, 10);

		await kit.loop.close();
		kit.lock.release();
	});

	it("explicit skepticSecondPass = false preserves the opt-out", async () => {
		const { kit, models } = await bakeProject({
			buildFauxModels,
			configToml: demoConfigToml().replace(
				"enforceTargetPaths = true",
				"enforceTargetPaths = true\nskepticSecondPass = false",
			),
		});
		expect(kit.loop.config.gates.skepticSecondPass).toBe(false);
		models.faux.setResponses([verdict("approve", "primary only")]);

		const result = await runVerify(kit, TASK, "scope: pass");
		expect(result.verdict).toBe("approve");
		expect(models.faux.state.callCount).toBe(1);
		expect(models.faux.getPendingResponseCount()).toBe(0);
		const state = await readSessionState(kit.loop.harness);
		const rows = state.rows.filter((row) => row.kind === "verdict");
		expect(rows.map((row) => row.verb)).toEqual(["verify:approve"]);

		await kit.loop.close();
		kit.lock.release();
	});

	it("an adversarial rejection feeds the next wave and a later clean pass completes", async () => {
		const { kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [{
				id: TASK.id,
				title: TASK.title,
				spec: TASK.spec,
				dependsOn: [],
				acceptance: TASK.acceptance,
				targetPaths: TASK.targetPaths,
				priority: 1,
			}] }), { stopReason: "stop" }),
			...implWrite("export const one = 0;\n"),
			verdict("approve", "primary missed the defect", "src/one.ts"),
			verdict("reject", "export one, not zero"),
			...implWrite("export const one = 1;\n"),
			verdict("approve", "fixed", "src/one.ts"),
			verdict("approve", "no remaining refutation", "src/one.ts"),
		], models.faux);
		await accomplish(kit);

		const summary = await runWaves(kit, { tasksFilter: [] });
		expect(summary.complete).toBe(true);
		expect(models.faux.getPendingResponseCount()).toBe(0);
		const state = await readSessionState(kit.loop.harness);
		const task = state.router.tasks[0]!;
		expect(task.status).toBe("done");
		expect(task.waveCount).toBe(2);
		expect(task.feedback).toEqual(expect.arrayContaining([
			expect.objectContaining({ wave: 1, from: "verifier", text: "skeptic pass: export one, not zero" }),
		]));
		const rows = state.rows.filter((row) => row.kind === "verdict");
		expect(rows.map((row) => row.verb)).toEqual([
			"verify:approve",
			"verify:skeptic:reject",
			"reject:1",
			"verify:approve",
			"verify:skeptic:approve",
		]);
		expect(rows.find((row) => row.verb === "verify:skeptic:reject")).toMatchObject({
			verdict: "reject",
			detail: "export one, not zero",
			provider: "faux",
			modelId: "kit-verifier",
		});
		expect(rows.find((row) => row.verb === "verify:skeptic:reject")?.tokens).toBeGreaterThan(0);

		await kit.loop.close();
		kit.lock.release();
	});

	it.each([
		["malformed output", "this is not a JSON verdict"],
		["an inconclusive approval", JSON.stringify({
			verdict: "approve",
			criteria: [{ id: "1", status: "unverifiable" }],
			notes: "cannot confirm the criterion",
		})],
	])("fails closed on %s", async (_name, adversarialResponse) => {
		const { kit, models } = await bakeProject({ buildFauxModels });
		models.faux.setResponses([
			verdict("approve", "primary approval"),
			fauxAssistantMessage(adversarialResponse, { stopReason: "stop" }),
		]);

		const result = await runVerify(kit, TASK, "scope: pass");
		expect(result.verdict).toBe("needs_human");
		expect(result.notes).toContain("skeptic pass:");
		const state = await readSessionState(kit.loop.harness);
		const rows = state.rows.filter((row) => row.kind === "verdict");
		expect(rows.map((row) => row.verb)).toEqual(["verify:approve", "verify:skeptic:needs_human"]);
		expect(rows[1]?.verdict).toBe("needs_human");

		await kit.loop.close();
		kit.lock.release();
	});
});

describe("symmetric criterion evidence (M0-P11)", () => {
	it("an approving primary without criterion evidence is refused and the skeptic is never dispatched", async () => {
		const { kit, models } = await bakeProject({ buildFauxModels });
		models.faux.setResponses([
			// approve with a complete ID set but NO evidence references
			fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass" }], notes: "looks done" }), { stopReason: "stop" }),
			verdict("approve", "skeptic never runs after an invalid primary"),
		]);

		const result = await runVerify(kit, TASK, "scope: pass");
		expect(result.verdict).toBe("needs_human");
		expect(result.notes).toContain("approval refused:");
		expect(result.notes).toContain("criterion 1");
		expect(models.faux.state.callCount).toBe(1); // no skeptic after an invalid primary
		const state = await readSessionState(kit.loop.harness);
		const rows = state.rows.filter((row) => row.kind === "verdict");
		expect(rows.map((row) => row.verb)).toEqual(["verify:needs_human"]);
		expect(rows[0]?.verdict).toBe("needs_human");

		await kit.loop.close();
		kit.lock.release();
	});

	it("skepticSecondPass = false still enforces primary completeness", async () => {
		const { kit, models } = await bakeProject({
			buildFauxModels,
			configToml: demoConfigToml().replace(
				"enforceTargetPaths = true",
				"enforceTargetPaths = true\nskepticSecondPass = false",
			),
		});
		expect(kit.loop.config.gates.skepticSecondPass).toBe(false);
		models.faux.setResponses([
			fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass" }], notes: "single pass" }), { stopReason: "stop" }),
		]);

		const result = await runVerify(kit, TASK, "scope: pass");
		expect(result.verdict).toBe("needs_human");
		expect(result.notes).toContain("approval refused:");
		expect(models.faux.state.callCount).toBe(1);

		await kit.loop.close();
		kit.lock.release();
	});

	it("each pass is committed before the next pass is dispatched: the primary receipt survives a skeptic failure", async () => {
		const { kit, models } = await bakeProject({ buildFauxModels });
		models.faux.setResponses([
			verdict("approve", "primary approval"),
			// the skeptic submission dies with a provider error
			fauxAssistantMessage("provider overloaded", { stopReason: "error", errorMessage: "429 rate_limit resets in 90m" }),
		]);

		const result = await runVerify(kit, TASK, "scope: pass");
		expect(result.verdict).toBe("needs_human");
		const state = await readSessionState(kit.loop.harness);
		const rows = state.rows.filter((row) => row.kind === "verdict");
		// The primary pass (approve) was durably committed BEFORE the skeptic was
		// dispatched — its row survives the skeptic's provider failure.
		expect(rows.map((row) => row.verb)).toEqual(["verify:approve", "verify:skeptic:needs_human"]);
		// the one-off diagnostic path records no wave-keyed pass receipts
		expect(rows.every((row) => row.receipt === undefined)).toBe(true);

		await kit.loop.close();
		kit.lock.release();
	});
});

/**
 * M0-P11: symmetric criterion-evidence enforcement + durable reviewed passes.
 * Each required approving pass (primary AND skeptic) must mark every reviewed
 * criterion pass and cite valid evidence against the CHECKED tree — a gate
 * that executed, was not skipped, and passed (never the scope check), or an
 * existing line in a safe text blob on that tree. Refusals are needs_human;
 * a well-formed explicit reject stays reject. Every pass commits its pass
 * receipt (`loop.receipts`) before the next pass is dispatched.
 */
import { describe, expect, it } from "vitest";
import { runVerify, parseVerdictStrict } from "../src/engine/verifier.ts";
import type { VerifyTask } from "../src/engine/verifier.ts";
import { runGates } from "../src/engine/gates.ts";
import { captureBaselineTree } from "../src/util/git.ts";
import { gateCheckFromResult, ReceiptsDoc } from "../src/engine/receipts.ts";
import type { GateCheck, ReceiptsDocValue } from "../src/engine/receipts.ts";
import { readSessionState } from "../src/engine/state.ts";
import { runWaves } from "../src/engine/waves.ts";
import { openProjectHarness } from "../src/engine/harness.ts";
import { BACKGROUND_CONTEXT } from "../src/engine/kit.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { demoConfigToml } from "./demo-project.ts";
import { bakeProject, scripted, accomplish } from "./fixtures2.ts";
import { writeGateFile } from "./helpers2.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const TASK: VerifyTask = {
	id: "t1",
	title: "one",
	spec: "write src/list.ts",
	acceptance: ["When parseList runs on '/a/b', the system shall return ['a','b']."],
	baselineTreeSha: EMPTY_TREE,
	targetPaths: ["src/"],
};

/** The checklist's reference example: criterion 1 proven by src/list.ts line 2. */
const LIST_TS = `export function parseList(input: string): string[] {
	return input.split("/").map((part) => part.trim()).filter(Boolean);
}
`;
const LINE_REF = { kind: "line", path: "src/list.ts", line: 2 } as const;

const approveWith = (evidence: unknown[] | undefined, notes = "checklist reference example") =>
	fauxAssistantMessage(JSON.stringify({
		verdict: "approve",
		criteria: [{ id: "1", status: "pass", ...(evidence === undefined ? {} : { evidence }) }],
		notes,
	}), { stopReason: "stop" });
const rejectPlain = () => fauxAssistantMessage(JSON.stringify({ verdict: "reject", criteria: [], notes: "the filter drops empty parts" }), { stopReason: "stop" });

const implWrite = (content: string) => [
	fauxAssistantMessage([fauxToolCall("write", { path: "src/list.ts", content })], { stopReason: "toolUse" }),
	fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
];

/** The gate checks a synthetic gate receipt would record (pass/skip/error). */
const SYNTHETIC_CHECKS: GateCheck[] = [
	{ id: "scope", kind: "scope", outcome: "pass", exit: null, ms: 0 },
	{ id: "unit", kind: "recipe", outcome: "pass", exit: 0, ms: 5 },
	{ id: "lint", kind: "recipe", outcome: "skip", exit: null, ms: 0 },
	{ id: "slow", kind: "recipe", outcome: "error", exit: null, ms: 30_000 },
];

const gateEvidenceOf = (tree: string) => ({ tree, gateId: "gate-receipt-1", checks: SYNTHETIC_CHECKS });
const gateRef = (id: string) => [{ kind: "gate", id }] as const;

async function readReceipts(kit: Awaited<ReturnType<typeof openProjectHarness>>): Promise<ReceiptsDocValue> {
	return (await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT)) ?? { version: 1, events: [] };
}

describe("criterion evidence against the checked tree (M0-P11)", () => {
	it("the checklist's line-reference example approves on its checked tree, and pass receipts are retrievable after reopen", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [{
				id: TASK.id, title: TASK.title, spec: TASK.spec, dependsOn: [], acceptance: TASK.acceptance,
				targetPaths: TASK.targetPaths, priority: 1,
			}] }), { stopReason: "stop" }),
			...implWrite(LIST_TS),
			approveWith([LINE_REF], "criterion 1: parseList proven at src/list.ts line 2"),
			approveWith([LINE_REF], "adversarial pass: same reference independently confirmed"),
		], models.faux);
		await accomplish(kit);

		const summary = await runWaves(kit, { tasksFilter: [] });
		expect(summary.complete).toBe(true);
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.tasks[0]).toMatchObject({ id: TASK.id, status: "done", waveCount: 1 });
		await kit.loop.close();
		kit.lock.release();

		// After reopen: both passes' criterion arrays, the checked tree, the gate
		// id and the policy are retrievable from the durable receipts doc.
		const reopened = await openProjectHarness(project.root, "test", { modelsOverride: buildFauxModels([]).models });
		try {
			const receipts = await readReceipts(reopened);
			const gateEvents = receipts.events.filter((e) => e.kind === "gate");
			const passEvents = receipts.events.filter((e) => e.kind === "pass");
			expect(gateEvents).toHaveLength(1);
			expect(passEvents).toHaveLength(2);
			const gate = gateEvents[0]!;
			if (gate.kind !== "gate") throw new Error("unreachable");
			expect(gate.value).toMatchObject({ planRevision: expect.any(String), taskId: TASK.id, wave: 1 });
			expect(gate.value.checks.map((c) => `${c.id}:${c.outcome}`)).toEqual(["scope:pass"]);
			expect(gate.value.tree).toMatch(/^[0-9a-f]{40}$/);
			for (const [index, expectedPass] of ["primary", "skeptic"].entries()) {
				const event = passEvents[index]!;
				if (event.kind !== "pass") throw new Error("unreachable");
				expect(event.value).toMatchObject({
					taskId: TASK.id, wave: 1, tree: gate.value.tree, gateId: gate.value.id, policy: "always",
				});
				expect(event.value.review.pass).toBe(expectedPass);
				expect(event.value.review.verdict).toBe("approve");
				expect(event.value.review.criteria).toEqual([{ id: "1", status: "pass", evidence: [LINE_REF] }]);
			}
		} finally {
			await reopened.loop.close();
			reopened.lock.release();
		}
	});

	it("the same reference on a different tree without the cited evidence fails closed to needs_human", async () => {
		const { kit, models } = await bakeProject({ buildFauxModels });
		// No implementer ran: the checked tree is the bare fixture — src/list.ts
		// (and its cited line 2) does not exist on it.
		models.faux.setResponses([approveWith([LINE_REF]), approveWith([LINE_REF], "skeptic cites the same ref")]);
		const result = await runVerify(kit, TASK, "scope: pass");
		expect(result.verdict).toBe("needs_human");
		expect(result.notes).toContain("approval refused:");
		expect(result.notes).toContain("src/list.ts:2");
		expect(models.faux.state.callCount).toBe(1); // no skeptic after the invalid primary
		await kit.loop.close();
		kit.lock.release();
	});

	it("gate references must name an executed, non-scope, non-skipped passing check; line refs must exist in safe text", async () => {
		const { kit, models } = await bakeProject({ buildFauxModels });
		const checkedTree = await captureBaselineTree(kit.loop.paths.root);
		const cases: { name: string; evidence: unknown[]; approve: boolean; fragment?: string }[] = [
			{ name: "a citable passing recipe", evidence: gateRef("unit"), approve: true },
			{ name: "the scope check", evidence: gateRef("scope"), approve: false, fragment: "non-scope" },
			{ name: "a skipped recipe", evidence: gateRef("lint"), approve: false, fragment: "non-skipped" },
			{ name: "an errored recipe", evidence: gateRef("slow"), approve: false, fragment: "non-skipped" },
			{ name: "an unknown gate id", evidence: gateRef("ghost"), approve: false, fragment: "ghost" },
			{ name: "an existing line", evidence: [{ kind: "line", path: "src/index.ts", line: 1 }], approve: true },
			{ name: "a line past EOF", evidence: [{ kind: "line", path: "src/index.ts", line: 9 }], approve: false, fragment: "src/index.ts:9" },
			{ name: "a missing path", evidence: [{ kind: "line", path: "src/absent.ts", line: 1 }], approve: false, fragment: "src/absent.ts:1" },
			{ name: "a non-integer line", evidence: [{ kind: "line", path: "src/index.ts", line: 1.5 }], approve: false, fragment: "malformed" },
		];
		for (const c of cases) {
			const before = models.faux.state.callCount;
			models.faux.setResponses([approveWith([...c.evidence])]);
			const result = await runVerify(kit, TASK, "unit: pass", { gateEvidence: gateEvidenceOf(checkedTree), skepticSecondPass: false });
			if (c.approve) expect(result.verdict, c.name).toBe("approve");
			else {
				expect(result.verdict, c.name).toBe("needs_human");
				expect(result.notes, c.name).toContain("approval refused:");
				if (c.fragment) expect(result.notes, c.name).toContain(c.fragment);
			}
			expect(models.faux.state.callCount - before, c.name).toBe(1);
		}
		await kit.loop.close();
		kit.lock.release();
	});

	it("real gate receipts bind the passes: a passed recipe is citable evidence and a failed one is not", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [{
				id: TASK.id, title: TASK.title, spec: TASK.spec, dependsOn: [], acceptance: TASK.acceptance,
				targetPaths: TASK.targetPaths, priority: 1,
			}] }), { stopReason: "stop" }),
		], models.faux);
		await accomplish(kit);
		await writeGateFile(project.root); // broken-gate passes while no BROKEN token exists
		const baseline = await captureBaselineTree(kit.loop.paths.root);
		const gate = await runGates(kit, { id: TASK.id, targetPaths: TASK.targetPaths, baselineTreeSha: baseline }, {});
		expect(gate.allPassed).toBe(true);
		const checkedTree = await captureBaselineTree(kit.loop.paths.root);
		const checks = gate.results.map(gateCheckFromResult);
		const receiptRevision = "11111111-1111-4111-8111-111111111111";

		models.faux.setResponses([approveWith(gateRef("broken-gate")), approveWith(gateRef("broken-gate"), "skeptic agrees")]);
		const ok = await runVerify(kit, TASK, "broken-gate: pass", {
			gateEvidence: { tree: checkedTree, gateId: "real-gate", checks },
			waveIdentity: { planRevision: receiptRevision, wave: 3 },
		});
		expect(ok.verdict).toBe("approve");

		models.faux.setResponses([approveWith(gateRef("absent-gate"))]);
		const bad = await runVerify(kit, TASK, "broken-gate: pass", {
			gateEvidence: { tree: checkedTree, gateId: "real-gate", checks },
			waveIdentity: { planRevision: receiptRevision, wave: 4 },
		});
		expect(bad.verdict).toBe("needs_human");

		const receipts = await readReceipts(kit);
		const passEvents = receipts.events.filter((e) => e.kind === "pass");
		// runVerify #1: primary + skeptic approvals at wave 3; runVerify #2: the
		// refused primary at wave 4. Every pass is durably recorded.
		expect(passEvents).toHaveLength(3);
		for (const [index, expected] of [["primary", "approve", 3], ["skeptic", "approve", 3], ["primary", "needs_human", 4]].entries()) {
			const event = passEvents[index]!;
			if (event.kind !== "pass") throw new Error("unreachable");
			expect(event.value).toMatchObject({
				taskId: TASK.id, wave: expected[2], tree: checkedTree, gateId: "real-gate", policy: "always",
				review: { pass: expected[0], verdict: expected[1] },
			});
		}
		await kit.loop.close();
		kit.lock.release();
	});

	it("unknown, duplicate, missing, empty and inconclusive entries refuse; a well-formed explicit reject stays reject", async () => {
		const { kit, models } = await bakeProject({ buildFauxModels });
		const cases: { name: string; body: unknown; expectVerdict: string }[] = [
			{ name: "empty criteria array (missing proof)", body: { verdict: "approve", criteria: [], notes: "n" }, expectVerdict: "needs_human" },
			{ name: "duplicate id", body: { verdict: "approve", criteria: [
				{ id: "1", status: "pass", evidence: [LINE_REF] }, { id: "1", status: "pass", evidence: [LINE_REF] },
			], notes: "n" }, expectVerdict: "needs_human" },
			{ name: "unknown id beyond the reviewed criteria", body: { verdict: "approve", criteria: [
				{ id: "1", status: "pass", evidence: [LINE_REF] }, { id: "2", status: "pass", evidence: [LINE_REF] },
			], notes: "n" }, expectVerdict: "needs_human" },
			{ name: "non-exact 1-based id", body: { verdict: "approve", criteria: [{ id: "01", status: "pass", evidence: [LINE_REF] }], notes: "n" }, expectVerdict: "needs_human" },
			{ name: "inconclusive approval", body: { verdict: "approve", criteria: [{ id: "1", status: "unverifiable" }], notes: "n" }, expectVerdict: "needs_human" },
			{ name: "malformed entry is never filtered", body: { verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [LINE_REF] }, "extra"], notes: "n" }, expectVerdict: "needs_human" },
			{ name: "empty criterion entry", body: { verdict: "approve", criteria: [{}], notes: "n" }, expectVerdict: "needs_human" },
			{ name: "explicit reject without evidence stays reject", body: { verdict: "reject", criteria: [], notes: "wrong" }, expectVerdict: "reject" },
		];
		for (const c of cases) {
			const before = models.faux.state.callCount;
			models.faux.setResponses([fauxAssistantMessage(JSON.stringify(c.body), { stopReason: "stop" })]);
			const result = await runVerify(kit, TASK, "scope: pass", { skepticSecondPass: false });
			expect(result.verdict, c.name).toBe(c.expectVerdict);
			expect(models.faux.state.callCount - before, c.name).toBe(1);
		}
		await kit.loop.close();
		kit.lock.release();
	});

	it("malformed JSON and prose around the JSON are needs_human; one fenced JSON object still parses", async () => {
		const { kit, models } = await bakeProject({ buildFauxModels });
		models.faux.setResponses([fauxAssistantMessage("this is not a JSON verdict", { stopReason: "stop" })]);
		expect((await runVerify(kit, TASK, "scope: pass", { skepticSecondPass: false })).verdict).toBe("needs_human");
		models.faux.setResponses([fauxAssistantMessage(`Here is my verdict: ${JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [LINE_REF] }] })} — thanks!`, { stopReason: "stop" })]);
		expect((await runVerify(kit, TASK, "scope: pass", { skepticSecondPass: false })).verdict).toBe("needs_human");
		models.faux.setResponses([fauxAssistantMessage("```json\n" + JSON.stringify({ verdict: "reject", criteria: [], notes: "fixable" }) + "\n```", { stopReason: "stop" })]);
		const fenced = await runVerify(kit, TASK, "scope: pass", { skepticSecondPass: false });
		expect(fenced.verdict).toBe("reject");
		expect(models.faux.state.callCount).toBe(3);
		await kit.loop.close();
		kit.lock.release();
	});

	it("a diagnostic verify without gate receipts cannot claim gate evidence", async () => {
		const { kit, models } = await bakeProject({ buildFauxModels });
		models.faux.setResponses([
			approveWith(gateRef("unit")),
			approveWith([{ kind: "line", path: "src/index.ts", line: 1 }]),
			approveWith([{ kind: "line", path: "src/index.ts", line: 1 }], "skeptic agrees"),
		]);
		const gateRefResult = await runVerify(kit, TASK, "scope: pass");
		expect(gateRefResult.verdict).toBe("needs_human");
		expect(gateRefResult.notes).toContain("gate reference");
		const lineRefResult = await runVerify(kit, TASK, "scope: pass");
		expect(lineRefResult.verdict).toBe("approve");
		expect(models.faux.state.callCount).toBe(3);
		await kit.loop.close();
		kit.lock.release();
	});

	it("the wave loop commits the gate receipt and each pass receipt before the skeptic is dispatched", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [{
				id: TASK.id, title: TASK.title, spec: TASK.spec, dependsOn: [], acceptance: TASK.acceptance,
				targetPaths: TASK.targetPaths, priority: 1,
			}] }), { stopReason: "stop" }),
			...implWrite(LIST_TS),
			approveWith([LINE_REF], "primary approves with evidence"),
			// the skeptic submission dies with a provider error
			fauxAssistantMessage("provider overloaded", { stopReason: "error", errorMessage: "429 rate_limit resets in 90m" }),
		], models.faux);
		await accomplish(kit);
		const summary = await runWaves(kit, { tasksFilter: [] });
		expect(summary.complete).toBe(false); // the task ends needs_human → quarantined
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.tasks[0]).toMatchObject({ id: TASK.id, status: "quarantined" });

		const receipts = await readReceipts(kit);
		// The gate receipt and the primary pass receipt exist even though the
		// skeptic never answered cleanly: each pass was committed before the next
		// pass was dispatched, and the failed skeptic pass records needs_human.
		expect(receipts.events.map((e) => e.kind)).toEqual(["gate", "pass", "pass"]);
		const primary = receipts.events[1]!;
		if (primary.kind !== "pass") throw new Error("unreachable");
		expect(primary.value.review).toMatchObject({ pass: "primary", verdict: "approve" });
		const skepticEvent = receipts.events[2]!;
		if (skepticEvent.kind !== "pass") throw new Error("unreachable");
		expect(skepticEvent.value.review).toMatchObject({ pass: "skeptic", verdict: "needs_human" });
		const verdictRows = state.rows.filter((row) => row.kind === "verdict");
		expect(verdictRows[0]?.receipt).toBe(primary.opId);
		expect(verdictRows[1]?.receipt).toBe(skepticEvent.opId);
		await kit.loop.close();
		kit.lock.release();
	});
});

describe("parseVerdictStrict (M0-P11 reply contract)", () => {
	it("preserves every criteria entry 1:1 and flags malformed ones instead of filtering", () => {
		const parsed = parseVerdictStrict(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "line", path: "p", line: 1 }] }, {}], notes: "" }));
		expect(parsed.criteria).toHaveLength(2);
		expect(parsed.criteria[0]).toMatchObject({ id: "1", status: "pass", malformed: false });
		expect(parsed.criteria[1]).toMatchObject({ id: "", status: "unverifiable", malformed: true });
	});

	it("rejects prose around the JSON object (never extracts from surrounding text)", () => {
		const body = JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "gate", id: "unit" }] }] });
		expect(parseVerdictStrict(`Sure! ${body}`).verdict).toBe("needs_human");
		expect(parseVerdictStrict(`${body} hope that helps`).verdict).toBe("needs_human");
		expect(parseVerdictStrict(body).verdict).toBe("approve");
		expect(parseVerdictStrict("```json\n" + body + "\n```").verdict).toBe("approve");
	});
});

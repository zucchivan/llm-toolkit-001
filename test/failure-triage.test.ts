import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assessFailureTriage, FAILURE_TRIAGE_ASSESSMENT_FILE, fingerprintFailureTriageEvidence,
	persistFailureTriageAssessment, readFailureTriageAssessment, type FailureTriageEvidence,
} from "../src/engine/failure-triage.ts";
import { runWaves } from "../src/engine/waves.ts";
import { readSessionState } from "../src/engine/state.ts";
import type { VerifyTask } from "../src/engine/verifier.ts";
import { FakeJudgmentClient, fakeJudgmentResponse } from "../src/judgment/fake.ts";
import type { JudgmentAnswer, JudgmentClient, JudgmentRequest } from "../src/judgment/types.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { demoConfigToml } from "./demo-project.ts";
import { accomplish, bakeProject, scripted } from "./fixtures2.ts";
import { writeGateFile } from "./helpers2.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const TASK: VerifyTask = {
	id: "t1",
	title: "one",
	spec: "write src/one.ts",
	acceptance: ["When src/one.ts exists, the system shall export one."],
	baselineTreeSha: EMPTY_TREE,
	targetPaths: ["src/"],
};
const GATE_EVIDENCE: FailureTriageEvidence = {
	task: TASK,
	wave: 1,
	changedFiles: ["src/one.ts"],
	source: "gate",
	gate: {
		scopeOK: true,
		scopeBody: "",
		feedbackText: "GATES FAILED: private-failure-output; fix the named failure",
		failHash: "abc123",
		results: [
			{ name: "typecheck", passed: false, exit: 1, tail: "private-failure-output TYPESAFE_API_KEY=do-not-send-this", matched: true, durationMs: 12 },
			{ name: "unit", passed: false, exit: 1, tail: "expected one, received zero", matched: true, durationMs: 20 },
			{ name: "scope", passed: true, tail: "not-sent-passing-output", matched: true, durationMs: 0 },
		],
	},
};

type SemanticMode = "implementation" | "human";

function semanticClient(mode: SemanticMode = "implementation"): FakeJudgmentClient {
	return new FakeJudgmentClient((request) => fakeJudgmentResponse(
		request,
		semanticAnswers(request, mode),
		{ inputTokens: 222, outputTokens: 77 },
	));
}

function semanticAnswers(request: JudgmentRequest, mode: SemanticMode): Record<string, JudgmentAnswer> {
	const category = mode === "implementation" ? "implementation-defect" : "requirements-ambiguity";
	return Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
		if (question.type === "choice") {
			const labels = Object.keys(question.criteria);
			return [id, {
				type: "choice",
				choice: category,
				confidence: 0.97,
				probabilities: Object.fromEntries(labels.map((label) => [label, label === category ? 0.97 : 0.03 / (labels.length - 1)])),
			} satisfies JudgmentAnswer];
		}
		const probability = id.endsWith("_evidence") ? 0.99
			: id.endsWith("_actionable") ? mode === "implementation" ? 0.99 : 0.01
				: mode === "human" ? 0.99 : 0.01;
		return [id, { type: "noul", probability } satisfies JudgmentAnswer];
	}));
}

const triageConfig = () => demoConfigToml().replace(
	"enforceTargetPaths = true",
	"enforceTargetPaths = true\njevFailureTriageShadow = true",
);
const implWrite = (content: string) => [
	fauxAssistantMessage([fauxToolCall("write", { path: "src/one.ts", content })], { stopReason: "toolUse" }),
	fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
];
const verdict = (value: "approve" | "reject" | "needs_human", notes: string) => fauxAssistantMessage(JSON.stringify({
	verdict: value,
	criteria: [{
		id: "1",
		status: value === "approve" ? "pass" : value === "reject" ? "fail" : "unverifiable",
		...(value === "approve" ? { evidence: [{ kind: "line", path: "src/index.ts", line: 1 }] } : {}),
	}],
	notes,
}), { stopReason: "stop" });
const planResponse = () => fauxAssistantMessage(JSON.stringify({ tasks: [{
	id: TASK.id,
	title: TASK.title,
	spec: TASK.spec,
	dependsOn: [],
	acceptance: TASK.acceptance,
	targetPaths: TASK.targetPaths,
	priority: 1,
}] }), { stopReason: "stop" });

describe("shadow failure-triage assessment", () => {
	it("makes no judgment calls when disabled or credentials are missing", async () => {
		const client = new FakeJudgmentClient();
		let constructions = 0;
		const clientFactory = (): JudgmentClient => { constructions++; return client; };

		const off = await assessFailureTriage(GATE_EVIDENCE, { enabled: false, client, apiKey: "secret" });
		const noKey = await assessFailureTriage(GATE_EVIDENCE, { enabled: true, clientFactory, apiKey: "" });
		expect(off).toMatchObject({ status: "disabled", outcome: "unknown" });
		expect(noKey).toMatchObject({ status: "missing-credentials", outcome: "unknown" });
		expect(off.items.every((item) => item.outcome === "unknown")).toBe(true);
		expect(noKey.items.every((item) => item.outcome === "unknown")).toBe(true);
		expect(constructions).toBe(0);
		expect(client.requests).toHaveLength(0);
	});

	it("batches narrow typed questions and persists provenance without raw evidence or credentials", async () => {
		const root = await mkdtemp(join(tmpdir(), "kit-failure-triage-"));
		const client = semanticClient();
		let suppliedKey = "";
		const assessment = await assessFailureTriage(GATE_EVIDENCE, {
			enabled: true,
			clientFactory: (apiKey) => { suppliedKey = apiKey; return client; },
			apiKey: "do-not-persist-this",
			now: () => new Date("2026-11-19T12:00:00.000Z"),
		});
		expect(assessment).toMatchObject({
			status: "assessed",
			outcome: "implementation-feedback",
			model: "jev-latest",
			assessedAt: "2026-11-19T12:00:00.000Z",
			usage: { inputTokens: 222, outputTokens: 77 },
			thresholds: { noulYes: 0.85, noulNo: 0.15, choiceConfidence: 0.85, choiceProbability: 0.85 },
		});
		expect(assessment.items.map((item) => item.outcome)).toEqual(["implementation-feedback", "implementation-feedback"]);
		expect(assessment.items.every((item) => item.category === "implementation-defect")).toBe(true);
		expect(client.requests).toHaveLength(1);
		expect(Object.keys(client.requests[0]!.questions)).toHaveLength(8);
		expect(Object.values(client.requests[0]!.questions).filter((question) => question.type === "noul")).toHaveLength(6);
		expect(Object.values(client.requests[0]!.questions).filter((question) => question.type === "choice")).toHaveLength(2);
		const serializedRequest = JSON.stringify(client.requests[0]);
		expect(serializedRequest).not.toContain("do-not-send-this");
		expect(serializedRequest).not.toContain("not-sent-passing-output");
		expect(suppliedKey).toBe("do-not-persist-this");

		await persistFailureTriageAssessment(root, assessment);
		const stored = await readFile(join(root, FAILURE_TRIAGE_ASSESSMENT_FILE), "utf8");
		expect(stored).not.toContain("do-not-persist-this");
		expect(stored).not.toContain("do-not-send-this");
		expect(stored).not.toContain("private-failure-output");
		const provenance = JSON.parse(stored) as typeof assessment;
		expect(provenance).not.toHaveProperty("evidence");
		expect(provenance.evidenceFingerprint).toBe(fingerprintFailureTriageEvidence(GATE_EVIDENCE));
		expect(Object.keys(provenance.answers)).toHaveLength(8);
		expect(Object.values(provenance.answers).every((answer) => answer.type === "noul"
			? answer.probability >= 0 && answer.probability <= 1
			: answer.confidence >= 0 && answer.confidence <= 1)).toBe(true);
	});

	it("keeps uncertain and internally conflicting outcomes unknown", async () => {
		const uncertain = await assessFailureTriage(GATE_EVIDENCE, { enabled: true, client: new FakeJudgmentClient() });
		expect(uncertain).toMatchObject({ status: "assessed", outcome: "unknown" });
		expect(uncertain.items.every((item) => item.outcome === "unknown")).toBe(true);

		const conflicting = new FakeJudgmentClient((request) => fakeJudgmentResponse(request,
			Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
				if (question.type === "noul") return [id, { type: "noul", probability: 0.99 } satisfies JudgmentAnswer];
				const labels = Object.keys(question.criteria);
				return [id, {
					type: "choice", choice: "implementation-defect", confidence: 0.99,
					probabilities: Object.fromEntries(labels.map((label) => [label, label === "implementation-defect" ? 0.9 : 0.9])),
				} satisfies JudgmentAnswer];
			}))));
		const conflict = await assessFailureTriage(GATE_EVIDENCE, { enabled: true, client: conflicting });
		expect(conflict).toMatchObject({ status: "assessed", outcome: "unknown" });
		expect(conflict.items.every((item) => item.outcome === "unknown" && item.category === undefined)).toBe(true);
	});

	it.each([
		["missing answers", new FakeJudgmentClient((request) => fakeJudgmentResponse(request, {}))],
		["out-of-range probabilities", new FakeJudgmentClient((request) => fakeJudgmentResponse(request,
			Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", probability: 2 } satisfies JudgmentAnswer]))))],
		["network errors", new FakeJudgmentClient(async () => { throw new Error("network unavailable"); })],
	])("fails soft to unknown on %s", async (_name, client) => {
		const assessment = await assessFailureTriage(GATE_EVIDENCE, { enabled: true, client });
		expect(assessment).toMatchObject({ status: "unavailable", outcome: "unknown" });
		expect(assessment.answers).toEqual({});
		expect(assessment.items.every((item) => item.outcome === "unknown")).toBe(true);
	});

	it("invalidates conclusions, but not typed provenance, when evidence is stale", async () => {
		const root = await mkdtemp(join(tmpdir(), "kit-failure-triage-stale-"));
		const assessed = await assessFailureTriage(GATE_EVIDENCE, { enabled: true, client: semanticClient() });
		await persistFailureTriageAssessment(root, assessed);
		const changedFingerprint = fingerprintFailureTriageEvidence({
			...GATE_EVIDENCE,
			changedFiles: ["src/other.ts"],
		});
		const stale = await readFailureTriageAssessment(root, changedFingerprint);
		expect(stale).toMatchObject({ status: "stale", outcome: "unknown" });
		expect(stale?.items.every((item) => item.outcome === "unknown" && item.category === undefined)).toBe(true);
		expect(Object.keys(stale?.answers ?? {})).toHaveLength(8);
		expect(await readFailureTriageAssessment(root, assessed.evidenceFingerprint)).toMatchObject({
			status: "assessed", outcome: "implementation-feedback",
		});
	});
});

describe("failure-triage wave integration remains shadow-only", () => {
	it("does not call Jev when the wave config opt-in is absent", async () => {
		const { project, kit, models } = await bakeProject({
			buildFauxModels,
			configToml: demoConfigToml().replace("retryLimit = 2", "retryLimit = 0"),
		});
		expect(kit.loop.config.gates.jevFailureTriageShadow).toBe(false);
		await scripted(kit, [planResponse(), ...implWrite("export const BROKEN = true;\n")], models.faux);
		await accomplish(kit);
		await writeGateFile(project.root);
		const client = new FakeJudgmentClient();

		const summary = await runWaves(kit, { tasksFilter: [], judgmentClient: client });
		expect(summary.complete).toBe(false);
		expect(summary.quarantined).toEqual([TASK.id]);
		expect(client.requests).toHaveLength(0);
		expect(existsSync(join(project.root, FAILURE_TRIAGE_ASSESSMENT_FILE))).toBe(false);
		expect((await readSessionState(kit.loop.harness)).router.tasks[0]?.status).toBe("quarantined");
		await kit.loop.close();
		kit.lock.release();
	});

	it("preserves gate feedback and the normal retry even when Jev advises human review", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels, configToml: triageConfig() });
		await scripted(kit, [
			planResponse(),
			...implWrite("export const BROKEN = true;\n"),
			...implWrite("export const one = 1;\n"),
			verdict("approve", "primary approval"),
			verdict("approve", "skeptic approval"),
		], models.faux);
		await accomplish(kit);
		await writeGateFile(project.root);
		const client = semanticClient("human");

		const summary = await runWaves(kit, { tasksFilter: [], judgmentClient: client });
		expect(summary.complete).toBe(true);
		expect(client.requests).toHaveLength(1);
		const state = await readSessionState(kit.loop.harness);
		const task = state.router.tasks[0]!;
		expect(task).toMatchObject({ status: "done", waveCount: 2 });
		expect(task.feedback).toEqual(expect.arrayContaining([
			expect.objectContaining({ wave: 1, from: "gate", text: expect.stringContaining("GATES FAILED") }),
		]));
		expect(state.rows.filter((row) => row.kind === "verdict").map((row) => row.verb)).toEqual([
			"verify:approve", "verify:skeptic:approve",
		]);
		const stored = JSON.parse(await readFile(join(project.root, FAILURE_TRIAGE_ASSESSMENT_FILE), "utf8")) as Awaited<ReturnType<typeof assessFailureTriage>>;
		expect(stored).toMatchObject({ source: "gate", wave: 1, status: "assessed", outcome: "human-review" });
		await kit.loop.close();
		kit.lock.release();
	});

	it("preserves duplicate-gate quarantine and rollback when Jev has network errors", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels, configToml: triageConfig() });
		await scripted(kit, [
			planResponse(),
			...implWrite("export const BROKEN = true;\n"),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
		], models.faux);
		await accomplish(kit);
		await writeGateFile(project.root);
		const client = new FakeJudgmentClient(async () => { throw new Error("offline"); });

		const summary = await runWaves(kit, { tasksFilter: [], judgmentClient: client });
		expect(summary.complete).toBe(false);
		expect(summary.quarantined).toEqual([TASK.id]);
		expect(client.requests).toHaveLength(2);
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.tasks[0]?.status).toBe("quarantined");
		expect(state.rows.some((row) => row.verb === "duplicate-gate-hash-quarantine")).toBe(true);
		await expect(readFile(join(project.root, "src", "one.ts"), "utf8")).rejects.toThrow();
		expect(existsSync(join(project.root, FAILURE_TRIAGE_ASSESSMENT_FILE))).toBe(false);
		await kit.loop.close();
		kit.lock.release();
	});

	it("preserves verifier rejection feedback and retry when Jev disagrees", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels, configToml: triageConfig() });
		await scripted(kit, [
			planResponse(),
			...implWrite("export const one = 0;\n"),
			verdict("reject", "export one, not zero"),
			...implWrite("export const one = 1;\n"),
			verdict("approve", "fixed"),
			verdict("approve", "no remaining refutation"),
		], models.faux);
		await accomplish(kit);
		const client = semanticClient("human");

		const summary = await runWaves(kit, { tasksFilter: [], judgmentClient: client });
		expect(summary.complete).toBe(true);
		expect(client.requests).toHaveLength(1);
		const task = (await readSessionState(kit.loop.harness)).router.tasks[0]!;
		expect(task).toMatchObject({ status: "done", waveCount: 2 });
		expect(task.feedback).toEqual(expect.arrayContaining([
			expect.objectContaining({ wave: 1, from: "verifier", text: "export one, not zero" }),
		]));
		const stored = JSON.parse(await readFile(join(project.root, FAILURE_TRIAGE_ASSESSMENT_FILE), "utf8")) as Awaited<ReturnType<typeof assessFailureTriage>>;
		expect(stored).toMatchObject({ source: "verifier", wave: 1, status: "assessed", outcome: "human-review" });
		await kit.loop.close();
		kit.lock.release();
	});

	it("preserves needs_human quarantine even when Jev suggests implementation feedback", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels, configToml: triageConfig() });
		await scripted(kit, [
			planResponse(),
			...implWrite("export const one = 1;\n"),
			verdict("needs_human", "a human must choose the public API"),
		], models.faux);
		await accomplish(kit);
		const client = semanticClient("implementation");

		const summary = await runWaves(kit, { tasksFilter: [], judgmentClient: client });
		expect(summary.complete).toBe(false);
		expect(summary.quarantined).toEqual([TASK.id]);
		expect(client.requests).toHaveLength(1);
		const state = await readSessionState(kit.loop.harness);
		const task = state.router.tasks[0]!;
		expect(task).toMatchObject({ status: "quarantined", waveCount: 1 });
		expect(task.feedback.some((feedback) => feedback.from === "verifier")).toBe(false);
		expect(state.rows.some((row) => row.kind === "task" && row.verb === "quarantined" && row.reason === "verifier needs a human")).toBe(true);
		await expect(readFile(join(project.root, "src", "one.ts"), "utf8")).rejects.toThrow();
		const stored = JSON.parse(await readFile(join(project.root, FAILURE_TRIAGE_ASSESSMENT_FILE), "utf8")) as Awaited<ReturnType<typeof assessFailureTriage>>;
		expect(stored).toMatchObject({ source: "verifier", status: "assessed", outcome: "implementation-feedback" });
		await kit.loop.close();
		kit.lock.release();
	});
});

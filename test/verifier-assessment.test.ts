import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assessVerifier, fingerprintVerifierEvidence, persistVerifierAssessment, readVerifierAssessment,
	VERIFIER_ASSESSMENT_FILE, type VerifierEvidence,
} from "../src/engine/verifier-assessment.ts";
import { runVerify, type VerifyTask } from "../src/engine/verifier.ts";
import { runWaves } from "../src/engine/waves.ts";
import { readSessionState } from "../src/engine/state.ts";
import { FakeJudgmentClient, fakeJudgmentResponse } from "../src/judgment/fake.ts";
import type { JudgmentAnswer, JudgmentClient, JudgmentRequest } from "../src/judgment/types.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { demoConfigToml } from "./demo-project.ts";
import { accomplish, bakeProject, scripted } from "./fixtures2.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const TASK: VerifyTask = {
	id: "t1",
	title: "one",
	spec: "write src/one.ts",
	acceptance: ["When src/one.ts exists, the system shall export one.", "The implementation shall have deterministic coverage."],
	baselineTreeSha: EMPTY_TREE,
	targetPaths: ["src/"],
};
const EVIDENCE: VerifierEvidence = {
	task: TASK,
	diff: {
		stat: "src/one.ts (new)\ntest/one.test.ts (new)",
		files: ["src/one.ts", "test/one.test.ts"],
		patch: "private-source-text: export const one = 1;",
		patchTruncated: false,
		patchAvailable: true,
	},
	gateSummary: "scope: pass, unit: pass",
	primary: {
		verdict: "approve",
		criteria: [{ id: "1", status: "pass" }, { id: "2", status: "pass" }],
		notes: "primary approval",
	},
	skeptic: {
		verdict: "approve",
		criteria: [{ id: "1", status: "pass" }, { id: "2", status: "pass" }],
		notes: "skeptic approval",
	},
};

function semanticClient(mode: "approval" | "rejection" = "approval"): FakeJudgmentClient {
	return new FakeJudgmentClient((request) => fakeJudgmentResponse(request, semanticAnswers(request, mode), { inputTokens: 321, outputTokens: 54 }));
}

function semanticAnswers(request: JudgmentRequest, mode: "approval" | "rejection"): Record<string, JudgmentAnswer> {
	return Object.fromEntries(Object.keys(request.questions).map((id) => {
		const satisfied = id.endsWith("_satisfied");
		const violated = id.endsWith("_violated");
		const probability = mode === "approval"
			? violated ? 0.01 : 0.99
			: satisfied ? 0.01 : 0.99;
		return [id, { type: "noul", probability } satisfies JudgmentAnswer];
	}));
}

const verdict = (value: "approve" | "reject" | "needs_human", notes = value, criteriaCount = 1) =>
	fauxAssistantMessage(JSON.stringify({
		verdict: value,
		criteria: Array.from({ length: criteriaCount }, (_, index) => ({
			id: `${index + 1}`,
			status: value === "approve" ? "pass" : value === "reject" ? "fail" : "unverifiable",
			// M0-P11: approving passes cite valid evidence (a fixture file line on the checked tree)
			...(value === "approve" ? { evidence: [{ kind: "line", path: "src/index.ts", line: 1 }] } : {}),
		})),
		notes,
	}), { stopReason: "stop" });

describe("shadow verifier assessment", () => {
	it("makes no judgment calls when disabled or credentials are missing", async () => {
		const client = new FakeJudgmentClient();
		let constructions = 0;
		const clientFactory = (): JudgmentClient => { constructions++; return client; };

		const off = await assessVerifier(EVIDENCE, { enabled: false, client, apiKey: "secret" });
		const noKey = await assessVerifier(EVIDENCE, { enabled: true, clientFactory, apiKey: "" });
		expect(off).toMatchObject({ status: "disabled", outcome: "unknown" });
		expect(noKey).toMatchObject({ status: "missing-credentials", outcome: "unknown" });
		expect(off.criteria.every((criterion) => criterion.status === "unknown")).toBe(true);
		expect(noKey.criteria.every((criterion) => criterion.status === "unknown")).toBe(true);
		expect(constructions).toBe(0);
		expect(client.requests).toHaveLength(0);
	});

	it("batches narrow typed questions and persists provenance without credentials or raw evidence", async () => {
		const root = await mkdtemp(join(tmpdir(), "kit-verifier-assessment-"));
		const client = semanticClient();
		let suppliedKey = "";
		const assessment = await assessVerifier(EVIDENCE, {
			enabled: true,
			clientFactory: (apiKey) => { suppliedKey = apiKey; return client; },
			apiKey: "do-not-persist-this",
			now: () => new Date("2026-11-18T12:00:00.000Z"),
		});
		expect(assessment).toMatchObject({
			status: "assessed", outcome: "supports-approval", model: "jev-latest",
			assessedAt: "2026-11-18T12:00:00.000Z", usage: { inputTokens: 321, outputTokens: 54 },
			thresholds: { noulYes: 0.85, noulNo: 0.15 },
		});
		expect(assessment.criteria.map((criterion) => criterion.status)).toEqual(["supported", "supported"]);
		expect(client.requests).toHaveLength(1);
		expect(Object.keys(client.requests[0]!.questions)).toHaveLength(6);
		expect(Object.values(client.requests[0]!.questions).every((question) => question.type === "noul")).toBe(true);
		expect(client.requests[0]!.state["acceptanceCriteria"]).toHaveLength(2);
		expect(suppliedKey).toBe("do-not-persist-this");

		await persistVerifierAssessment(root, assessment);
		const stored = await readFile(join(root, VERIFIER_ASSESSMENT_FILE), "utf8");
		expect(stored).not.toContain("do-not-persist-this");
		expect(stored).not.toContain("private-source-text");
		const provenance = JSON.parse(stored) as typeof assessment;
		expect(provenance).not.toHaveProperty("evidence");
		expect(provenance.evidenceFingerprint).toBe(fingerprintVerifierEvidence(EVIDENCE));
		expect(Object.keys(provenance.answers)).toHaveLength(6);
		expect(Object.values(provenance.answers).every((answer) => answer.type === "noul" && answer.probability >= 0 && answer.probability <= 1)).toBe(true);
	});

	it("keeps low-confidence and internally conflicting answers unknown", async () => {
		const uncertain = await assessVerifier(EVIDENCE, { enabled: true, client: new FakeJudgmentClient() });
		expect(uncertain).toMatchObject({ status: "assessed", outcome: "unknown" });
		expect(uncertain.criteria.every((criterion) => criterion.status === "unknown")).toBe(true);

		const conflicting = new FakeJudgmentClient((request) => fakeJudgmentResponse(request,
			Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", probability: 0.99 } satisfies JudgmentAnswer]))));
		const conflict = await assessVerifier(EVIDENCE, { enabled: true, client: conflicting });
		expect(conflict).toMatchObject({ status: "assessed", outcome: "unknown" });
		expect(conflict.criteria.every((criterion) => criterion.status === "unknown")).toBe(true);
	});

	it.each([
		["missing answers", new FakeJudgmentClient((request) => fakeJudgmentResponse(request, {}))],
		["out-of-range probabilities", new FakeJudgmentClient((request) => fakeJudgmentResponse(request,
			Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", probability: 2 } satisfies JudgmentAnswer]))))],
		["network errors", new FakeJudgmentClient(async () => { throw new Error("network unavailable"); })],
	])("fails soft to unknown on %s", async (_name, client) => {
		const assessment = await assessVerifier(EVIDENCE, { enabled: true, client });
		expect(assessment).toMatchObject({ status: "unavailable", outcome: "unknown" });
		expect(assessment.answers).toEqual({});
		expect(assessment.criteria.every((criterion) => criterion.status === "unknown")).toBe(true);
	});

	it("invalidates conclusions, but not raw provenance, when evidence is stale", async () => {
		const root = await mkdtemp(join(tmpdir(), "kit-verifier-stale-"));
		const assessed = await assessVerifier(EVIDENCE, { enabled: true, client: semanticClient() });
		await persistVerifierAssessment(root, assessed);
		const changedFingerprint = fingerprintVerifierEvidence({ ...EVIDENCE, gateSummary: "scope: fail" });
		const stale = await readVerifierAssessment(root, changedFingerprint);
		expect(stale).toMatchObject({ status: "stale", outcome: "unknown" });
		expect(stale?.criteria.every((criterion) => criterion.status === "unknown")).toBe(true);
		expect(Object.keys(stale?.answers ?? {})).toHaveLength(6);
		expect(await readVerifierAssessment(root, assessed.evidenceFingerprint)).toMatchObject({ status: "assessed", outcome: "supports-approval" });
	});
});

describe("verifier integration remains authoritative", () => {
	it("does not call an injected Jev client when the config opt-in is absent", async () => {
		const { kit, models } = await bakeProject({ buildFauxModels });
		expect(kit.loop.config.gates.jevVerifierShadow).toBe(false);
		models.faux.setResponses([verdict("approve", "primary", 2), verdict("approve", "skeptic", 2)]);
		const client = new FakeJudgmentClient();
		const result = await runVerify(kit, TASK, "scope: pass", { jevShadow: { client } });
		expect(result.verdict).toBe("approve");
		expect(client.requests).toHaveLength(0);
		expect(existsSync(join(kit.loop.paths.root, VERIFIER_ASSESSMENT_FILE))).toBe(false);
		const state = await readSessionState(kit.loop.harness);
		expect(state.rows.map((row) => row.verb)).toEqual(["verify:approve", "verify:skeptic:approve"]);
		await kit.loop.close();
		kit.lock.release();
	});

	it("makes no client construction without a key and preserves both existing approvals", async () => {
		const { kit, models } = await bakeProject({ buildFauxModels });
		models.faux.setResponses([verdict("approve", "primary", 2), verdict("approve", "skeptic", 2)]);
		let constructions = 0;
		const result = await runVerify(kit, TASK, "scope: pass", {
			jevShadow: { enabled: true, apiKey: "", clientFactory: () => { constructions++; return new FakeJudgmentClient(); } },
		});
		expect(result.verdict).toBe("approve");
		expect(constructions).toBe(0);
		expect(existsSync(join(kit.loop.paths.root, VERIFIER_ASSESSMENT_FILE))).toBe(false);
		const state = await readSessionState(kit.loop.harness);
		expect(state.rows.map((row) => row.verb)).toEqual(["verify:approve", "verify:skeptic:approve"]);
		await kit.loop.close();
		kit.lock.release();
	});

	it("preserves a rejection and durable router state when Jev errors", async () => {
		const { kit, models } = await bakeProject({ buildFauxModels });
		models.faux.setResponses([verdict("reject", "existing verifier rejection")]);
		const before = await readSessionState(kit.loop.harness);
		const result = await runVerify(kit, TASK, "scope: pass", {
			jevShadow: { enabled: true, client: new FakeJudgmentClient(async () => { throw new Error("offline"); }) },
		});
		expect(result.verdict).toBe("reject");
		expect(result.notes).toBe("existing verifier rejection");
		const after = await readSessionState(kit.loop.harness);
		expect(after.router).toEqual(before.router);
		expect(after.rows.map((row) => row.verb)).toEqual(["verify:reject"]);
		expect(existsSync(join(kit.loop.paths.root, VERIFIER_ASSESSMENT_FILE))).toBe(false);
		await kit.loop.close();
		kit.lock.release();
	});

	it("does not enforce a Jev rejection: gates, approvals, task completion, and delivery stay unchanged", async () => {
		const { kit, models } = await bakeProject({
			buildFauxModels,
			configToml: demoConfigToml().replace("enforceTargetPaths = true", "enforceTargetPaths = true\njevVerifierShadow = true"),
		});
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [{
				id: TASK.id, title: TASK.title, spec: TASK.spec, dependsOn: [], acceptance: [TASK.acceptance[0]!],
				targetPaths: TASK.targetPaths, priority: 1,
			}] }), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/one.ts", content: "export const one = 1;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			verdict("approve", "primary approval"),
			verdict("approve", "skeptic approval"),
		], models.faux);
		await accomplish(kit);
		const client = semanticClient("rejection");
		const summary = await runWaves(kit, { tasksFilter: [], judgmentClient: client });
		expect(summary.complete).toBe(true);
		expect(client.requests).toHaveLength(1);
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.tasks[0]).toMatchObject({ id: TASK.id, status: "done", waveCount: 1 });
		// Successful gates intentionally add no row; crucially Jev adds no failure/feedback row.
		expect(state.rows.filter((row) => row.kind === "gate")).toEqual([]);
		expect(state.rows.filter((row) => row.kind === "verdict").map((row) => row.verb)).toEqual([
			"verify:approve", "verify:skeptic:approve",
		]);
		expect(state.rows.filter((row) => row.kind === "delivery")).toMatchObject([
			expect.objectContaining({ task: TASK.id, wave: 1, verb: "not_requested", planRevision: expect.any(String) }),
		]);
		const stored = JSON.parse(await readFile(join(kit.loop.paths.root, VERIFIER_ASSESSMENT_FILE), "utf8")) as Awaited<ReturnType<typeof assessVerifier>>;
		expect(stored).toMatchObject({ status: "assessed", outcome: "supports-rejection" });
		await kit.loop.close();
		kit.lock.release();
	});
});

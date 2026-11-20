import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGatesCommand } from "../src/adoption/cli.ts";
import {
	evaluateGates, persistGateAssessment, readGateAssessment, staleAssessment,
} from "../src/adoption/evaluate.ts";
import { analyzeGaps } from "../src/adoption/gaps.ts";
import { FakeJudgmentClient, fakeJudgmentResponse } from "../src/judgment/fake.ts";
import type { JudgmentAnswer, JudgmentClient, JudgmentRequest } from "../src/judgment/types.ts";

async function project(command = "tsc --noEmit"): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "kit-evaluate-"));
	await mkdir(join(root, "evals"), { recursive: true });
	await writeFile(join(root, "package.json"), JSON.stringify({
		name: "app", private: true,
		scripts: { test: "node --test", "verify:types": command },
	}), "utf8");
	await writeFile(join(root, "evals", "recipes.toml"), '[custom-check]\ncmd = "npm run verify:types"\n', "utf8");
	return root;
}

function confidentClient(): FakeJudgmentClient {
	return new FakeJudgmentClient(async (request) => fakeJudgmentResponse(request, confidentAnswers(request), { inputTokens: 123, outputTokens: 45 }));
}

function confidentAnswers(request: JudgmentRequest): Record<string, JudgmentAnswer> {
	return Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
		if (question.type === "noul") return [id, { type: "noul", probability: 0.95 } satisfies JudgmentAnswer];
		const labels = Object.keys(question.criteria);
		return [id, {
			type: "choice", choice: "typecheck", confidence: 0.9,
			probabilities: Object.fromEntries(labels.map((label) => [label, label === "typecheck" ? 0.9 : 0.1 / (labels.length - 1)])),
		} satisfies JudgmentAnswer];
	}));
}

const silentIo = () => ({ interactive: false, log: () => {}, error: () => {} });

describe("shadow gate evaluation", () => {
	it("makes no client calls when off or credentials are missing and preserves the deterministic report", async () => {
		const root = await project();
		const deterministic = await analyzeGaps(root);
		let constructions = 0;
		const client = new FakeJudgmentClient();
		const clientFactory = (): JudgmentClient => { constructions++; return client; };

		const off = await evaluateGates(root, { enabled: false, apiKey: "secret", clientFactory });
		expect(off.assessment.status).toBe("disabled");
		const noKey = await evaluateGates(root, { enabled: true, clientFactory });
		expect(noKey.assessment.status).toBe("missing-credentials");
		expect(constructions).toBe(0);
		expect(client.requests).toHaveLength(0);
		expect(off.report).toEqual(deterministic);
		expect(noKey.report).toEqual(deterministic);
		expect(existsSync(join(root, ".orch", "gate-assessment.json"))).toBe(false);
	});

	it("keeps plain gates list offline and deterministic even when Jev credentials exist", async () => {
		const root = await project();
		const client = new FakeJudgmentClient();
		const lines: string[] = [];
		const code = await runGatesCommand(root, ["list", "--json"], {
			interactive: false, log: (line) => lines.push(line), error: () => {},
		}, { judgmentClient: client, env: { TYPESAFE_API_KEY: "secret" } });
		expect(code).toBe(0);
		expect(JSON.parse(lines.join("\n"))).toEqual(await analyzeGaps(root));
		expect(client.requests).toHaveLength(0);
		expect(existsSync(join(root, ".orch", "gate-assessment.json"))).toBe(false);
	});

	it("batches independent questions and leaves low-confidence classifications, matches, and quality unknown", async () => {
		const root = await project();
		const client = new FakeJudgmentClient();
		const result = await evaluateGates(root, { enabled: true, client });
		expect(result.assessment.status).toBe("assessed");
		expect(client.requests).toHaveLength(1);
		expect(Object.keys(client.requests[0]!.questions).length).toBeGreaterThanOrEqual(7);
		expect(result.assessment.scriptClassifications).toHaveLength(1);
		expect(result.assessment.scriptClassifications[0]).toMatchObject({ name: "verify:types", status: "unknown" });
		expect(result.assessment.recipeClassifications[0]).toMatchObject({ name: "custom-check", status: "unknown" });
		expect(result.assessment.recipeMatches.every((item) => item.match === "unknown")).toBe(true);
		expect(result.assessment.recipeQuality).toEqual([expect.objectContaining({ recipe: "custom-check", quality: "unknown" })]);
		expect(result.report).toEqual(await analyzeGaps(root));
	});

	it("persists typed provenance without executing commands or changing refresh approval", async () => {
		const marker = "executed-by-evaluation";
		const root = await project(`node -e "require('fs').writeFileSync('${marker}','x')"`);
		const client = confidentClient();
		const output: string[] = [];
		const code = await runGatesCommand(root, ["evaluate", "--json"], {
			interactive: false, log: (line) => output.push(line), error: () => {},
		}, { judgmentClient: client, env: { TYPESAFE_API_KEY: "do-not-persist-this" } });
		expect(code).toBe(0);
		const result = JSON.parse(output.join("\n")) as Awaited<ReturnType<typeof evaluateGates>>;
		expect(result.assessment.status).toBe("assessed");
		expect(result.assessment.scriptClassifications[0]).toMatchObject({ category: "typecheck", status: "classified" });
		expect(result.assessment.recipeClassifications[0]).toMatchObject({ category: "typecheck", status: "classified" });
		expect(result.assessment.recipeMatches.every((item) => item.match === "matches")).toBe(true);
		expect(result.assessment.recipeQuality[0]).toMatchObject({ quality: "adequate" });

		const assessmentPath = join(root, ".orch", "gate-assessment.json");
		const stored = await readFile(assessmentPath, "utf8");
		expect(stored).not.toContain("do-not-persist-this");
		const provenance = JSON.parse(stored) as typeof result.assessment;
		expect(provenance).toMatchObject({
			model: "jev-latest", evidenceFingerprint: result.assessment.evidenceFingerprint,
			usage: { inputTokens: 123, outputTokens: 45 }, thresholds: { noulYes: 0.7, noulNo: 0.3 },
		});
		expect(Object.keys(provenance.answers).length).toBe(Object.keys(provenance.questions).length);
		expect(existsSync(join(root, marker))).toBe(false);
		expect(existsSync(join(root, "evals", "recipes.auto.toml"))).toBe(false);
		expect(existsSync(join(root, ".orch", "gate-decisions.json"))).toBe(false);

		expect(await runGatesCommand(root, ["refresh"], silentIo())).toBe(0);
		expect(existsSync(join(root, "evals", "recipes.auto.toml"))).toBe(false);
		expect(existsSync(join(root, ".orch", "gate-decisions.json"))).toBe(false);
	});

	it("fails open to the deterministic report on judgment errors", async () => {
		const root = await project();
		const client = new FakeJudgmentClient(async () => { throw new Error("network unavailable"); });
		const result = await evaluateGates(root, { enabled: true, client });
		expect(result.assessment).toMatchObject({ status: "unavailable", error: "network unavailable" });
		expect(result.assessment.scriptClassifications.every((item) => item.status === "unknown")).toBe(true);
		expect(result.assessment.recipeMatches.every((item) => item.match === "unknown")).toBe(true);
		expect(result.assessment.recipeQuality.every((item) => item.quality === "unknown")).toBe(true);
		expect(result.report).toEqual(await analyzeGaps(root));
		expect(existsSync(join(root, ".orch", "gate-assessment.json"))).toBe(false);
	});

	it("turns confident conclusions unknown when their evidence is stale", async () => {
		const root = await project();
		const result = await evaluateGates(root, { enabled: true, client: confidentClient() });
		expect(result.assessment.scriptClassifications[0]?.status).toBe("classified");
		await persistGateAssessment(root, result.assessment);
		const stale = await readGateAssessment(root, "different-current-evidence");
		expect(stale?.status).toBe("stale");
		expect(stale?.scriptClassifications.every((item) => item.status === "unknown" && item.category === undefined)).toBe(true);
		expect(stale?.recipeMatches.every((item) => item.match === "unknown")).toBe(true);
		expect(stale?.recipeQuality.every((item) => item.quality === "unknown")).toBe(true);
		expect(Object.keys(stale?.answers ?? {})).not.toHaveLength(0);
		expect(staleAssessment(result.assessment).status).toBe("stale");
	});
});

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { JudgmentAnswer, JudgmentClient } from "../judgment/types.ts";
import { atomicWriteJson, readJson } from "../util/fsx.ts";
import { discoverProject } from "./discovery.ts";
import {
	buildEvaluationPlan, JEV_SHADOW_MODEL, JEV_SHADOW_POLICY_VERSION, JEV_SHADOW_THRESHOLDS,
	type EvaluationPlan,
} from "./evaluation-policy.ts";
import { analyzeGaps } from "./gaps.ts";
import type {
	DiscoveredPackage, GateAssessment, GateCategory, GateEvaluationResult, GapReport,
	RecipeQualityAssessment, RecipeSurfaceMatch, ScriptClassification,
} from "./types.ts";

export const GATE_ASSESSMENT_FILE = join(".orch", "gate-assessment.json");
const EMPTY_USAGE = { inputTokens: null, outputTokens: null } as const;

export interface EvaluateGatesOptions {
	/** The CLI opts in by selecting `gates evaluate`; list and refresh never enable this. */
	enabled: boolean;
	client?: JudgmentClient;
	/** Test/runtime injection; called only after opt-in, credentials, and nonempty questions. */
	clientFactory?: (apiKey: string, model: string) => JudgmentClient;
	apiKey?: string;
	model?: string;
	now?: () => Date;
}

/** Evaluate semantic questions without executing commands or changing adoption state. */
export async function evaluateGates(root: string, options: EvaluateGatesOptions): Promise<GateEvaluationResult> {
	const discovery = await discoverProject(root);
	const report = await analyzeGaps(root, discovery);
	const packages = [discovery.rootPackage, ...discovery.workspaces].filter((pkg): pkg is DiscoveredPackage => Boolean(pkg));
	const plan = buildEvaluationPlan(report, packages);
	const evidenceFingerprint = fingerprintPlan(plan);
	const model = options.model ?? JEV_SHADOW_MODEL;
	const base = emptyAssessment(plan, evidenceFingerprint, model);
	if (!options.enabled) return { report, assessment: { ...base, status: "disabled" } };
	if (!Object.keys(plan.questions).length) return { report, assessment: { ...base, status: "no-questions" } };

	let client = options.client;
	if (!client && !options.apiKey?.trim()) return { report, assessment: { ...base, status: "missing-credentials" } };
	try {
		if (!client && options.clientFactory) client = options.clientFactory(options.apiKey!, model);
		if (!client) {
			const { TypeSafeJudgmentClient } = await import("../judgment/typesafe.ts");
			client = new TypeSafeJudgmentClient({ apiKey: options.apiKey!, model });
		}
		// All independent questions use one request and one shared, filtered state.
		const response = await client.judge({ state: plan.state, questions: plan.questions, model });
		return {
			report,
			assessment: {
				...base,
				status: "assessed",
				model: response.model,
				answers: response.answers,
				usage: response.usage,
				assessedAt: (options.now?.() ?? new Date()).toISOString(),
				scriptClassifications: classifyScripts(plan.scripts, response.answers),
				recipeClassifications: classifyRecipes(plan.recipes, response.answers),
				recipeMatches: matchRecipes(plan.matches, response.answers),
				recipeQuality: assessQuality(plan.quality, response.answers),
			},
		};
	} catch (err) {
		return {
			report,
			assessment: {
				...base, status: "unavailable", error: (err as Error).message || String(err),
				scriptClassifications: classifyScripts(plan.scripts, {}),
				recipeClassifications: classifyRecipes(plan.recipes, {}),
				recipeMatches: matchRecipes(plan.matches, {}),
				recipeQuality: assessQuality(plan.quality, {}),
			},
		};
	}
}

/** Only a completed assessment is persisted; unavailable/off evaluations keep prior evidence. */
export async function persistGateAssessment(root: string, assessment: GateAssessment): Promise<void> {
	if (assessment.status !== "assessed") throw new Error("only completed shadow assessments can be persisted");
	await atomicWriteJson(join(root, GATE_ASSESSMENT_FILE), assessment);
}

/** A fingerprint mismatch invalidates conclusions while retaining raw provenance for inspection. */
export async function readGateAssessment(root: string, currentEvidenceFingerprint: string): Promise<GateAssessment | undefined> {
	const assessment = await readJson<GateAssessment>(join(root, GATE_ASSESSMENT_FILE));
	if (!assessment || assessment.version !== 1 || assessment.shadow !== true) return undefined;
	if (assessment.evidenceFingerprint === currentEvidenceFingerprint) return assessment;
	return staleAssessment(assessment);
}

export function fingerprintGateEvidence(report: GapReport, packages: readonly DiscoveredPackage[]): string {
	return fingerprintPlan(buildEvaluationPlan(report, packages));
}

export function staleAssessment(assessment: GateAssessment): GateAssessment {
	return {
		...assessment,
		status: "stale",
		scriptClassifications: assessment.scriptClassifications.map((item) => ({ ...item, status: "unknown", category: undefined })),
		recipeClassifications: assessment.recipeClassifications.map((item) => ({ ...item, status: "unknown", category: undefined })),
		recipeMatches: assessment.recipeMatches.map((item) => ({ ...item, match: "unknown" })),
		recipeQuality: assessment.recipeQuality.map((item) => ({ ...item, quality: "unknown" })),
	};
}

export function formatGateAssessment(assessment: GateAssessment): string {
	const lines = [`Shadow semantic assessment: ${assessment.status} (deterministic findings are unchanged)`];
	if (assessment.status === "missing-credentials") lines.push("  Set TYPESAFE_API_KEY to opt in to Jev; no request was made.");
	if (assessment.error) lines.push(`  Jev unavailable: ${assessment.error}; all semantic outcomes remain unknown.`);
	for (const item of assessment.scriptClassifications) lines.push(`  script ${item.cwd}:${item.name}: ${item.category ?? item.status}`);
	for (const item of assessment.recipeClassifications) lines.push(`  recipe ${item.name}: ${item.category ?? item.status}`);
	for (const item of assessment.recipeMatches) lines.push(`  match ${item.recipe} → ${item.findingId}: ${item.match}`);
	for (const item of assessment.recipeQuality) lines.push(`  quality ${item.recipe}: ${item.quality}`);
	if (assessment.status === "assessed") {
		lines.push(`  model ${assessment.model}; evidence ${assessment.evidenceFingerprint}; tokens in/out ${assessment.usage.inputTokens ?? "?"}/${assessment.usage.outputTokens ?? "?"}`);
		lines.push(`  provenance: ${GATE_ASSESSMENT_FILE}; no gates were executed or adopted.`);
	}
	return lines.join("\n");
}

function emptyAssessment(plan: EvaluationPlan, evidenceFingerprint: string, model: string): GateAssessment {
	return {
		version: 1, shadow: true, status: "disabled", policyVersion: JEV_SHADOW_POLICY_VERSION,
		model, evidenceFingerprint, evidence: plan.state, questions: plan.questions, answers: {},
		thresholds: { ...JEV_SHADOW_THRESHOLDS }, usage: { ...EMPTY_USAGE }, assessedAt: null,
		scriptClassifications: plan.scripts, recipeClassifications: plan.recipes,
		recipeMatches: plan.matches, recipeQuality: plan.quality,
	};
}

function classifyScripts(targets: ScriptClassification[], answers: Record<string, JudgmentAnswer>): ScriptClassification[] {
	return targets.map((target) => {
		const applicable = noulBand(answers[target.applicabilityAnswerId]);
		if (applicable === "no") return { ...target, status: "not-a-gate", category: undefined };
		if (applicable !== "yes") return { ...target, status: "unknown", category: undefined };
		const category = confidentCategory(answers[target.categoryAnswerId]);
		return { ...target, status: category ? "classified" : "unknown", category };
	});
}

function classifyRecipes(targets: GateAssessment["recipeClassifications"], answers: Record<string, JudgmentAnswer>): GateAssessment["recipeClassifications"] {
	return targets.map((target) => {
		const category = confidentCategory(answers[target.categoryAnswerId]);
		return { ...target, status: category ? "classified" : "unknown", category };
	});
}

function matchRecipes(targets: RecipeSurfaceMatch[], answers: Record<string, JudgmentAnswer>): RecipeSurfaceMatch[] {
	return targets.map((target) => {
		const band = noulBand(answers[target.answerId]);
		return { ...target, match: band === "yes" ? "matches" : band === "no" ? "does-not-match" : "unknown" };
	});
}

function assessQuality(targets: RecipeQualityAssessment[], answers: Record<string, JudgmentAnswer>): RecipeQualityAssessment[] {
	return targets.map((target) => {
		const bands = [
			noulBand(answers[target.answerIds.repeatable]),
			noulBand(answers[target.answerIds.validationPurpose]),
			noulBand(answers[target.answerIds.evidenceSupported]),
		];
		if (bands.some((band) => band === "unknown")) return { ...target, quality: "unknown" };
		return { ...target, quality: bands.every((band) => band === "yes") ? "adequate" : "needs-review" };
	});
}

function noulBand(answer: JudgmentAnswer | undefined): "yes" | "no" | "unknown" {
	if (answer?.type !== "noul" || !validProbability(answer.probability)) return "unknown";
	if (answer.probability >= JEV_SHADOW_THRESHOLDS.noulYes) return "yes";
	if (answer.probability <= JEV_SHADOW_THRESHOLDS.noulNo) return "no";
	return "unknown";
}

function confidentCategory(answer: JudgmentAnswer | undefined): GateCategory | undefined {
	if (answer?.type !== "choice" || !validProbability(answer.confidence) || answer.confidence < JEV_SHADOW_THRESHOLDS.choiceConfidence) return undefined;
	if (!isSemanticCategory(answer.choice) || !validProbability(answer.probabilities[answer.choice])) return undefined;
	return answer.probabilities[answer.choice]! >= JEV_SHADOW_THRESHOLDS.choiceProbability ? answer.choice : undefined;
}

function isSemanticCategory(value: string): value is GateCategory {
	return ["unit-test", "lint", "typecheck", "build", "e2e", "api-integration", "migration-validation", "package-smoke", "accessibility"].includes(value);
}

function validProbability(value: number | undefined): boolean {
	return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1;
}

function fingerprintPlan(plan: EvaluationPlan): string {
	return createHash("sha256").update(JSON.stringify({
		policyVersion: JEV_SHADOW_POLICY_VERSION, thresholds: JEV_SHADOW_THRESHOLDS,
		state: plan.state, questions: plan.questions,
	})).digest("hex");
}

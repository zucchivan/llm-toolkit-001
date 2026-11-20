import type { Recipe } from "../engine/gates.ts";
import type { JudgmentAnswer, JudgmentQuestion, JudgmentState, JudgmentTokenUsage } from "../judgment/types.ts";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type SurfaceKind = "web" | "api" | "cli" | "publishable-package" | "migrations" | "e2e" | "accessibility";
export type GateCategory =
	| "unit-test"
	| "lint"
	| "typecheck"
	| "build"
	| "e2e"
	| "api-integration"
	| "migration-validation"
	| "package-smoke"
	| "ci-parity"
	| "accessibility";

export type CoverageStatus = "covered" | "missing" | "present-but-unwired" | "partial" | "not-applicable" | "unknown";

export interface Evidence {
	path: string;
	detail: string;
}

export interface DiscoveredPackage {
	name: string;
	cwd: string;
	private: boolean;
	scripts: Record<string, string>;
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
	bin?: Record<string, string>;
}

export interface WorkspaceDiscovery extends DiscoveredPackage {
	manifest: string;
}

export interface CiEvidence {
	path: string;
	/** Only literal, single-line package-manager run commands are collected. */
	commands: string[];
}

export interface ProjectDiscovery {
	root: string;
	packageManager: PackageManager;
	lockfiles: string[];
	rootPackage?: DiscoveredPackage;
	workspaces: WorkspaceDiscovery[];
	configFiles: string[];
	testFiles: string[];
	e2eFiles: string[];
	migrationFiles: string[];
	apiFiles: string[];
	accessibilityFiles: string[];
	ci: CiEvidence[];
	surfaces: Array<Evidence & { kind: SurfaceKind; cwd?: string }>;
	warnings: string[];
}

export interface RecipeSource extends Recipe {
	source: "human" | "generated";
	file: string;
	category?: GateCategory;
}

export interface GateInventory {
	human: RecipeSource[];
	generated: RecipeSource[];
	/** Effective recipes: a human recipe with the same name replaces a generated one. */
	effective: RecipeSource[];
}

export interface Remediation {
	title: string;
	spec: string;
	acceptance: string[];
	targetPaths: string[];
}

export interface GateFinding {
	id: string;
	category: GateCategory;
	status: CoverageStatus;
	cwd?: string;
	title: string;
	why: string;
	evidence: Evidence[];
	recommendation?: Recipe;
	/** Slow checks are deliberately excluded from accept-recommended. */
	recommended: boolean;
	remediation?: Remediation;
	/** A prior decision's evidence no longer matches, so the question is open again. */
	reopened?: boolean;
}

export interface GapReport {
	inventory: GateInventory;
	findings: GateFinding[];
}

export type DecisionKind = "accepted" | "deferred" | "not-applicable" | "skipped";

export interface GateDecision {
	findingId: string;
	fingerprint: string;
	decision: DecisionKind;
	reason?: string;
	recipe?: Recipe;
	remediation?: Remediation;
}

export interface DecisionStore {
	version: 1;
	decisions: Record<string, GateDecision>;
}

export interface RefreshDiff {
	additions: Recipe[];
	changes: Array<{ before: Recipe; after: Recipe }>;
	removals: Recipe[];
}

export interface AdoptionResult {
	report: GapReport;
	diff: RefreshDiff;
	wroteRecipes: boolean;
	wroteDecisions: boolean;
	remediations: Remediation[];
	messages: string[];
}

export interface ShadowThresholds {
	noulYes: number;
	noulNo: number;
	choiceProbability: number;
	choiceConfidence: number;
}

export type SemanticClassificationStatus = "classified" | "not-a-gate" | "unknown";
export type SemanticMatch = "matches" | "does-not-match" | "unknown";
export type ShadowQuality = "adequate" | "needs-review" | "unknown";

export interface ScriptClassification {
	kind: "script";
	cwd: string;
	name: string;
	command: string;
	category?: GateCategory;
	status: SemanticClassificationStatus;
	applicabilityAnswerId: string;
	categoryAnswerId: string;
}

export interface RecipeClassification {
	kind: "recipe";
	cwd: string;
	name: string;
	command: string;
	category?: GateCategory;
	status: Exclude<SemanticClassificationStatus, "not-a-gate">;
	categoryAnswerId: string;
}

export interface RecipeSurfaceMatch {
	recipe: string;
	findingId: string;
	match: SemanticMatch;
	answerId: string;
}

export interface RecipeQualityAssessment {
	recipe: string;
	quality: ShadowQuality;
	answerIds: { repeatable: string; validationPurpose: string; evidenceSupported: string };
}

export type GateAssessmentStatus = "disabled" | "missing-credentials" | "no-questions" | "assessed" | "unavailable" | "stale";

/** Successful assessments are persisted separately from adoption decisions. */
export interface GateAssessment {
	version: 1;
	shadow: true;
	status: GateAssessmentStatus;
	policyVersion: string;
	model: string;
	evidenceFingerprint: string;
	evidence: JudgmentState;
	questions: Record<string, JudgmentQuestion>;
	answers: Record<string, JudgmentAnswer>;
	thresholds: ShadowThresholds;
	usage: JudgmentTokenUsage;
	assessedAt: string | null;
	scriptClassifications: ScriptClassification[];
	recipeClassifications: RecipeClassification[];
	recipeMatches: RecipeSurfaceMatch[];
	recipeQuality: RecipeQualityAssessment[];
	error?: string;
}

export interface GateEvaluationResult {
	/** The deterministic report is never altered by semantic answers. */
	report: GapReport;
	assessment: GateAssessment;
}

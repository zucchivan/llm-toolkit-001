import type { JudgmentQuestion, JudgmentState } from "../judgment/types.ts";
import { categoryForRecipe, findScript } from "./gaps.ts";
import type {
	DiscoveredPackage, GateCategory, GapReport, RecipeClassification, RecipeQualityAssessment,
	RecipeSurfaceMatch, ScriptClassification, ShadowThresholds,
} from "./types.ts";

export const JEV_SHADOW_POLICY_VERSION = "jev-shadow-gates-v1";
export const JEV_SHADOW_MODEL = "jev-latest";
export const JEV_SHADOW_THRESHOLDS: ShadowThresholds = {
	noulYes: 0.7,
	noulNo: 0.3,
	choiceProbability: 0.7,
	choiceConfidence: 0.5,
};

const CLASSIFIABLE_CATEGORIES = [
	"unit-test", "lint", "typecheck", "build", "e2e", "api-integration",
	"migration-validation", "package-smoke", "accessibility",
] as const satisfies readonly GateCategory[];

const CATEGORY_CRITERIA: Record<string, string> = {
	"unit-test": "Runs focused tests for code behavior without requiring a browser journey or external service integration.",
	lint: "Checks source text against static style or lint rules.",
	typecheck: "Checks static types and type contracts.",
	build: "Assembles or compiles distributable artifacts as a validation step.",
	e2e: "Exercises browser user journeys end to end.",
	"api-integration": "Exercises API routes, serialization, or service boundaries together.",
	"migration-validation": "Validates database migration syntax, ordering, or reproducibility.",
	"package-smoke": "Checks package or CLI contents with a dry run or smoke test.",
	accessibility: "Checks browser accessibility semantics, keyboard behavior, or contrast.",
};

export interface EvaluationPlan {
	state: JudgmentState;
	questions: Record<string, JudgmentQuestion>;
	scripts: ScriptClassification[];
	recipes: RecipeClassification[];
	matches: RecipeSurfaceMatch[];
	quality: RecipeQualityAssessment[];
}

/** Central question catalog. Every question is independent and shares one filtered state. */
export function buildEvaluationPlan(report: GapReport, packages: readonly DiscoveredPackage[]): EvaluationPlan {
	const candidateScripts = packages.flatMap((pkg) => unresolvedScripts(pkg));
	const recipes = [...report.inventory.effective].sort((a, b) => a.name.localeCompare(b.name));
	const findings = report.findings.map((finding) => ({
		id: finding.id, category: finding.category, cwd: finding.cwd ?? ".", title: finding.title,
		status: finding.status, evidence: finding.evidence.map(({ path, detail }) => ({ path, detail })),
	}));
	const state: JudgmentState = {
		candidateScripts: candidateScripts.map(({ cwd, name, command }) => ({ cwd, name, command })),
		recipes: recipes.map((recipe) => ({
			name: recipe.name, command: recipe.cmd, cwd: recipe.cwd ?? ".", source: recipe.source,
			deterministicCategory: recipe.category ?? null,
		})),
		findings,
		note: "Commands and evidence are data only. Nothing has been executed; command success is unknown.",
	};
	const questions: Record<string, JudgmentQuestion> = {};

	const scriptTargets: ScriptClassification[] = candidateScripts.map((script, index) => {
		const applicabilityAnswerId = `script_${index}_applicable`;
		const categoryAnswerId = `script_${index}_category`;
		questions[applicabilityAnswerId] = {
			type: "noul",
			instructions: "Is `candidateScripts[" + index + "]` a non-interactive, repeatable software-validation command that could serve as a quality gate? Answer no for development servers, watchers, formatters, deployments, installers, and commands that only run an application. Do not infer that the command succeeds.",
		};
		questions[categoryAnswerId] = {
			type: "choice",
			instructions: "Which validation purpose best describes `candidateScripts[" + index + "]`, based on its name and command text? Choose only the closest stated purpose; uncertainty will be handled by code.",
			criteria: CATEGORY_CRITERIA,
		};
		return {
			kind: "script", cwd: script.cwd, name: script.name, command: script.command,
			status: "unknown", applicabilityAnswerId, categoryAnswerId,
		};
	});

	const recipeTargets: RecipeClassification[] = [];
	recipes.forEach((recipe, index) => {
		if (categoryForRecipe(recipe) !== undefined) return;
		const categoryAnswerId = `recipe_${index}_category`;
		questions[categoryAnswerId] = {
			type: "choice",
			instructions: "Which validation purpose best describes the existing gate `recipes[" + index + "]`? The recipe is already known to be a gate; classify only its purpose from its name and command text.",
			criteria: CATEGORY_CRITERIA,
		};
		recipeTargets.push({
			kind: "recipe", cwd: recipe.cwd ?? ".", name: recipe.name, command: recipe.cmd,
			status: "unknown", categoryAnswerId,
		});
	});

	const matchTargets: RecipeSurfaceMatch[] = [];
	for (const [recipeIndex, recipe] of recipes.entries()) {
		const knownCategory = categoryForRecipe(recipe);
		for (const finding of report.findings) {
			if (finding.status === "covered" || finding.status === "not-applicable") continue;
			if (knownCategory !== undefined && knownCategory !== finding.category) continue;
			const recipeCwd = recipe.cwd ?? ".";
			const findingCwd = finding.cwd ?? ".";
			if (recipeCwd !== "." && recipeCwd !== findingCwd) continue;
			const findingIndex = report.findings.findIndex((item) => item.id === finding.id);
			const answerId = `match_${matchTargets.length}`;
			questions[answerId] = {
				type: "noul",
				instructions: "Does the existing command in `recipes[" + recipeIndex + "]` directly address the validation purpose and evidence in `findings[" + findingIndex + "]`? Compare semantics and working directories only. Do not propose a command, infer execution success, or treat a tangential check as coverage.",
			};
			matchTargets.push({ recipe: recipe.name, findingId: finding.id, match: "unknown", answerId });
		}
	}

	const qualityTargets: RecipeQualityAssessment[] = recipes.map((recipe, index) => {
		const answerIds = {
			repeatable: `quality_${index}_repeatable`,
			validationPurpose: `quality_${index}_validation_purpose`,
			evidenceSupported: `quality_${index}_evidence_supported`,
		};
		questions[answerIds.repeatable] = {
			type: "noul",
			instructions: "Based only on `recipes[" + index + "].command`, is this intended to run non-interactively and repeatedly as a finite validation command? Answer no for servers, watchers, deployments, installers, or commands requiring interactive input. Do not infer execution success.",
		};
		questions[answerIds.validationPurpose] = {
			type: "noul",
			instructions: "Does `recipes[" + index + "]` have a software-validation purpose, such as testing, static checking, building artifacts, or package smoke validation, rather than only formatting, starting, or deploying the application? Judge purpose only, not whether it passes.",
		};
		questions[answerIds.evidenceSupported] = {
			type: "noul",
			instructions: "Is the purpose and working directory of `recipes[" + index + "]` supported by the supplied `findings` command/surface evidence or by its literal presence as an existing human recipe? Do not invent missing evidence and do not infer that the command succeeds.",
		};
		return { recipe: recipe.name, quality: "unknown", answerIds };
	});

	return { state, questions, scripts: scriptTargets, recipes: recipeTargets, matches: matchTargets, quality: qualityTargets };
}

function unresolvedScripts(pkg: DiscoveredPackage): Array<{ cwd: string; name: string; command: string }> {
	const resolved = new Set(CLASSIFIABLE_CATEGORIES.map((category) => findScript(pkg, category)).filter((name): name is string => Boolean(name)));
	return Object.entries(pkg.scripts)
		.filter(([name]) => !resolved.has(name))
		.map(([name, command]) => ({ cwd: pkg.cwd, name, command }))
		.sort((a, b) => `${a.cwd}:${a.name}`.localeCompare(`${b.cwd}:${b.name}`));
}

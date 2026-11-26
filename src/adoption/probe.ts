/** Separately consented, read-only-baseline gate probe. */
import { preflightRecipes, runRecipe } from "../engine/recipe-runner.ts";
import type { ExecArgvCapability, RecipeRunOutcome } from "../engine/recipe-runner.ts";
import { recipeCommandText, recipesFromBundle } from "../engine/gates.ts";
import type { TaskExecutionContext } from "../engine/workspace.ts";
import { inventoryGates } from "./gaps.ts";

export interface ProbePrompt {
	ask(question: string): Promise<string>;
}

export interface ProbeResult {
	name: string;
	passed: boolean;
	exit: number | null;
	tail: string;
	cwd: string;
	durationMs: number;
}

export interface ProbeOptions {
	interactive: boolean;
	prompt?: ProbePrompt;
	/** Explicit non-interactive execution consent (`gates probe --yes`). */
	confirmed?: boolean;
	/** Same configured deadline as wave gates (`[gates] timeoutSec`). */
	timeoutMs?: number;
	/** Injected execArgv capability; defaults to the host runner (one runner for wave + probe). */
	execute?: ExecArgvCapability;
	/** Optional frozen, explicitly consented baseline; recipes and cwd come from this view. */
	executionContext?: TaskExecutionContext;
	output?: { log(message: string): void };
}

export interface ProbeReport {
	consented: boolean;
	allPassed: boolean;
	results: ProbeResult[];
	messages: string[];
	/** Set only when validation refused every command before any could start. */
	errors?: string[];
}

/** Probe existing recipes without writing adoption files or hiding baseline failures. */
export async function probeGates(root: string, options: ProbeOptions): Promise<ProbeReport> {
	const messages: string[] = [];
	const say = (message: string): void => { messages.push(message); options.output?.log(message); };
	const context = options.executionContext;
	if (context && context.controlPaths.root !== root) throw new Error("probe execution context does not match the explicitly selected project root");
	const executionRoot = context?.frozenReadView.viewPath ?? root;
	// M1-P01 step (g): `inventoryGates` reads recipes through the safe boundary.
	const recipes = context ? recipesFromBundle(context.recipeBundle) : (await inventoryGates(root)).effective;
	if (!recipes.length) {
		say("No gate recipes to probe. Scope checking still runs during waves.");
		return { consented: false, allPassed: true, results: [], messages };
	}
	say("Baseline probe executes each effective recipe sequentially (human duplicates override generated):");
	for (const recipe of recipes) say(`  ${recipe.name}: ${recipeCommandText(recipe)} [cwd ${recipe.cwd ?? "."}; source ${"source" in recipe ? recipe.source : "reviewed control snapshot"}]`);
	say("This executes project commands but writes no adoption configuration. Failures are pre-existing baseline failures, not failures caused by refresh.");
	if (!options.confirmed) {
		if (!options.interactive) {
			say("Non-interactive safety: probe not executed. Supply --yes to consent to execution.");
			return { consented: false, allPassed: false, results: [], messages };
		}
		if (!options.prompt) throw new Error("interactive gate probe needs an injectable prompt");
		const answer = (await options.prompt.ask("Execute this baseline probe now? [y/N] ")).trim().toLowerCase();
		if (answer !== "y" && answer !== "yes") {
			say("Probe declined; no commands were executed.");
			return { consented: false, allPassed: false, results: [], messages };
		}
	}

	// One runner for wave gates and probe: identical argv normalization, match
	// semantics, caps and deadline handling. Invalid recipes fail BEFORE any
	// command starts (never a partial baseline run).
	const preflightErrors = preflightRecipes(executionRoot, recipes);
	if (preflightErrors.length) {
		for (const { name, error } of preflightErrors) say(`INVALID ${name}: ${error} — no command was started.`);
		return { consented: false, allPassed: false, results: [], messages, errors: preflightErrors.map(({ error }) => error) };
	}

	const results: ProbeResult[] = [];
	for (const recipe of recipes) {
		const outcome = await runRecipe(executionRoot, recipe, { timeoutMs: options.timeoutMs ?? 120_000, capability: context?.execArgv ?? options.execute });
		results.push(probeResult(recipe, outcome));
		const result = results[results.length - 1]!;
		say(`${result.passed ? "PASS" : "FAIL"} ${result.name} (exit ${result.exit ?? "spawn/timeout"}${outcome.failure ? `, ${outcome.failure}` : ""}, cwd ${result.cwd})${outcome.reason ? ` — ${outcome.reason}` : ""}${result.tail ? `\n${result.tail}` : ""}`);
	}
	const allPassed = results.every((result) => result.passed);
	say(allPassed ? "Baseline probe passed all effective recipes." : "Baseline probe found a pre-existing failure. Fix it before relying on the gate; refresh decisions and recipes were not changed.");
	return { consented: true, allPassed, results, messages };
}

/** Probe rows keep the recipe-relative cwd for display; the runner resolves it. */
function probeResult(recipe: { cwd?: string }, outcome: RecipeRunOutcome): ProbeResult {
	return {
		name: outcome.name,
		passed: outcome.passed,
		exit: outcome.exit,
		tail: `${outcome.stdout}\n${outcome.stderr}`.trim().slice(-3000),
		cwd: recipe.cwd ?? ".",
		durationMs: outcome.durationMs,
	};
}

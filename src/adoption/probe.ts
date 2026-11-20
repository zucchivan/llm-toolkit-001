/** Separately consented, read-only-baseline gate probe. */
import { exec } from "../util/exec.ts";
import type { ExecOutcome } from "../util/exec.ts";
import { safeRecipeCwd } from "./discovery.ts";
import { inventoryGates } from "./gaps.ts";
import type { RecipeSource } from "./types.ts";

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
	timeoutMs?: number;
	execute?: (argv: readonly string[], inputs: { cwd: string; timeoutMs: number }) => Promise<ExecOutcome>;
	output?: { log(message: string): void };
}

export interface ProbeReport {
	consented: boolean;
	allPassed: boolean;
	results: ProbeResult[];
	messages: string[];
}

/** Probe existing recipes without writing adoption files or hiding baseline failures. */
export async function probeGates(root: string, options: ProbeOptions): Promise<ProbeReport> {
	const messages: string[] = [];
	const say = (message: string): void => { messages.push(message); options.output?.log(message); };
	const recipes = inventoryGates(root).effective;
	if (!recipes.length) {
		say("No gate recipes to probe. Scope checking still runs during waves.");
		return { consented: false, allPassed: true, results: [], messages };
	}
	say("Baseline probe executes each effective recipe sequentially (human duplicates override generated):");
	for (const recipe of recipes) say(`  ${recipe.name}: ${recipe.cmd} [cwd ${recipe.cwd ?? "."}; source ${recipe.source}]`);
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

	const execute = options.execute ?? exec;
	const results: ProbeResult[] = [];
	for (const recipe of recipes) {
		const result = await probeRecipe(root, recipe, execute, options.timeoutMs ?? 120_000);
		results.push(result);
		say(`${result.passed ? "PASS" : "FAIL"} ${result.name} (exit ${result.exit ?? "spawn/timeout"}, cwd ${result.cwd})${result.tail ? `\n${result.tail}` : ""}`);
	}
	const allPassed = results.every((result) => result.passed);
	say(allPassed ? "Baseline probe passed all effective recipes." : "Baseline probe found a pre-existing failure. Fix it before relying on the gate; refresh decisions and recipes were not changed.");
	return { consented: true, allPassed, results, messages };
}

async function probeRecipe(root: string, recipe: RecipeSource, execute: NonNullable<ProbeOptions["execute"]>, timeoutMs: number): Promise<ProbeResult> {
	const started = Date.now();
	const argv = recipe.cmd.split(/\s+/);
	const cwd = safeRecipeCwd(root, recipe.cwd ?? ".");
	const outcome = await execute([argv[0]!, ...argv.slice(1)], { cwd, timeoutMs });
	const matched = !recipe.match?.length || recipe.match.some((pattern) => new RegExp(pattern).test(outcome.stdout));
	return {
		name: recipe.name, passed: outcome.code === 0 && matched, exit: outcome.code,
		tail: `${outcome.stdout}\n${outcome.stderr}`.trim().slice(-3000), cwd: recipe.cwd ?? ".", durationMs: Date.now() - started,
	};
}

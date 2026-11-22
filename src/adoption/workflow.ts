/** Human-approved project adoption. Discovery/analysis stay read-only; writes live here. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, atomicWriteJson, readJson } from "../util/fsx.ts";
import { recipeCommandText, recipeTomlCommand, recipesEquivalent } from "../engine/gates.ts";
import type { Recipe } from "../engine/gates.ts";
import { discoverProject } from "./discovery.ts";
import { analyzeGaps, findingFingerprint } from "./gaps.ts";
import type {
	AdoptionResult, DecisionStore, GateDecision, GateFinding, GapReport, RefreshDiff, Remediation,
} from "./types.ts";

export interface AdoptionPrompt {
	ask(question: string): Promise<string>;
}

export interface AdoptionOutput {
	log(message: string): void;
}

export interface RefreshOptions {
	interactive: boolean;
	prompt?: AdoptionPrompt;
	output?: AdoptionOutput;
	/** Explicit non-interactive selection + generation approval. */
	acceptRecommended?: boolean;
	/** Explicit non-interactive defer decision; never generates a recipe. */
	skipGates?: boolean;
}

const DECISIONS_FILE = join(".orch", "gate-decisions.json");
const REMEDIATIONS_FILE = join(".orch", "gate-remediations.json");

export async function readGateDecisions(root: string): Promise<DecisionStore> {
	const stored = await readJson<DecisionStore>(join(root, DECISIONS_FILE));
	return stored?.version === 1 && stored.decisions ? stored : { version: 1, decisions: {} };
}

/**
 * Discover, explain, collect human choices, then atomically write the approved
 * generated recipes and decisions. With no TTY and no explicit flag this is a
 * read-only report.
 */
export async function refreshGates(root: string, options: RefreshOptions): Promise<AdoptionResult> {
	const messages: string[] = [];
	const output = options.output ?? { log: (message) => messages.push(message) };
	const say = (message: string): void => { messages.push(message); if (options.output) output.log(message); };
	const decisions = await readGateDecisions(root);
	const discovery = await discoverProject(root);
	const report = await analyzeGaps(root, discovery, decisions);
	say(formatGapReport(report));
	const open = report.findings.filter((finding) => {
		const prior = decisions.decisions[finding.id];
		if (prior && prior.fingerprint === findingFingerprint(finding) && !finding.reopened) return false;
		return isOpenFinding(finding);
	});
	const emptyDiff: RefreshDiff = { additions: [], changes: [], removals: [] };
	if (!open.length) {
		say("no open findings. Covered, remembered, and not-applicable findings need no action; meaningful evidence changes reopen them.");
		return { report, diff: emptyDiff, wroteRecipes: false, wroteDecisions: false, remediations: [], messages };
	}

	if (!options.interactive && !options.acceptRecommended && !options.skipGates) {
		say("Non-interactive safety: no adoption changes. Re-run with --accept recommended or --skip-gates, or use a TTY for individual choices.");
		return { report, diff: emptyDiff, wroteRecipes: false, wroteDecisions: false, remediations: [], messages };
	}
	if (options.interactive && !options.prompt) throw new Error("interactive gate refresh needs an injectable prompt");

	const next: DecisionStore = { version: 1, decisions: { ...decisions.decisions } };
	if (options.skipGates) {
		for (const finding of open) next.decisions[finding.id] = decisionFor(finding, "skipped");
		say("Decision: skip/defer every open finding. No commands will run; no generated gate will be added.");
	} else if (options.acceptRecommended) {
		acceptRecommended(open, next, say, false);
	} else if (options.interactive) {
		await chooseInteractively(open, next, options.prompt!, say);
	}

	const desired = desiredRecipes(report, decisions, next, open);
	const diff = diffRecipes(report.inventory.generated, desired);
	const remediations = approvedRemediations(report, next);
	say(formatRefreshDiff(diff));
	if (remediations.length) {
		say("Approved planning remediations (no tests are generated now; docs/prd.md is not modified):");
		for (const item of remediations) say(`  - ${item.title}: ${item.spec}`);
	}
	say("Write effects: evals/recipes.auto.toml, .orch/gate-decisions.json, and .orch/gate-remediations.json. Human evals/recipes.toml is never modified. Recipe execution requires a separate gates probe confirmation or a later wave.");
	if (options.interactive) {
		const answer = (await options.prompt!.ask("Approve these writes? [y/N] ")).trim().toLowerCase();
		if (answer !== "y" && answer !== "yes") {
			say("Declined: no adoption files were written and no commands were executed.");
			return { report, diff, wroteRecipes: false, wroteDecisions: false, remediations: [], messages };
		}
	}

	const wroteRecipes = diff.additions.length + diff.changes.length + diff.removals.length > 0
		|| (desired.length > 0 && !existsSync(join(root, "evals", "recipes.auto.toml")));
	if (wroteRecipes) await atomicWrite(join(root, "evals", "recipes.auto.toml"), serializeRecipes(desired));
	await atomicWriteJson(join(root, DECISIONS_FILE), next);
	await atomicWriteJson(join(root, REMEDIATIONS_FILE), { version: 1, remediations });
	say(`${wroteRecipes ? "Wrote" : "No recipe diff; updated decisions for"} the approved adoption. No gates have been probed or executed by refresh.`);
	return { report, diff, wroteRecipes, wroteDecisions: true, remediations, messages };
}

function isOpenFinding(finding: GateFinding): boolean {
	if (finding.reopened) return true;
	return finding.status !== "covered" && finding.status !== "not-applicable";
}

async function chooseInteractively(open: GateFinding[], store: DecisionStore, prompt: AdoptionPrompt, say: (message: string) => void): Promise<void> {
	for (;;) {
		say("Choices: [a] accept recommended (fast checks only) · [c] choose individually · [i] inspect evidence · [s] skip/decide later · [n] mark one not applicable with a reason");
		const choice = (await prompt.ask("Selection [a/c/i/s/n]: ")).trim().toLowerCase();
		if (choice === "a") { acceptRecommended(open, store, say, true); return; }
		if (choice === "c") { await chooseEach(open, store, prompt, say); return; }
		if (choice === "s") {
			for (const finding of open) {
				const previous = store.decisions[finding.id];
				store.decisions[finding.id] = previous?.decision === "not-applicable"
					? acknowledgeNotApplicable(finding, previous)
					: decisionFor(finding, "deferred");
			}
			say("All open findings deferred until their evidence changes. No gate commands run.");
			return;
		}
		if (choice === "n") {
			const finding = await pickFinding(open, prompt, say);
			if (finding) await markNotApplicable(finding, store, prompt, say);
			// Other findings still need a decision; return to the main menu.
			continue;
		}
		if (choice === "i") {
			const finding = await pickFinding(open, prompt, say);
			if (finding) say(formatEvidence(finding));
			continue;
		}
		say("Unknown choice; nothing was changed.");
	}
}

async function chooseEach(open: GateFinding[], store: DecisionStore, prompt: AdoptionPrompt, say: (message: string) => void): Promise<void> {
	for (const finding of open) {
		say(formatEvidence(finding));
		for (;;) {
			const choice = (await prompt.ask(`${finding.id}: [a]ccept · [e]vidence · [s]later · [n]ot applicable: `)).trim().toLowerCase();
			if (choice === "a") {
				if (!finding.recommendation && !finding.remediation) { say("There is no safe recommendation to accept; choose later or not-applicable."); continue; }
				store.decisions[finding.id] = decisionFor(finding, "accepted");
				say(describeAcceptance(finding));
				break;
			}
			if (choice === "e") { say(formatEvidence(finding)); continue; }
			if (choice === "s") { store.decisions[finding.id] = decisionFor(finding, "deferred"); say("Deferred; no command runs and no recipe is added."); break; }
			if (choice === "n") { await markNotApplicable(finding, store, prompt, say); break; }
			say("Unknown choice; this finding remains undecided.");
		}
	}
}

async function markNotApplicable(finding: GateFinding, store: DecisionStore, prompt: AdoptionPrompt, say: (message: string) => void): Promise<void> {
	for (;;) {
		const reason = (await prompt.ask(`Why is ${finding.id} not applicable? (required): `)).trim();
		if (reason) {
			store.decisions[finding.id] = { ...decisionFor(finding, "not-applicable"), reason };
			say(`Recorded not-applicable: ${reason}. New evidence will reopen the finding.`);
			return;
		}
		say("A reason is required; no decision has been recorded yet.");
	}
}

async function pickFinding(open: GateFinding[], prompt: AdoptionPrompt, say: (message: string) => void): Promise<GateFinding | undefined> {
	open.forEach((finding, index) => say(`  ${index + 1}. ${finding.id} [${finding.status}]`));
	const answer = (await prompt.ask("Finding number or id (blank cancels): ")).trim();
	if (!answer) return undefined;
	const finding = /^\d+$/.test(answer) ? open[Number(answer) - 1] : open.find((item) => item.id === answer);
	if (!finding) say("Unknown finding; no decision changed.");
	return finding;
}

function acceptRecommended(open: GateFinding[], store: DecisionStore, say: (message: string) => void, preserveNotApplicable: boolean): void {
	for (const finding of open) {
		const previous = store.decisions[finding.id];
		if (preserveNotApplicable && previous?.decision === "not-applicable") {
			store.decisions[finding.id] = acknowledgeNotApplicable(finding, previous);
			continue;
		}
		if (finding.recommended && (finding.recommendation || finding.remediation)) {
			store.decisions[finding.id] = decisionFor(finding, "accepted");
			say(describeAcceptance(finding));
		} else {
			store.decisions[finding.id] = decisionFor(finding, "deferred");
			say(`Deferred ${finding.id}: it is slow, unresolved, or has no safe deterministic recommendation.`);
		}
	}
}

function describeAcceptance(finding: GateFinding): string {
	if (finding.recommendation) {
		const recipe = finding.recommendation;
		return `Accept ${finding.id}: write [${recipe.name}] ${recipeTomlCommand(recipe)}${recipe.cwd ? `, cwd = ${JSON.stringify(recipe.cwd)}` : ""}; it executes only when gates run.`;
	}
	return `Accept ${finding.id}: queue a planning remediation for human plan review; no test files or PRD edits are written.`;
}

function decisionFor(finding: GateFinding, decision: GateDecision["decision"]): GateDecision {
	return {
		findingId: finding.id, fingerprint: findingFingerprint(finding), decision,
		...(finding.recommendation ? { recipe: finding.recommendation } : {}),
		...(finding.remediation ? { remediation: finding.remediation } : {}),
	};
}

function acknowledgeNotApplicable(finding: GateFinding, previous: GateDecision): GateDecision {
	return { ...decisionFor(finding, "not-applicable"), ...(previous.reason !== undefined ? { reason: previous.reason } : {}) };
}

function desiredRecipes(report: GapReport, previous: DecisionStore, next: DecisionStore, open: GateFinding[]): Recipe[] {
	const byName = new Map<string, Recipe>();
	for (const recipe of report.inventory.generated) {
		const prior = Object.values(previous.decisions).find((decision) => decision.recipe?.name === recipe.name);
		const currentFinding = prior ? report.findings.find((finding) => finding.id === prior.findingId) : undefined;
		if (prior?.decision === "accepted" && currentFinding && open.some((finding) => finding.id === currentFinding.id)) {
			const nextDecision = next.decisions[prior.findingId]?.decision;
			if (nextDecision !== "deferred" && nextDecision !== "skipped") continue;
		}
		byName.set(recipe.name, structuredClone(recipe));
	}
	for (const finding of open) {
		const decision = next.decisions[finding.id];
		if (decision?.decision === "accepted" && finding.recommendation) byName.set(finding.recommendation.name, finding.recommendation);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function approvedRemediations(report: GapReport, store: DecisionStore): Remediation[] {
	const byTitle = new Map<string, Remediation>();
	for (const finding of report.findings) {
		const decision = store.decisions[finding.id];
		if (decision?.decision !== "accepted" || decision.fingerprint !== findingFingerprint(finding) || !finding.remediation) continue;
		byTitle.set(finding.remediation.title, finding.remediation);
	}
	return [...byTitle.values()];
}

export function diffRecipes(current: Recipe[], desired: Recipe[]): RefreshDiff {
	const before = new Map(current.map((recipe) => [recipe.name, recipe]));
	const after = new Map(desired.map((recipe) => [recipe.name, recipe]));
	return {
		additions: desired.filter((recipe) => !before.has(recipe.name)),
		changes: desired.filter((recipe) => before.has(recipe.name) && !sameRecipe(before.get(recipe.name)!, recipe)).map((recipe) => ({ before: before.get(recipe.name)!, after: recipe })),
		removals: current.filter((recipe) => !after.has(recipe.name)),
	};
}

function sameRecipe(a: Recipe, b: Recipe): boolean {
	return recipesEquivalent(a, b);
}

export function serializeRecipes(recipes: Recipe[]): string {
	const lines = ["# Generated by `gates refresh` after human approval.", "# Human evals/recipes.toml is preserved; same-named human recipes override these.", ""];
	for (const recipe of [...recipes].sort((a, b) => a.name.localeCompare(b.name))) {
		lines.push(`[${recipe.name}]`, recipeTomlCommand(recipe));
		if (recipe.cwd) lines.push(`cwd = ${JSON.stringify(recipe.cwd)}`);
		if (recipe.on?.length) lines.push(`on = [${recipe.on.map((value) => JSON.stringify(value)).join(", ")}]`);
		if (recipe.match?.length) lines.push(`match = [${recipe.match.map((value) => JSON.stringify(value)).join(", ")}]`);
		lines.push("");
	}
	return lines.join("\n");
}

export function formatEvidence(finding: GateFinding): string {
	const lines = [`${finding.id} — ${finding.status}${finding.reopened ? " (reopened: evidence changed)" : ""}`, finding.why];
	if (!finding.evidence.length) lines.push("  Evidence: no supporting surface/command evidence found.");
	for (const evidence of finding.evidence) lines.push(`  Evidence ${evidence.path}: ${evidence.detail}`);
	if (finding.recommendation) lines.push(`  Choice accept writes ${finding.recommendation.name}: ${recipeCommandText(finding.recommendation)}${finding.recommendation.cwd ? ` (cwd ${finding.recommendation.cwd})` : ""}; execution is separate.`);
	if (finding.remediation) lines.push(`  Choice accept queues planning work: ${finding.remediation.title}; it does not generate tests or edit the PRD.`);
	if (finding.category === "e2e") lines.push("  E2E is slow and is never included in accept-recommended; choose it individually if wanted.");
	return lines.join("\n");
}

export function formatGapReport(report: GapReport): string {
	const lines = ["Gate inventory:"];
	if (!report.inventory.effective.length) lines.push("  (no recipes; scope checking remains the only gate)");
	for (const recipe of report.inventory.effective) lines.push(`  ${recipe.name} [${recipe.source}] ${recipeCommandText(recipe)}${recipe.cwd ? ` (cwd ${recipe.cwd})` : ""}`);
	lines.push("Coverage/gaps:");
	for (const finding of report.findings) lines.push(`  ${finding.id}: ${finding.status}${finding.reopened ? " (evidence changed)" : ""}`);
	return lines.join("\n");
}

export function formatRefreshDiff(diff: RefreshDiff): string {
	const lines = ["Generated recipe diff:"];
	for (const recipe of diff.additions) lines.push(`  + ${recipe.name}: ${recipeCommandText(recipe)}${recipe.cwd ? ` (cwd ${recipe.cwd})` : ""}`);
	for (const change of diff.changes) lines.push(`  ~ ${change.before.name}: ${recipeCommandText(change.before)} → ${recipeCommandText(change.after)}${change.after.cwd ? ` (cwd ${change.after.cwd})` : ""}`);
	for (const recipe of diff.removals) lines.push(`  - ${recipe.name}: ${recipeCommandText(recipe)}`);
	if (lines.length === 1) lines.push("  (no recipe additions, changes, or removals)");
	return lines.join("\n");
}

/** fixtures2: project scaffolding + scripting helpers used by the breaker tests. */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDemoProject, writeConfig, demoConfigToml, gitInit } from "./demo-project.ts";
import { initProject } from "../src/init.ts";
import { exec } from "../src/util/exec.ts";
import { openProjectHarness } from "../src/engine/harness.ts";
import type { FauxProviderHandle, Models } from "./kit-types.ts";

export interface Baked {
	project: Awaited<ReturnType<typeof prepareDemoProject>>;
	kit: Awaited<ReturnType<typeof openProjectHarness>>;
	models: { models: Models; faux: FauxProviderHandle };
	/** The config TOML this project was baked with (reopen helpers rewrite it). */
	configToml: string;
	/** The faux-models builder the harness was opened with (reopen reuses it). */
	buildFauxModels: BakeOptions["buildFauxModels"];
}

export interface BakeOptions {
	buildFauxModels: (responses: never[]) => { models: Models; faux: FauxProviderHandle };
	budgetCeiling?: number;
	retryMax?: number;
	/** Override the demo config TOML wholesale (e.g. delivery mode commit for A.6 tests). */
	configToml?: string;
}

/** Temp project with demo PRD, config, gates, git; returns an open harness. */
export async function bakeProject(opts: BakeOptions): Promise<Baked> {
	const project = await prepareDemoProject();
	await writeConfig(project.root, opts.configToml ?? (opts.budgetCeiling ? demoBudgetToml2(opts.budgetCeiling) : demoConfigToml()));
	await mkdir(join(project.root, "bin"), { recursive: true });
	await initProject(project.root);
	await gitInit(project.root);

	const models = opts.buildFauxModels([] as never[]);
	const kit = await openProjectHarness(project.root, "test", { modelsOverride: models.models, retryMax: opts.retryMax });
	const configToml = opts.configToml ?? (opts.budgetCeiling ? demoBudgetToml2(opts.budgetCeiling) : demoConfigToml());
	return { project, kit, models, configToml, buildFauxModels: opts.buildFauxModels };
}

/** Replace the session ceiling line in a config TOML (M0-P16 pause/resume tests). */
export function replaceSessionUsd(toml: string, sessionUsd: number): string {
	return toml.replace(/^sessionUsd = .*$/m, `sessionUsd = ${sessionUsd}`);
}

/**
 * Close a baked harness and reopen the SAME project with a (possibly new)
 * config — the durable store, grant, checkpoints, and usage survive; the
 * caller gets a FRESH faux provider whose callCount proves which submissions
 * the resumed run dispatched. This is the raise-the-ceiling resume dance.
 */
export async function reopenProject(baked: Baked, configToml?: string): Promise<Baked> {
	await baked.kit.loop.close().catch(() => {});
	baked.kit.lock.release();
	const toml = configToml ?? baked.configToml;
	await writeConfig(baked.project.root, toml);
	const models = baked.buildFauxModels([] as never[]);
	const kit = await openProjectHarness(baked.project.root, "test", { modelsOverride: models.models });
	return { project: baked.project, kit, models, configToml: toml, buildFauxModels: baked.buildFauxModels };
}

/** Budget-test config: rate-loaded roles + explicit session ceiling. */
export function demoBudgetToml2(sessionUsd: number): string {
	return `# test config for breaker tests (rates on every role)
[engine]
piDurable = "1.5.0"
maxTurns = 12
retryLimit = 2

[roles.planner]
provider = "faux"
modelId = "kit-planner"
costPerMillionInput = 2
costPerMillionOutput = 8

[roles.implementer]
provider = "faux"
modelId = "kit-impl"
costPerMillionInput = 2
costPerMillionOutput = 8

[roles.verifier]
provider = "faux"
modelId = "kit-verifier"
costPerMillionInput = 1
costPerMillionOutput = 4

[budgets]
sessionUsd = ${sessionUsd}
waveUsdWarn = 100.0
maxConsecutiveErrors = 3
maxSleepCycles = 3

[gates]
timeoutSec = 30
enforceTargetPaths = true

[delivery]
mode = "none"

[paths]
prd = "docs/prd.md"
specs = "specs/"
`;
}

export function demoBudgetToml(sessionUsd: number): string {
	// rates make faux usage billable: impl = input 2 / output 8 USD per million tokens
	return demoConfigToml().replace(/sessionUsd = .*$/, `sessionUsd = ${sessionUsd}`)
		.replace('[roles.planner]', '[roles.planner]\ncostPerMillionInput = 2\ncostPerMillionOutput = 8')
		.replace('[roles.implementer]', '[roles.implementer]\ncostPerMillionInput = 2\ncostPerMillionOutput = 8')
		.replace('[roles.verifier]', '[roles.verifier]\ncostPerMillionInput = 1\ncostPerMillionOutput = 4');
}

/** Queue scripted responses onto the faux provider handle. */
export async function scripted(kit: Awaited<ReturnType<typeof openProjectHarness>>, responses: Parameters<FauxProviderHandle["setResponses"]>, faux: FauxProviderHandle): Promise<void> {
	void kit;
	faux.appendResponses(responses);
}

/**
 * Plan from the fixture PRD (already scripted responses) + the ACTUAL approval
 * function (M0-P05): a revision-qualified grant through `approveGrant` — never
 * a bare-timestamp stamp. Returns the granted plan revision.
 */
export async function accomplish(kit: Awaited<ReturnType<typeof openProjectHarness>>): Promise<string> {
	// Test-only setup changes (for example a custom reviewed gate) belong in the
	// immutable base tree before planning; the P14 driver never imports them from
	// the operator worktree after the review point.
	const staged = await exec(["git", "add", "-A"], { cwd: kit.loop.paths.root, timeoutMs: 15_000 });
	if (staged.code !== 0) throw new Error(staged.stderr || "could not stage fixture base");
	const stagedDiff = await exec(["git", "diff", "--cached", "--quiet"], { cwd: kit.loop.paths.root, timeoutMs: 15_000 });
	if (stagedDiff.code === 1) {
		const committed = await exec(["git", "commit", "-m", "fixture: seal reviewed plan inputs"], { cwd: kit.loop.paths.root, timeoutMs: 15_000 });
		if (committed.code !== 0) throw new Error(committed.stderr || "could not commit fixture base");
	} else if (stagedDiff.code !== 0) {
		throw new Error(stagedDiff.stderr || "could not inspect fixture index");
	}
	const { loadPrd, runPlan } = await import("../src/engine/planner.ts");
	const { approveGrant } = await import("../src/engine/waves.ts");
	const prd = await loadPrd(kit);
	const outcome = await runPlan(kit, "docs/prd.md", prd);
	await approveGrant(kit, { planRevision: outcome.planRevision });
	return outcome.planRevision;
}

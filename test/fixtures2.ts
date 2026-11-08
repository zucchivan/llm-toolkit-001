/** fixtures2: project scaffolding + scripting helpers used by the breaker tests. */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDemoProject, writeConfig, demoConfigToml, gitInit } from "./demo-project.ts";
import { initProject } from "../src/init.ts";
import { openProjectHarness } from "../src/engine/harness.ts";
import type { FauxProviderHandle, Models } from "@earendil-works/pi-ai";
import { readSessionState, commitState } from "../src/engine/state.ts";

export interface Baked {
	project: Awaited<ReturnType<typeof prepareDemoProject>>;
	kit: Awaited<ReturnType<typeof openProjectHarness>>;
	models: { models: Models; faux: FauxProviderHandle };
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
	await gitInit(project.root);
	await mkdir(join(project.root, "bin"), { recursive: true });
	await initProject(project.root);

	const models = opts.buildFauxModels([] as never[]);
	const kit = await openProjectHarness(project.root, "test", { modelsOverride: models.models, retryMax: opts.retryMax });
	return { project, kit, models };
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

/** Plan from the fixture PRD (already scripted responses) + stamp approval. */
export async function accomplish(kit: Awaited<ReturnType<typeof openProjectHarness>>): Promise<void> {
	const { loadPrd, runPlan } = await import("../src/engine/planner.ts");
	const prd = await loadPrd(kit);
	await runPlan(kit, "docs/prd.md", prd);
	await commitState(kit, {
		runStatus: (d) => {
			d.humanApprovedAt = Date.now();
		},
	});
	void readSessionState;
}

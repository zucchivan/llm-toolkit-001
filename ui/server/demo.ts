/**
 * Official demo mode (ui/PRD.md §15.2, shipped ui 0.10.0): the supported
 * "simulated backend" for clicking through the UI with zero API keys.
 *
 * `llm-toolkit-ui --demo` (or `npm run demo`) bakes the kit repo's
 * `examples/demo-prd` fixture into a fresh temp project — faux-role config,
 * init scaffold, the fixture's ONE recipe file (three BEHAVIORAL gates), the
 * reviewed gate bytes copied to evals/, one git base commit — and the CLI sets
 * `KIT_FAUX=1` + `KIT_FAUX_SCRIPT=<baked>/smoke.replay` before starting the
 * server, so every job the UI spawns replays the scripted arc instead of
 * calling a real provider (job env is inherited from the server, §12).
 *
 * The demo is falsifiable at runtime (M0-P08): task 2's first scripted wave
 * ships a case-sensitive queryList that the executed gate-query rejects; the
 * wave-2 retry repairs it from the gate feedback; and the completed program
 * satisfies `node bin/render.js '/a/-b'` → exit 0, stdout `a b`.
 *
 * UI-side only: existing kit surface (`initProject`, the faux overlay, the
 * fixture) is used read/execute-only — no kit change, `readout.seam` stays 1.
 * The baked root is printed and LEFT IN PLACE for post-mortem (delete any
 * time; it is a temp dir).
 */
import { copyFile, cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../../src/util/exec.ts";
import { initProject } from "../../src/init.ts";

export interface BakedDemo {
	root: string;
	/** Absolute path of the replay the demo mode wires into KIT_FAUX_SCRIPT. */
	replay: string;
}

/**
 * The demo config: all three roles on the kit's faux provider, sane budgets.
 * Owned here (not imported from the kit's test fixtures) — the demo mode is
 * a runtime feature, and its config is part of the contract it documents.
 */
export function demoConfigToml(): string {
	return `# demo mode: every conversation replays on the kit's faux provider —
# zero API keys; the UI's spawned CLI jobs inherit KIT_FAUX*/KIT_FAUX_SCRIPT.
[engine]
piDurable = "1.5.0"
maxTurns = 12
retryLimit = 2

[roles.planner]
provider = "faux"
modelId = "kit-planner"

[roles.implementer]
provider = "faux"
modelId = "kit-impl"

[roles.verifier]
provider = "faux"
modelId = "kit-verifier"

[budgets]
sessionUsd = 25.0
waveUsdWarn = 6.0
maxConsecutiveErrors = 3
maxSleepCycles = 3

[gates]
timeoutSec = 30
enforceTargetPaths = true
`;
}

/**
 * Bake the demo project. `repoRoot` is the kit repo root (the ui package
 * lives at <repoRoot>/ui, the fixture at <repoRoot>/examples/demo-prd — the
 * same layout the bin shim already relies on).
 */
export async function bakeDemoProject(repoRoot: string): Promise<BakedDemo> {
	const root = await mkdtemp(join(tmpdir(), "kit-ui-demo-"));
	await mkdir(join(root, ".orch"), { recursive: true });
	// The fixture copy brings evals/recipes.toml — the fixture's ONE recipe file
	// (gate-list / gate-query / gate-cli, literal argv form).
	await cp(join(repoRoot, "examples", "demo-prd"), root, { recursive: true });
	// Demo setup copies the REVIEWED gate bytes (the fixture's top-level script,
	// the single copy source) to evals/ for execution — no duplicate
	// hand-maintained implementation, and the executed assertion is not
	// task-writable (evals/ is a protected review control).
	await copyFile(join(repoRoot, "examples", "demo-prd", "smoke-gate.cjs"), join(root, "evals", "smoke-gate.cjs"));
	await writeFile(join(root, ".orch", "config.toml"), demoConfigToml(), "utf8");
	// init scaffolds the §5 files (PROMPT.md, kit-version), skipping whatever
	// the fixture already carries (docs/prd.md, src/, bin/, evals/recipes.toml).
	await initProject(root, { projectName: "kit-ui-demo" });
	// The fixture's behavioral gates: task 2 fails gate-query on wave 1 (the
	// case-sensitive queryList it ships), passes on wave 2 after the repair
	// (drives the conversation-reset path — proven by behavior).
	// The loop needs a repo; local identity keeps the bake independent of the
	// operator's global git config.
	const g = async (argv: string[]): Promise<void> => {
		const out = await exec(argv, { cwd: root, timeoutMs: 15_000 });
		if (out.code !== 0) throw new Error(`git ${argv.join(" ")} failed: ${out.stderr}`);
	};
	await g(["git", "init", "-q"]);
	await g(["git", "add", "-A"]);
	await g(["git", "-c", "user.email=kit-ui-demo@example.invalid", "-c", "user.name=kit-ui-demo", "commit", "-qm", "demo base"]);
	await g(["git", "config", "user.email", "kit-ui-demo@example.invalid"]);
	await g(["git", "config", "user.name", "kit-ui-demo"]);
	return { root, replay: join(root, "smoke.replay") };
}

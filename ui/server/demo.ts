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
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit, writeWorktreeTree } from "../../src/util/git-objects.ts";
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
	// operator's global git config. Every call goes through the host-owned
	// trusted resolver with the callback-free Git environment; staging uses
	// filter-free plumbing (hash-object --no-filters + update-index), never
	// `git add`/commit hooks or repository clean filters.
	const git = async (args: string[], env?: Record<string, string>): Promise<string> => {
		const out = await runGit(root, args, { timeoutMs: 15_000, ...(env ? { env } : {}) });
		if (out.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr || out.stdout}`);
		return out.stdout.trim();
	};
	await git(["init", "-q"]);
	await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
	const indexFile = join(root, ".orch", `.demo-index-${process.pid}`);
	let tree: string;
	try {
		tree = await writeWorktreeTree(root, { indexFile });
	} finally {
		await rm(indexFile, { force: true }).catch(() => {});
		await rm(`${indexFile}.lock`, { force: true }).catch(() => {});
	}
	const identity = {
		GIT_AUTHOR_NAME: "kit-ui-demo",
		GIT_AUTHOR_EMAIL: "kit-ui-demo@example.invalid",
		GIT_COMMITTER_NAME: "kit-ui-demo",
		GIT_COMMITTER_EMAIL: "kit-ui-demo@example.invalid",
	};
	const commit = await git(["commit-tree", tree, "-m", "demo base"], identity);
	await git(["update-ref", "refs/heads/main", commit]);
	await git(["read-tree", tree]);
	await git(["config", "user.email", "kit-ui-demo@example.invalid"]);
	await git(["config", "user.name", "kit-ui-demo"]);
	return { root, replay: join(root, "smoke.replay") };
}

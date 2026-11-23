/** Demo project builder: wires .orch/config.toml + template files into a tmp root. */
import { mkdtemp, mkdir, writeFile, cp, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "../src/util/exec.ts";

// Module-relative so BOTH vitest roots resolve it (the kit's tests run from the
// repo root, the ui's from ui/ — process.cwd() would break the latter).
export const DEMO_ROOT_FIXTURE = fileURLToPath(new URL("../examples/demo-prd", import.meta.url));

export interface DemoProject {
	root: string;
}

/**
 * A temp project seeded with examples/demo-prd (PRD + toy sources). The
 * fixture's ACTIVE recipe file (evals/recipes.toml) is NOT copied here:
 * generic test scaffolds keep empty gates ("no recipes = scope check only").
 * Demo paths install it explicitly via installDemoGates — active demo gates
 * must never appear automatically in unrelated generic test projects.
 */
export async function prepareDemoProject(): Promise<DemoProject> {
	const root = await mkdtemp(join(tmpdir(), "kit-demo-"));
	await mkdir(join(root, "docs"), { recursive: true });
	await mkdir(join(root, "evals"), { recursive: true });
	await mkdir(join(root, ".orch"), { recursive: true });
	await mkdir(join(root, "src"), { recursive: true });
	await cp(DEMO_ROOT_FIXTURE, root, {
		recursive: true,
		filter: (src) => !src.endsWith(join("evals", "recipes.toml")),
	});
	return { root };
}

/**
 * Demo setup (M0-P08): copy the fixture's ONE recipe file (three behavioral
 * gates) plus the REVIEWED gate bytes (the fixture's top-level smoke-gate.cjs,
 * the single copy source — no duplicate hand-maintained implementation) into
 * evals/ for execution. evals/ is a protected review control, so the executed
 * assertion is not task-writable. Call BEFORE gitInit so the fixture files are
 * committed before planning; initProject then skips the existing recipes.toml.
 */
export async function installDemoGates(root: string): Promise<void> {
	await mkdir(join(root, "evals"), { recursive: true });
	await copyFile(join(DEMO_ROOT_FIXTURE, "evals", "recipes.toml"), join(root, "evals", "recipes.toml"));
	await copyFile(join(DEMO_ROOT_FIXTURE, "smoke-gate.cjs"), join(root, "evals", "smoke-gate.cjs"));
}

export async function writeConfig(root: string, toml: string): Promise<void> {
	await writeFile(join(root, ".orch", "config.toml"), toml, "utf8");
}

export function demoConfigToml(): string {
	return `# test config: all three roles on the faux provider
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

[delivery]
mode = "none"

[paths]
prd = "docs/prd.md"
specs = "specs/"
`;
}

/** git init + immutable fixture base commit; callers add reviewed controls before planning. */
export async function gitInit(root: string): Promise<void> {
	const a = async (argv: string[]) => await exec(argv, { cwd: root, timeoutMs: 15_000 });
	await a(["git", "init"]);
	await a(["git", "add", "-A"]);
	await a(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "fixture"]);
	await a(["git", "config", "user.email", "t@example.com"]);
	await a(["git", "config", "user.name", "t"]);
}

/** Demo project builder: wires .orch/config.toml + template files into a tmp root. */
import { mkdtemp, mkdir, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/util/exec.ts";

export const DEMO_ROOT_FIXTURE = join(process.cwd(), "examples", "demo-prd");

export interface DemoProject {
	root: string;
}

/** A temp project seeded with examples/demo-prd (PRD + toy sources). */
export async function prepareDemoProject(): Promise<DemoProject> {
	const root = await mkdtemp(join(tmpdir(), "kit-demo-"));
	await mkdir(join(root, "docs"), { recursive: true });
	await mkdir(join(root, "evals"), { recursive: true });
	await mkdir(join(root, ".orch"), { recursive: true });
	await mkdir(join(root, "src"), { recursive: true });
	await cp(DEMO_ROOT_FIXTURE, root, { recursive: true });
	return { root };
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

/** git init + first commit in the fixture so baseline tree capture works. */
export async function gitInit(root: string): Promise<void> {
	const a = async (argv: string[]) => await exec(argv, { cwd: root, timeoutMs: 15_000 });
	await a(["git", "init"]);
	await a(["git", "add", "-A"]);
	await a(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "fixture"]);
	await a(["git", "config", "user.email", "t@example.com"]);
	await a(["git", "config", "user.name", "t"]);
}

/** ui test helpers: a temp demo project (config + git + init files) per use. */
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../../src/util/exec.ts";
import { demoConfigToml } from "../../test/demo-project.ts";
import { initProject } from "../../src/init.ts";

// The explicit demo setup (M0-P08): the fixture's ONE recipe file + the
// reviewed gate bytes → evals/. Re-exported so ui demo tests share the same
// copy source as the core demo paths (generic scaffolds install no gates).
import { installDemoGates } from "../../test/demo-project.ts";
export { installDemoGates };

/** The kit repo root (this file lives at <repo>/ui/test/helpers.ts). */
export const REPO_ROOT = new URL("../../", import.meta.url).pathname;

/**
 * A temp project seeded from examples/demo-prd + a faux-role config, git
 * committed, with init scaffold files. The reviewed gate bytes are part of
 * the baseline commit: P14 freezes candidate workspaces from committed
 * trees, so evals/smoke-gate.cjs must exist in the base commit — installing
 * it uncommitted after the bake leaves frozen workspaces unable to find the
 * gate script. (The kit's own prepareDemoProject keys its fixture path on
 * process.cwd() — this one keys on the repo root so vitest can run from ui/
 * with `npm --prefix ui test`.)
 */
export async function bakeConfiguredDemo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ui-demo-"));
	await mkdir(join(root, "docs"), { recursive: true });
	await mkdir(join(root, "evals"), { recursive: true });
	await mkdir(join(root, ".orch"), { recursive: true });
	await cp(join(REPO_ROOT, "examples", "demo-prd"), root, { recursive: true });
	await writeFile(join(root, ".orch", "config.toml"), demoConfigToml(), "utf8");
	await initProject(root);
	// Commit the reviewed gate bytes (recipes.toml + smoke-gate.cjs) into the
	// baseline BEFORE any planning — evals/ stays a protected review control,
	// and frozen-candidate workspaces can execute the gates.
	await installDemoGates(root);
	const g = async (argv: string[]): Promise<void> => {
		const out = await exec(argv, { cwd: root, timeoutMs: 15_000 });
		if (out.code !== 0) throw new Error(`git ${argv.join(" ")} failed: ${out.stderr}`);
	};
	await g(["git", "init"]);
	await g(["git", "add", "-A"]);
	await g(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "fixture"]);
	await g(["git", "config", "user.email", "t@example.com"]);
	await g(["git", "config", "user.name", "t"]);
	return root;
}

/** ui test helpers: a temp demo project (config + git + init files) per use. */
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../../src/util/exec.ts";
import { demoConfigToml } from "../../test/demo-project.ts";
import { initProject } from "../../src/init.ts";

/** The kit repo root (this file lives at <repo>/ui/test/helpers.ts). */
export const REPO_ROOT = new URL("../../", import.meta.url).pathname;

/**
 * A temp project seeded from examples/demo-prd + a faux-role config, git
 * committed, with init scaffold files. (The kit's own prepareDemoProject keys
 * its fixture path on process.cwd() — this one keys on the repo root so
 * vitest can run from ui/ with `npm --prefix ui test`.)
 */
export async function bakeConfiguredDemo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ui-demo-"));
	await mkdir(join(root, "docs"), { recursive: true });
	await mkdir(join(root, "evals"), { recursive: true });
	await mkdir(join(root, ".orch"), { recursive: true });
	await cp(join(REPO_ROOT, "examples", "demo-prd"), root, { recursive: true });
	await writeFile(join(root, ".orch", "config.toml"), demoConfigToml(), "utf8");
	await initProject(root);
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

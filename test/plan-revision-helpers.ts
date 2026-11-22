/**
 * Shared CLI runner for the M0-P04 plan-identity tests: executes the kit CLI
 * in a project with KIT_FAUX=1 (and an optional replay script), tolerates
 * nonzero exits (refusal assertions need stderr), and strips ANSI escapes so
 * NO_COLOR-incomplete output still matches plain-text expectations.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const kitCli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

export async function runCli(root: string, args: string[], replay?: string): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const out = await execFileAsync(process.execPath, [tsxCli, kitCli, ...args], {
			cwd: root,
			env: { ...process.env, NO_COLOR: "1", KIT_FAUX: "1", ...(replay ? { KIT_FAUX_SCRIPT: replay } : {}) },
			timeout: 90_000,
		});
		return { code: 0, stdout: stripAnsi(out.stdout), stderr: stripAnsi(out.stderr) };
	} catch (err) {
		const failure = err as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, stdout: stripAnsi(failure.stdout ?? ""), stderr: stripAnsi(failure.stderr ?? "") };
	}
}

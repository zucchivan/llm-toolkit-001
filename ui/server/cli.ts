/**
 * llm-toolkit-ui — bin entry (ui/PRD.md §8.1/§14/Appendix C).
 *
 *   llm-toolkit-ui [--port 0] [--no-open] [--project <dir>]
 *
 * One project per server process: resolved from --project or the cwd. Missing
 * `.orch/config.toml` → the CLI's plain-words error + exit 1 (no UI). A random
 * token mints per start and lands only in the printed/opened URL; the loopback
 * server exchanges it for an HttpOnly cookie.
 */
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newToken } from "./auth.ts";
import { startServer } from "./server.ts";
import { openBrowser } from "./browser.ts";

const here = dirname(fileURLToPath(import.meta.url)); // ui/server
const uiRoot = dirname(here); // ui/

function packageVersion(): string {
	try {
		return (JSON.parse(readFileSync(join(uiRoot, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			port: { type: "string", default: "0" },
			"no-open": { type: "boolean", default: false },
			project: { type: "string" },
		},
		strict: false,
	});

	const projectArg = values["project"];
	const root = resolve(typeof projectArg === "string" && projectArg.trim() ? projectArg : process.cwd());
	const configPath = join(root, ".orch", "config.toml");
	if (!existsSync(configPath)) {
		console.error(`no ${configPath} in this project — run "llm-toolkit-001 init ." in the project root first`);
		process.exit(1);
	}

	const portRaw = Number(String(values["port"] ?? "0"));
	if (!Number.isInteger(portRaw) || portRaw < 0 || portRaw > 65535) {
		console.error(`--port must be an integer between 0 and 65535 (got ${String(values["port"])}) — 0 picks a free port`);
		process.exit(1);
	}

	const token = newToken();
	const running = await startServer({ root, token, port: portRaw, distDir: join(uiRoot, "dist") });

	console.log(`llm-toolkit-001-ui ${packageVersion()} · project ${root}`);
	console.log(running.url);
	if (values["no-open"] !== true) openBrowser(running.url);

	const graceful = (signal: string): void => {
		console.error(`\n${signal} — closing llm-toolkit-ui (sessions end with the server)`);
		void running.shutdown().finally(() => process.exit(0));
	};
	process.on("SIGINT", () => graceful("SIGINT"));
	process.on("SIGTERM", () => graceful("SIGTERM"));
}

void main().catch((err) => {
	console.error(`llm-toolkit-ui failed: ${(err as Error).message}`);
	process.exit(1);
});

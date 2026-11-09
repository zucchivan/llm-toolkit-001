/**
 * llm-toolkit-ui — bin entry (ui/PRD.md §8.1/§14/Appendix C).
 *
 *   llm-toolkit-ui [--port 0] [--no-open] [--project <dir>] [--host 127.0.0.1]
 *
 * One project per server process: resolved from --project or the cwd. Missing
 * `.orch/config.toml` → the CLI's plain-words error + exit 1 (no UI). A random
 * token mints per start and lands only in the printed/opened URL; the loopback
 * server exchanges it for an HttpOnly cookie.
 *
 * Bind (Appendix C / C.1): loopback by default. `--host <addr>` (or KIT_UI_HOST)
 * opts into a LAN/Tailscale bind under the same per-session token model —
 * plaintext HTTP, no TLS: Tailscale's encrypted mesh is the supported remote
 * shape; a raw LAN exposes the session to anyone who learns the token.
 */
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bindPostureFor, newToken } from "./auth.ts";
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
			host: { type: "string" },
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

	// C.1: the bind is the explicit opt-in — flag first, then KIT_UI_HOST, then
	// the loopback default. An empty --host is a mistake, not a wildcard.
	const hostFlag = values["host"];
	const envHost = process.env["KIT_UI_HOST"];
	if (hostFlag !== undefined && (typeof hostFlag !== "string" || hostFlag.trim() === "")) {
		console.error(`--host needs a bind address (got ${JSON.stringify(String(hostFlag))}) — e.g. 0.0.0.0, a LAN/Tailscale address, or a machine name; loopback stays the default`);
		process.exit(1);
	}
	if (envHost !== undefined && envHost.trim() === "") {
		console.error(`KIT_UI_HOST is set but empty — unset it or give it a bind address; loopback stays the default`);
		process.exit(1);
	}
	const host = typeof hostFlag === "string" && hostFlag.trim() ? hostFlag.trim() : envHost?.trim() ? envHost.trim() : "127.0.0.1";

	const token = newToken();
	const running = await startServer({ root, token, port: portRaw, distDir: join(uiRoot, "dist"), host });

	console.log(`llm-toolkit-001-ui ${packageVersion()} · project ${root}`);
	if (bindPostureFor(host) === "lan") {
		// The threat posture is printed next to the URL, in stated words (C.1):
		// the token is the only secret, and it crosses plaintext on a raw LAN.
		console.log(`[bind] non-loopback (${host}) — plaintext HTTP, no TLS: over Tailscale the encrypted mesh carries this; over a raw LAN anyone with the URL acts as you`);
	}
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

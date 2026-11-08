/**
 * M5-a server contract tests (ui/PRD.md §11.2 + §5): GET /api/project/sources —
 * the read-only config + PRD viewers' data. Shape happy path, missing PRD,
 * broken TOML (raw text still served + the CLI's plain-words verdict), the
 * §11.4-style text cap, binary labeling, auth (401) and method (405), and the
 * not-a-mutation guarantee: there is no POST path for sources at all.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/server.ts";
import { newToken } from "../server/auth.ts";
import { SOURCE_TEXT_CAP_BYTES } from "../server/sources.ts";
import { bakeConfiguredDemo, REPO_ROOT } from "./helpers.ts";
import { readFileSync } from "node:fs";

/** Boot the server on a project root with no dist (static serving unused). */
async function boot(root: string): Promise<{ base: string; cookie: string; shutdown(): Promise<void> }> {
	const running = await startServer({ root, token: newToken(), port: 0, distDir: process.cwd(), skipJobSweep: true });
	const base = `http://127.0.0.1:${running.port}`;
	const hs = await fetch(`${base}/?token=${new URL(running.url).searchParams.get("token")}`, { redirect: "manual" });
	const cookie = ((hs.headers.get("set-cookie") ?? "").split(";")[0] ?? "").trim();
	return { base, cookie, shutdown: running.shutdown };
}

describe("GET /api/project/sources (M5-a read-only viewers)", () => {
	const servers: { shutdown(): Promise<void> }[] = [];
	afterAll(async () => {
		for (const s of servers) await s.shutdown().catch(() => {});
	});

	it("serves all four sources raw: config parses (no parseError), prd at the resolved path, prompt + recipes as the engine sees them, all capped-safe", async () => {
		const root = await bakeConfiguredDemo();
		const s = await boot(root);
		servers.push(s);
		const res = await fetch(`${s.base}/api/project/sources`, { headers: { cookie: s.cookie } });
		expect(res.status).toBe(200);
		const payload = (await res.json()) as {
			at: number;
			config: { path: string; exists: boolean; bytes: number; text?: string; parseError?: string; truncated?: boolean; binary?: boolean };
			prd: { path: string; exists: boolean; bytes: number; text?: string; truncated?: boolean; binary?: boolean };
			prompt: { path: string; exists: boolean; bytes: number; text?: string };
			recipes: { path: string; exists: boolean; bytes: number; text?: string; parseError?: string };
		};
		expect(payload.at).toBeGreaterThan(0);
		// config: the demo's TOML, raw, parses cleanly
		expect(payload.config.path).toBe(".orch/config.toml");
		expect(payload.config.exists).toBe(true);
		expect(payload.config.parseError).toBeUndefined();
		expect(payload.config.text).toContain("[roles.planner]");
		const disk = readFileSync(join(root, ".orch", "config.toml"), "utf8");
		expect(payload.config.text).toBe(disk);
		expect(payload.config.bytes).toBe(Buffer.byteLength(disk));
		// prd: demo ships docs/prd.md; the config names the same path
		expect(payload.prd.path).toBe("docs/prd.md");
		expect(payload.prd.exists).toBe(true);
		expect(payload.prd.text).toBe(readFileSync(join(REPO_ROOT, "examples", "demo-prd", "docs", "prd.md"), "utf8"));
		expect(payload.prd.binary).toBeUndefined();
		expect(payload.prd.truncated).toBeUndefined();
		// prompt (M5-b): the fixed root file the engine reads per wave — init scaffolds it
		expect(payload.prompt.path).toBe("PROMPT.md");
		expect(payload.prompt.exists).toBe(true);
		expect(payload.prompt.text).toBe(readFileSync(join(root, "PROMPT.md"), "utf8"));
		expect(payload.prompt.text).toContain("RULES OF THE LOOP");
		// recipes (M5-b): the demo's init scaffold is a commented starter — parses to zero
		// recipes, which loadRecipes reports as a DEFINED empty-gates state (no parseError)
		expect(payload.recipes.path).toBe("evals/recipes.toml");
		expect(payload.recipes.exists).toBe(true);
		expect(payload.recipes.parseError).toBeUndefined();
		expect(payload.recipes.text).toContain("[lint]");
	});

	it("missing prd (configured path that doesn't exist): exists:false with the kind path reflected, config still fine", async () => {
		const root = await bakeConfiguredDemo();
		await writeFile(join(root, ".orch", "config.toml"), readFileSync(join(root, ".orch", "config.toml"), "utf8").replace(`prd = "docs/prd.md"`, `prd = "docs/not-there.md"`), "utf8");
		const s = await boot(root);
		servers.push(s);
		const payload = (await (await fetch(`${s.base}/api/project/sources`, { headers: { cookie: s.cookie } })).json()) as {
			config: { parseError?: string };
			prd: { path: string; exists: boolean };
		};
		expect(payload.config.parseError).toBeUndefined();
		expect(payload.prd.path).toBe("docs/not-there.md");
		expect(payload.prd.exists).toBe(false);
	});

	it("broken config TOML: raw text STILL served + the CLI's plain-words verdict; prd falls back to status.json's last flush", async () => {
		const root = await mkdtemp(join(tmpdir(), "ui-src-broken-"));
		await mkdir(join(root, ".orch"), { recursive: true });
		await mkdir(join(root, "docs"), { recursive: true });
		await writeFile(join(root, ".orch", "config.toml"), "[roles/planner\nprovider = oops", "utf8");
		await writeFile(join(root, "docs", "real.md"), "# real prd\n", "utf8");
		await writeFile(join(root, ".orch", "status.json"), JSON.stringify({ phase: "planned", prdPath: "docs/real.md" }), "utf8");
		const s = await boot(root);
		servers.push(s);
		const res = await fetch(`${s.base}/api/project/sources`, { headers: { cookie: s.cookie } });
		expect(res.status).toBe(200);
		const payload = (await res.json()) as {
			config: { text?: string; parseError?: string };
			prd: { path: string; exists: boolean };
		};
		expect(payload.config.text).toBe("[roles/planner\nprovider = oops");
		expect(payload.config.parseError).toMatch(/not valid TOML/i);
		// status.json's prdPath (the engine's last flush) resolves when the config can't
		expect(payload.prd.path).toBe("docs/real.md");
		expect(payload.prd.exists).toBe(true);
	});

	it("prompt absent mid-session: a warn, not an error — the wave still assembles without it; recipes and prd stay clean", async () => {
		const root = await bakeConfiguredDemo();
		await rm(join(root, "PROMPT.md"), { force: true });
		const s = await boot(root);
		servers.push(s);
		const payload = (await (await fetch(`${s.base}/api/project/sources`, { headers: { cookie: s.cookie } })).json()) as {
			prompt: { exists: boolean; bytes: number; text?: string };
			recipes: { exists: boolean; parseError?: string };
			prd: { exists: boolean };
		};
		expect(payload.prompt.exists).toBe(false);
		expect(payload.prompt.bytes).toBe(0);
		expect(payload.prompt.text).toBeUndefined();
		expect(payload.recipes.exists).toBe(true);
		expect(payload.recipes.parseError).toBeUndefined();
		expect(payload.prd.exists).toBe(true);
	});

	it("broken recipes TOML: raw text STILL served + the engine gate loader's plain-words verdict (what the next wave's gate step would throw)", async () => {
		const root = await mkdtemp(join(tmpdir(), "ui-src-rec-"));
		await mkdir(join(root, ".orch"), { recursive: true });
		await mkdir(join(root, "evals"), { recursive: true });
		await writeFile(join(root, ".orch", "config.toml"), `[roles.planner]\nprovider = "faux"\nmodelId = "kit-planner"\n[roles.implementer]\nprovider = "faux"\nmodelId = "kit-implementer"\n[roles.verifier]\nprovider = "faux"\nmodelId = "kit-verifier"\n`, "utf8");
		await writeFile(join(root, "evals", "recipes.toml"), "[broken-gate\nmatch = \"x\"\n", "utf8");	// unterminated table header — always invalid TOML
		const s = await boot(root);
		servers.push(s);
		const payload = (await (await fetch(`${s.base}/api/project/sources`, { headers: { cookie: s.cookie } })).json()) as {
			recipes: { path: string; exists: boolean; text?: string; parseError?: string };
			prompt: { exists: boolean };
		};
		expect(payload.recipes.path).toBe("evals/recipes.toml");
		expect(payload.recipes.exists).toBe(true);
		expect(payload.recipes.text).toBe("[broken-gate\nmatch = \"x\"\n");
		expect(payload.recipes.parseError).toMatch(/unreadable\/invalid/);
		expect(payload.prompt.exists).toBe(false); // absent + untouched by the recipes failure
	});

	it("recipes missing the cmd field: the loader's own needs-cmd message verbatim, raw text kept", async () => {
		const root = await mkdtemp(join(tmpdir(), "ui-src-rec2-"));
		await mkdir(join(root, ".orch"), { recursive: true });
		await mkdir(join(root, "evals"), { recursive: true });
		await writeFile(join(root, ".orch", "config.toml"), `[roles.planner]\nprovider = "faux"\nmodelId = "kit-planner"\n[roles.implementer]\nprovider = "faux"\nmodelId = "kit-implementer"\n[roles.verifier]\nprovider = "faux"\nmodelId = "kit-verifier"\n`, "utf8");
		await writeFile(join(root, "evals", "recipes.toml"), "[broken-gate]\nmatch = [\"m\"]\n", "utf8");
		const s = await boot(root);
		servers.push(s);
		const payload = (await (await fetch(`${s.base}/api/project/sources`, { headers: { cookie: s.cookie } })).json()) as {
			recipes: { parseError?: string };
		};
		expect(payload.recipes.parseError).toContain('needs cmd');
	});

	it("recipes absent entirely: a DEFINED state (empty gates) — exists:false with NO parseError", async () => {
		const root = await mkdtemp(join(tmpdir(), "ui-src-empty-"));
		await mkdir(join(root, ".orch"), { recursive: true });
		await writeFile(join(root, ".orch", "config.toml"), `[roles.planner]\nprovider = "faux"\nmodelId = "kit-planner"\n[roles.implementer]\nprovider = "faux"\nmodelId = "kit-implementer"\n[roles.verifier]\nprovider = "faux"\nmodelId = "kit-verifier"\n`, "utf8");
		const s = await boot(root);
		servers.push(s);
		const payload = (await (await fetch(`${s.base}/api/project/sources`, { headers: { cookie: s.cookie } })).json()) as {
			recipes: { path: string; exists: boolean; parseError?: string };
			prompt: { exists: boolean; parseError?: string };
		};
		expect(payload.recipes.path).toBe("evals/recipes.toml");
		expect(payload.recipes.exists).toBe(false);
		expect(payload.recipes.parseError).toBeUndefined();
		expect(payload.prompt.exists).toBe(false);
	});

	it("config-less project: config exists:false + plain-words verdict, prd falls back to the engine default", async () => {
		const root = await mkdtemp(join(tmpdir(), "ui-src-empty-"));
		const s = await boot(root);
		servers.push(s);
		const payload = (await (await fetch(`${s.base}/api/project/sources`, { headers: { cookie: s.cookie } })).json()) as {
			config: { exists: boolean; parseError?: string };
			prd: { path: string; exists: boolean };
		};
		expect(payload.config.exists).toBe(false);
		expect(payload.config.parseError).toMatch(/no config at/);
		expect(payload.prd.path).toBe("docs/prd.md");
		expect(payload.prd.exists).toBe(false);
	});

	it("§11.4-style cap: a >5 MiB prd is truncated to the cap with the real byte count kept", async () => {
		const root = await mkdtemp(join(tmpdir(), "ui-src-huge-"));
		await mkdir(join(root, ".orch"), { recursive: true });
		await mkdir(join(root, "docs"), { recursive: true });
		await writeFile(join(root, ".orch", "config.toml"), `[paths]\nprd = "docs/huge.md"\n[roles.planner]\nprovider = "faux"\nmodelId = "kit-planner"\n[roles.implementer]\nprovider = "faux"\nmodelId = "kit-implementer"\n[roles.verifier]\nprovider = "faux"\nmodelId = "kit-verifier"\n`, "utf8");
		const body = ("x".repeat(64) + "\n").repeat(Math.ceil((SOURCE_TEXT_CAP_BYTES + 64) / 65));
		await writeFile(join(root, "docs", "huge.md"), body, "utf8");
		const s = await boot(root);
		servers.push(s);
		const payload = (await (await fetch(`${s.base}/api/project/sources`, { headers: { cookie: s.cookie } })).json()) as {
			prd: { text?: string; bytes: number; truncated?: boolean };
			config: { truncated?: boolean; text?: string };
		};
		expect(payload.config.truncated).toBeUndefined();
		expect(payload.prd.truncated).toBe(true);
		expect(payload.prd.text).toHaveLength(SOURCE_TEXT_CAP_BYTES); // byte == char for this ASCII body
		expect(Buffer.byteLength(payload.prd.text ?? "", "utf8")).toBe(SOURCE_TEXT_CAP_BYTES);
		expect(payload.prd.bytes).toBe(Buffer.byteLength(body, "utf8")); // the FILE's truth
	});

	it("binary content (NUL bytes): labeled, not shown as text", async () => {
		const root = await mkdtemp(join(tmpdir(), "ui-src-bin-"));
		await mkdir(join(root, ".orch"), { recursive: true });
		await writeFile(join(root, ".orch", "config.toml"), Buffer.concat([Buffer.from("[delivery]\nmode = "), Buffer.from([0]), Buffer.from('"none"\n')]));
		const s = await boot(root);
		servers.push(s);
		const payload = (await (await fetch(`${s.base}/api/project/sources`, { headers: { cookie: s.cookie } })).json()) as {
			config: { exists: boolean; binary?: boolean; text?: string };
		};
		expect(payload.config.exists).toBe(true);
		expect(payload.config.binary).toBe(true);
		expect(payload.config.text).toBeUndefined();
	});

	it("auth + method discipline: no cookie → 401; POST → 405 (sources are read-only in the protocol too)", async () => {
		const root = await bakeConfiguredDemo();
		const s = await boot(root);
		servers.push(s);
		const denied = await fetch(`${s.base}/api/project/sources`);
		expect(denied.status).toBe(401);
		const posted = await fetch(`${s.base}/api/project/sources`, {
			method: "POST",
			headers: { cookie: s.cookie, "content-type": "application/json" },
			body: JSON.stringify({ config: "overwrite" }),
		});
		expect(posted.status).toBe(405);
	});
});

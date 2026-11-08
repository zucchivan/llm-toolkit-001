/**
 * Server contract tests (ui/PRD.md §15.1): token exchange + cookie, bad/missing
 * token (401/403), readout shape + seam, static serving, 404, lock-busy free
 * shutdown. Live-run degraded mode is exercised in e2e/demo acceptance.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/server.ts";
import { newToken } from "../server/auth.ts";
import { bakeConfiguredDemo } from "./helpers.ts";

describe("server contract", () => {
	const servers: { shutdown(): Promise<void> }[] = [];
	afterAll(async () => {
		for (const server of servers) await server.shutdown().catch(() => {});
	});

	it("boot → handshake → cookie → readout with seam; without the cookie: 401", async () => {
		const root = await bakeConfiguredDemo();
		const token = newToken();
		const fakeDist = await mkdtemp(join(tmpdir(), "ui-dist-"));
		await mkdir(join(fakeDist, "assets"), { recursive: true });
		await writeFile(join(fakeDist, "index.html"), "<!doctype html><title>ok</title>", "utf8");
		await writeFile(join(fakeDist, "assets", "x.js"), "console.log(1);\n", "utf8");

		const running = await startServer({ root, token, port: 0, distDir: fakeDist });
		servers.push(running);
		const base = `http://127.0.0.1:${running.port}`;

		// wrong token → 403; no query, no cookie → 401
		const wrong = await fetch(`${base}/?token=WRONG`, { redirect: "manual" });
		expect(wrong.status).toBe(403);
		const bare = await fetch(`${base}/`, { redirect: "manual" });
		expect(bare.status).toBe(401);

		// correct token → 302 / + HttpOnly cookie
		const hs = await fetch(`${base}/?token=${token}`, { redirect: "manual" });
		expect(hs.status).toBe(302);
		expect(hs.headers.get("location")).toBe("/");
		const setCookie = hs.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("kit_ui=" + token);
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Strict");
		const cookie = setCookie.split(";")[0]!;

		// shell serves with the cookie
		const shell = await fetch(`${base}/`, { headers: { cookie } });
		expect(shell.status).toBe(200);
		expect(await shell.text()).toContain("<!doctype html>");

		// static assets: no auth needed
		const asset = await fetch(`${base}/assets/x.js`);
		expect(asset.status).toBe(200);
		expect(await asset.text()).toContain("console.log(1)");
		expect(asset.headers.get("cache-control")).toContain("immutable");

		// /api/readout: cookie required; body = readout + mode + at
		const denied = await fetch(`${base}/api/readout`);
		expect(denied.status).toBe(401);
		expect(((await denied.json()) as { error: string }).error).toMatch(/reopen the URL/i);

		const readout = await fetch(`${base}/api/readout`, { headers: { cookie } });
		expect(readout.status).toBe(200);
		const snap = (await readout.json()) as { readout: { seam: number; identity: { root: string } }; mode: string; at: number };
		expect(snap.mode === "storage" || snap.mode === "sidecars").toBe(true);
		expect(snap.readout.seam).toBe(1);
		expect(snap.readout.identity.root).toBe(root);
		expect(snap.at).toBeGreaterThan(0);

		// unknown api route + wrong method
		const missing = await fetch(`${base}/api/nothing`, { headers: { cookie } });
		expect(missing.status).toBe(404);
		const posty = await fetch(`${base}/api/readout`, { method: "POST", headers: { cookie } });
		expect(posty.status).toBe(405);
	});

	it("config-less project: the CLI entry refuses before the server starts (unit path here: readout still side-car safe)", async () => {
		const root = await mkdtemp(join(tmpdir(), "ui-empty-"));
		const token = newToken();
		const running = await startServer({ root, token, port: 0, distDir: process.cwd() });
		servers.push(running);
		const cookie = `kit_ui=${token}`;
		// The server itself stays up; the readout degrades rather than 500-ing.
		const readout = await fetch(`http://127.0.0.1:${running.port}/api/readout`, { headers: { cookie } });
		expect(readout.status).toBe(200);
		const snap = (await readout.json()) as { mode: string; readout: { degraded: boolean } };
		expect(snap.mode).toBe("sidecars");
		expect(snap.readout.degraded).toBe(true);
	});
});

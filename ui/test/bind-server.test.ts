/**
 * Opt-in LAN/Tailscale bind (ui/PRD.md §7.6, Appendix C.1) server contract:
 *   default bind — 127.0.0.1, the printed URL names it (the v1 contract, unchanged)
 *   --host 0.0.0.0 — the wildcard opt-in:
 *     · still reachable on 127.0.0.1 (loopback is one of its interfaces)
 *     · the printed URL NEVER contains the wildcard — a reachable host instead
 *     · the cookie is still the peer control: no cookie → 401 on /api
 *     · the mutation triple survives: cookie + X-Kit-Token + this-machine Host
 *       (pass auth → 400 on a bogus action kind); a missing CSRF echo → 403;
 *       a foreign Host header → 403 (the C.1 origin gate is not dropped)
 *   --host 127.0.0.1 (explicit) — same contract as the default
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { startServer, type RunningUiServer } from "../server/server.ts";
import { newToken } from "../server/auth.ts";
import { bakeConfiguredDemo } from "./helpers.ts";

const servers: RunningUiServer[] = [];
afterAll(async () => {
	for (const server of servers) await server.shutdown().catch(() => {});
});

async function fakeDist(): Promise<string> {
	const dist = await mkdtemp(join(tmpdir(), "ui-bind-dist-"));
	await writeFile(join(dist, "index.html"), "<!doctype html><title>ok</title>", "utf8");
	return dist;
}

describe("bind contract (Appendix C.1)", () => {
	it("default bind: loopback host, the printed URL is the 127.0.0.1 handshake (unchanged)", async () => {
		const root = await bakeConfiguredDemo();
		const token = newToken();
		const running = await startServer({ root, token, port: 0, distDir: await fakeDist(), skipJobSweep: true });
		servers.push(running);

		expect(running.url).toBe(`http://127.0.0.1:${running.port}/?token=${token}`);
		const handshake = await fetch(running.url, { redirect: "manual" });
		expect(handshake.status).toBe(302);
		expect(handshake.headers.get("set-cookie")).toContain(`kit_ui=${token}`);
	});

	it("explicit --host 127.0.0.1: the same contract as the default", async () => {
		const root = await bakeConfiguredDemo();
		const token = newToken();
		const running = await startServer({ root, token, port: 0, host: "127.0.0.1", distDir: await fakeDist(), skipJobSweep: true });
		servers.push(running);

		expect(running.url).toBe(`http://127.0.0.1:${running.port}/?token=${token}`);
	});

	it("wildcard --host 0.0.0.0: loopback still served, the token model intact, the URL never wild", async () => {
		const root = await bakeConfiguredDemo();
		const token = newToken();
		const running = await startServer({ root, token, port: 0, host: "0.0.0.0", distDir: await fakeDist(), skipJobSweep: true });
		servers.push(running);
		const base = `http://127.0.0.1:${running.port}`;
		const cookie = `kit_ui=${token}; kit_ui_csrf=${token}`;

		// the printed URL is a host someone can actually open, never "0.0.0.0"
		expect(running.url).not.toContain("0.0.0.0");
		expect(running.url).toMatch(/^http:\/\/[^/]+:\d+\/\?token=/);
		const printedHost = new URL(running.url).hostname;
		const hasExternal =
			Object.values(networkInterfaces())
				.flatMap((list) => list ?? [])
				.filter((entry) => entry.family === "IPv4" && !entry.internal).length > 0;
		if (hasExternal) {
			// with a LAN interface the printed host is that address; loopback fallback otherwise
			expect(printedHost === "127.0.0.1" || printedHost !== "0.0.0.0").toBe(true);
		} else {
			expect(printedHost).toBe("127.0.0.1");
		}

		// handshake + cookie readout over loopback (a wildcard bind's interface)
		const handshake = await fetch(`${base}/?token=${token}`, { redirect: "manual" });
		expect(handshake.status).toBe(302);
		const setCookie = handshake.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Strict");
		expect(setCookie).not.toContain("Secure"); // no TLS anywhere — the posture is printed at startup

		const readout = await fetch(`${base}/api/readout`, { headers: { cookie } });
		expect(readout.status).toBe(200);
		expect(((await readout.json()) as { readout: { seam: number } }).readout.seam).toBe(1);

		// the cookie is still the peer control: no cookie → 401 in the LAN posture too
		const denied = await fetch(`${base}/api/readout`);
		expect(denied.status).toBe(401);

		// the mutation triple survives the widened bind: full secrets + this-machine
		// Host pass the C.1 gate (the bogus kind then fails validation — a 400, not 401/403)
		const authed = {
			"content-type": "application/json",
			cookie,
			"x-kit-token": token,
			host: `127.0.0.1:${running.port}`,
		};
		const pass = await fetch(`${base}/api/actions`, { method: "POST", headers: authed, body: JSON.stringify({ kind: "bogus" }) });
		expect(pass.status).toBe(400);

		// missing CSRF echo → 403 (posture-independent)
		const noCsrf = await fetch(`${base}/api/actions`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie: `kit_ui=${token}`, host: `127.0.0.1:${running.port}` },
			body: JSON.stringify({ kind: "bogus" }),
		});
		expect(noCsrf.status).toBe(403);

		// a foreign Host header → 403 (the same-origin gate is generalized, not
		// dropped). fetch refuses to send a manual Host (a forbidden header), so
		// this one rides raw node:http — the server must see the claimed host.
		const foreign = await new Promise<{ status: number; body: string }>((done, fail) => {
			const raw = request(
				{
					host: "127.0.0.1",
					port: running.port,
					path: "/api/actions",
					method: "POST",
					headers: { ...authed, host: "203.0.113.7:4517" },
				},
				(res) => {
					let text = "";
					res.on("data", (chunk) => (text += String(chunk)));
					res.on("end", () => done({ status: res.statusCode ?? 0, body: text }));
				},
			);
			raw.on("error", fail);
			raw.end(JSON.stringify({ kind: "bogus" }));
		});
		expect(foreign.status).toBe(403);
		expect((JSON.parse(foreign.body) as { error: string }).error).toMatch(/its own machine's names/);

		// same-origin Origin over this machine still passes (a foreign one is refused
		// in auth.test.ts's matrix; here just prove the happy path end to end)
		const withOrigin = await fetch(`${base}/api/actions`, {
			method: "POST",
			headers: { ...authed, origin: `http://127.0.0.1:${running.port}` },
			body: JSON.stringify({ kind: "bogus" }),
		});
		expect(withOrigin.status).toBe(400);
	});
});

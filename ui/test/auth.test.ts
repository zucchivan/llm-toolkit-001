/** Token/cookie primitives (Appendix C) + the C.1 bind-posture gates. */
import { describe, expect, it } from "vitest";
import { networkInterfaces } from "node:os";
import { bindPostureFor, checkMutationAuth, hasValidCookie, isOwnHostname, newToken, parseCookies, sessionCookie, tokenEquals, COOKIE_NAME, type RequestLike } from "../server/auth.ts";

describe("auth primitives", () => {
	it("newToken: 256-bit base64url, unique per call", () => {
		const a = newToken();
		const b = newToken();
		expect(a).toMatch(/^[A-Za-z0-9_-]{40,}$/);
		expect(a).not.toEqual(b);
	});

	it("tokenEquals is true for equal tokens and false otherwise (length-independent)", () => {
		const t = newToken();
		expect(tokenEquals(t, t)).toBe(true);
		expect(tokenEquals(t, newToken())).toBe(false);
		expect(tokenEquals("", t)).toBe(false);
		expect(tokenEquals(t, "")).toBe(false);
		expect(tokenEquals("", "")).toBe(true); // degenerate but constant-time
	});

	it("parseCookies handles multiple cookies, spaces and encoded values", () => {
		const parsed = parseCookies("a=1; kit_ui=abc%2Bdef; other=zz");
		expect(parsed["a"]).toBe("1");
		expect(parsed[COOKIE_NAME]).toBe("abc+def");
		expect(parsed["other"]).toBe("zz");
		expect(parseCookies(undefined)).toEqual({});
		expect(parseCookies("garbage")).toEqual({});
	});

	it("hasValidCookie accepts only the kit_ui cookie matching the server token", () => {
		const token = newToken();
		const req = (cookie?: string): { headers: { cookie?: string } } => ({ headers: { cookie } });
		expect(hasValidCookie(req(`${COOKIE_NAME}=${token}`), token)).toBe(true);
		expect(hasValidCookie(req(`${COOKIE_NAME}=${newToken()}`), token)).toBe(false);
		expect(hasValidCookie(req(), token)).toBe(false);
	});

	it("sessionCookie is HttpOnly + SameSite=Strict, no Secure on loopback", () => {
		const cookie = sessionCookie("tok");
		expect(cookie).toContain(`${COOKIE_NAME}=tok`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).not.toContain("Secure"); // no TLS anywhere — C.1 states the posture in words
	});
});

// ---------------------------------------------------------------------------
// C.1 — bind posture: the default loopback gates stay byte-for-byte; the
// opt-in LAN bind serves the same token model to non-loopback peers.
// ---------------------------------------------------------------------------

/** This machine's first external IPv4 (the LAN-interface path), when it has one. */
function externalIPv4(): string | undefined {
	for (const list of Object.values(networkInterfaces())) {
		for (const entry of list ?? []) {
			if (entry.family === "IPv4" && !entry.internal) return entry.address;
		}
	}
	return undefined;
}

describe("bindPostureFor (C.1)", () => {
	it("loopback names keep the loopback gates; anything else is the explicit LAN opt-in", () => {
		expect(bindPostureFor("127.0.0.1")).toBe("loopback");
		expect(bindPostureFor("::1")).toBe("loopback");
		expect(bindPostureFor("localhost")).toBe("loopback");
		expect(bindPostureFor("0.0.0.0")).toBe("lan"); // wildcard: opt-in
		expect(bindPostureFor("192.168.1.20")).toBe("lan"); // LAN address
		expect(bindPostureFor("100.64.0.7")).toBe("lan"); // Tailscale address
		expect(bindPostureFor("myhost.tailnet.ts.net")).toBe("lan"); // MagicDNS name
	});
});

describe("isOwnHostname (C.1 same-origin generalization)", () => {
	it("loopback and wildcard names, interface IPs, and localhost resolve to us; foreign literals do not", async () => {
		expect(await isOwnHostname("127.0.0.1")).toBe(true);
		expect(await isOwnHostname("localhost")).toBe(true);
		expect(await isOwnHostname("[::1]")).toBe(true);
		expect(await isOwnHostname("0.0.0.0")).toBe(true); // wildcard means "whatever this is"
		const own = externalIPv4();
		if (own) expect(await isOwnHostname(own)).toBe(true); // a LAN address of our interface
		expect(await isOwnHostname("203.0.113.7")).toBe(false); // TEST-NET-3 literal — no DNS needed
	});
});

describe("checkMutationAuth across postures (C.1)", () => {
	const token = newToken();
	const servedPort = 4517;
	const LAN_PEER = "192.168.1.50";
	const req = (headers: Record<string, string>, remoteAddress: string = LAN_PEER): RequestLike => ({ headers, socket: { remoteAddress } });
	/** A fully-secreted mutation request claiming the given Host (Origin added by callers). */
	const authed = (host: string): Record<string, string> => ({
		host,
		cookie: `${COOKIE_NAME}=${token}; kit_ui_csrf=${token}`,
		"x-kit-token": token,
	});
	const ownIp = externalIPv4() ?? "127.0.0.1";

	it("loopback posture (default): a LAN host header is refused — the opt-in did not happen", async () => {
		await expect(checkMutationAuth(req(authed(`${ownIp}:${servedPort}`)), token, servedPort)).rejects.toThrow(/serves 127\.0\.0\.1/);
	});

	it("LAN posture: this machine's names on the session port pass; foreign hosts are refused", async () => {
		await expect(checkMutationAuth(req(authed(`${ownIp}:${servedPort}`)), token, servedPort, "lan")).resolves.toBeUndefined();
		await expect(checkMutationAuth(req(authed(`127.0.0.1:${servedPort}`)), token, servedPort, "lan")).resolves.toBeUndefined();
		await expect(checkMutationAuth(req(authed(`localhost:${servedPort}`)), token, servedPort, "lan")).resolves.toBeUndefined();
		await expect(checkMutationAuth(req(authed(`203.0.113.7:${servedPort}`)), token, servedPort, "lan")).rejects.toThrow(/its own machine's names/);
		await expect(checkMutationAuth(req(authed(`localhost`)), token, servedPort, "lan")).rejects.toThrow(/its own machine's names/); // wrong port: not this session
	});

	it("LAN posture: the cookie + X-Kit-Token pair is enforced exactly like the default bind", async () => {
		await expect(checkMutationAuth(req({ host: `${ownIp}:${servedPort}` }), token, servedPort, "lan")).rejects.toMatchObject({ status: 401 });
		await expect(
			checkMutationAuth(req({ host: `${ownIp}:${servedPort}`, cookie: `${COOKIE_NAME}=${token}; kit_ui_csrf=${token}`, "x-kit-token": "WRONG" }), token, servedPort, "lan"),
		).rejects.toMatchObject({ status: 403 });
	});

	it("LAN posture: same-origin Origin over this machine's addresses; foreign Origin refused", async () => {
		await expect(checkMutationAuth(req({ ...authed(`${ownIp}:${servedPort}`), origin: `http://${ownIp}:${servedPort}` }), token, servedPort, "lan")).resolves.toBeUndefined();
		await expect(checkMutationAuth(req({ ...authed(`${ownIp}:${servedPort}`), origin: `http://localhost:${servedPort}` }), token, servedPort, "lan")).resolves.toBeUndefined();
		await expect(checkMutationAuth(req({ ...authed(`${ownIp}:${servedPort}`), origin: `http://203.0.113.7:${servedPort}` }), token, servedPort, "lan")).rejects.toThrow(/same-origin/);
		await expect(checkMutationAuth(req({ ...authed(`${ownIp}:${servedPort}`), origin: `https://${ownIp}:${servedPort}` }), token, servedPort, "lan")).rejects.toThrow(/same-origin/);
	});

	it("LAN posture: the documented non-browser path (secrets, no Origin) still passes", async () => {
		await expect(checkMutationAuth(req(authed(`${ownIp}:${servedPort}`)), token, servedPort, "lan")).resolves.toBeUndefined();
	});

	it("loopback posture keeps the exact loopback Origin gate even for our own LAN address", async () => {
		await expect(checkMutationAuth(req({ ...authed(`127.0.0.1:${servedPort}`), origin: `http://${ownIp}:${servedPort}` }), token, servedPort)).rejects.toThrow(/same-origin/);
		await expect(checkMutationAuth(req({ ...authed(`127.0.0.1:${servedPort}`), origin: `http://127.0.0.1:${servedPort}` }), token, servedPort)).resolves.toBeUndefined();
	});
});

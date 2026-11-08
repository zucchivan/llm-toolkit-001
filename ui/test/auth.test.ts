/** Token/cookie primitives (Appendix C): constant-time compare, cookie parse. */
import { describe, expect, it } from "vitest";
import { hasValidCookie, newToken, parseCookies, sessionCookie, tokenEquals, COOKIE_NAME } from "../server/auth.ts";

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
		expect(cookie).not.toContain("Secure");
	});
});

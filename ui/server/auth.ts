/**
 * Auth (ui/PRD.md Appendix C): one random 256-bit token per server start.
 * `GET /?token=…` exchanges it once for an `HttpOnly; SameSite=Strict` cookie;
 * every /api request after that only needs the cookie. The token never
 * appears in logs and invalidates with the next server restart.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "kit_ui";
/** Non-HttpOnly companion cookie: the SPA reads it to echo X-Kit-Token (Appendix C step 5). */
export const CSRF_COOKIE_NAME = "kit_ui_csrf";

export function newToken(): string {
	return randomBytes(32).toString("base64url");
}

/** Length-independent, constant-time compare: hash both sides, then compare. */
export function tokenEquals(a: string, b: string): boolean {
	const ha = createHash("sha256").update(a).digest();
	const hb = createHash("sha256").update(b).digest();
	return timingSafeEqual(ha, hb);
}

export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		const name = part.slice(0, eq).trim();
		if (!name) continue;
		try {
			out[name] = decodeURIComponent(part.slice(eq + 1).trim());
		} catch {
			out[name] = part.slice(eq + 1).trim();
		}
	}
	return out;
}

/** True when the request carries the session cookie for this server's token. */
export function hasValidCookie(req: { headers: { cookie?: string } }, token: string): boolean {
	return tokenEquals(parseCookies(req.headers.cookie)[COOKIE_NAME] ?? "", token);
}

export function sessionCookie(token: string): string {
	// loopback local tool: no `Secure` (plain http), no `Max-Age` (browser session)
	return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

/**
 * The CSRF companion: readable by the page's own JS (no HttpOnly) so the SPA
 * can echo the session token in `X-Kit-Token`. SameSite=Strict means it is
 * never carried on cross-site requests; the Origin/Sec-Fetch-Site check below
 * is the control that refuses cross-site writers either way.
 */
export function csrfCookie(token: string): string {
	return `${CSRF_COOKIE_NAME}=${token}; Path=/; SameSite=Strict`;
}

export interface RequestLike {
	headers: Record<string, string | string[] | undefined>;
	socket?: { remoteAddress?: string };
}

/**
 * Mutation auth (Appendix C step 5, §12): the session cookie (401 path), the
 * `X-Kit-Token` header echo, AND a same-origin referral check — accept only a
 * same-origin `Origin`/`Sec-Fetch-Site`; a genuinely absent pair (non-browser
 * client that already knows the token) passes the other two factors.
 */
export class MutationAuthError extends Error {
	readonly status: 401 | 403;
	constructor(status: 401 | 403, message: string) {
		super(message);
		this.status = status;
	}
}

/** Loopback guarantee: a mutation from a non-loopback peer is rejected outright. */
export function isLoopbackPeer(req: RequestLike): boolean {
	const remote = (req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
	return remote === "127.0.0.1" || remote === "::1" || remote === ""; // "" only in direct unit tests
}

export function checkMutationAuth(req: RequestLike, token: string, servedPort: number): void {
	const host = String(req.headers.host ?? "");
	if (!localHostIntl(host, servedPort)) {
		throw new MutationAuthError(403, `mutation rejected: this server serves 127.0.0.1:${servedPort} — the request claims host ${host || "(none)"}`);
	}

	if (!hasValidCookie(req as { headers: { cookie?: string } }, token)) {
		throw new MutationAuthError(401, "unauthorized — reopen the URL printed by llm-toolkit-ui");
	}

	const headerToken = str(headerOf(req, "x-kit-token"));
	const cookieToken = parseCookies(str(req.headers.cookie as string | undefined))[CSRF_COOKIE_NAME] ?? "";
	if (headerToken !== token || cookieToken !== token) {
		throw new MutationAuthError(
			403,
			headerToken
				? "X-Kit-Token does not match this server's session — reopen the UI URL once and retry"
				: "mutating requests need the session's X-Kit-Token header (minted at handshake) — reopen the UI URL once and retry",
		);
	}

	// Origin/Sec-Fetch-Site: same-origin only — the anti-CSRF half of the pair.
	const origin = str(headerOf(req, "origin"));
	const site = str(headerOf(req, "sec-fetch-site"));
	if (origin) {
		let ok = false;
		try {
			const parsed = new URL(origin);
			ok = parsed.protocol === "http:" && parsed.port === String(servedPort) && isLoopbackName(parsed.hostname);
		} catch {
			ok = false;
		}
		if (!ok) throw new MutationAuthError(403, `mutation rejected: Origin ${origin} is not this server's origin (same-origin only)`);
		return;
	}
	if (site && site !== "same-origin") {
		throw new MutationAuthError(403, `mutation rejected: Sec-Fetch-Site ${site} is not same-origin`);
	}
	// No Origin and no Sec-Fetch-Site: non-browser client (curl/tests) that has
	// already proven both secrets — allow.
}

function localHostIntl(host: string, port: number): boolean {
	return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function isLoopbackName(hostname: string): boolean {
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function headerOf(req: RequestLike, name: string): string | string[] | undefined {
	return req.headers[name.toLowerCase()];
}

function str(value: string | string[] | undefined): string {
	return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/**
 * Auth (ui/PRD.md Appendix C + C.1): one random 256-bit token per server
 * start. `GET /?token=…` exchanges it once for an `HttpOnly; SameSite=Strict`
 * cookie; every /api request after that only needs the cookie. The token
 * never appears in logs and invalidates with the next server restart.
 *
 * C.1: the bind is loopback by default (the v1 contract — peer gate + the
 * loopback-only Host/Origin checks below). `--host`/`KIT_UI_HOST` opts into
 * a non-loopback bind under the SAME token model: the cookie stays the peer
 * control for every /api route, and the mutation Host/Origin check accepts
 * any name that IS this machine (interface addresses incl. Tailscale, plus
 * names that resolve to one). No TLS either way — C.1 says so in words.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

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
 * Mutation auth (Appendix C step 5 + C.1, §12): the session cookie (401 path),
 * the `X-Kit-Token` header echo, AND a same-origin referral check — accept
 * only a same-origin `Origin`/`Sec-Fetch-Site`; a genuinely absent pair
 * (non-browser client that already knows the token) passes the other two
 * factors. The cookie + CSRF pair is posture-independent; only the Host and
 * Origin HOSTNAME gates widen on an opt-in LAN bind (and only to names that
 * are this machine — see isOwnHostname).
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

// ---------------------------------------------------------------------------
// C.1 — bind posture: the default loopback bind keeps every gate; the opt-in
// non-loopback bind serves the same token model to LAN/Tailscale peers.
// ---------------------------------------------------------------------------

/**
 * The posture a bind host implies (C.1). Loopback names keep the loopback-only
 * gates byte-for-byte; ANY other bind — a concrete interface address, a
 * machine name, a wildcard — is the explicit LAN opt-in. Decided from the
 * bind string, not the request: opting in is the owner's act, and a hostname
 * that resolves to loopback while named oddly is still an explicit opt-in.
 */
export type BindPosture = "loopback" | "lan";

const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "ip6-localhost"]);

export function bindPostureFor(host: string): BindPosture {
	return LOOPBACK_BIND_HOSTS.has(host.trim().toLowerCase()) ? "loopback" : "lan";
}

/** Every address this machine answers on (LAN + Tailscale interfaces included), refreshed lazily. */
let interfaceCache: { at: number; addrs: Set<string> } | undefined;
const INTERFACE_CACHE_MS = 30_000;

function localInterfaceAddresses(): Set<string> {
	const now = Date.now();
	if (interfaceCache && now - interfaceCache.at < INTERFACE_CACHE_MS) return interfaceCache.addrs;
	const addrs = new Set<string>();
	for (const list of Object.values(networkInterfaces())) {
		for (const entry of list ?? []) {
			// strip the zone id ("fe80::1%eth0") and case-fold IPv6 hex
			addrs.add(entry.address.split("%")[0]!.toLowerCase());
		}
	}
	interfaceCache = { at: now, addrs };
	return addrs;
}

const HOSTNAME_ANSWER_CACHE_LIMIT = 64;
const hostnameAnswerCache = new Map<string, boolean>();

/**
 * C.1 same-origin generalization: a hostname names THIS server when it is a
 * loopback/wildcard name, an IP literal of one of our interfaces, or a name
 * that resolves (dns.lookup, cached) to one — so a Tailscale MagicDNS name
 * or a LAN hostname passes the Host/Origin checks exactly like 127.0.0.1
 * does on the default bind. Unresolvable names are not us (an mDNS hiccup
 * answers false; use the address — the refusal says so).
 */
export async function isOwnHostname(hostname: string): Promise<boolean> {
	const name = hostname.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
	if (name === "0.0.0.0" || name === "::") return true; // wildcard names mean "whatever this is"
	if (isLoopbackName(name)) return true;
	const literal = isIP(name);
	if (literal !== 0) return localInterfaceAddresses().has(name);
	const cached = hostnameAnswerCache.get(name);
	if (cached !== undefined) return cached;
	let answer = false;
	try {
		const { address } = await lookup(name);
		answer = localInterfaceAddresses().has(address.split("%")[0]!.toLowerCase());
	} catch {
		answer = false;
	}
	if (hostnameAnswerCache.size >= HOSTNAME_ANSWER_CACHE_LIMIT) hostnameAnswerCache.clear();
	hostnameAnswerCache.set(name, answer);
	return answer;
}

export async function checkMutationAuth(req: RequestLike, token: string, servedPort: number, posture: BindPosture = "loopback"): Promise<void> {
	const host = String(req.headers.host ?? "");
	// C.1: the Host gate. Loopback bind: the exact loopback-name check (the v1
	// contract, unchanged). LAN bind: any of this machine's names on the
	// session port — the bind was the opt-in, the port is the session.
	const hostOk = posture === "loopback" ? localHostIntl(host, servedPort) : await ownHostOnPort(host, servedPort);
	if (!hostOk) {
		throw new MutationAuthError(
			403,
			posture === "loopback"
				? `mutation rejected: this server serves 127.0.0.1:${servedPort} — the request claims host ${host || "(none)"}`
				: `mutation rejected: this server serves its own machine's names on :${servedPort} — the request claims host ${host || "(none)"}`,
		);
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
			ok =
				parsed.protocol === "http:" &&
				parsed.port === String(servedPort) &&
				(posture === "loopback" ? isLoopbackName(parsed.hostname) : await isOwnHostname(parsed.hostname));
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

/** C.1: the Host header names this server — one of our names on the session port. */
async function ownHostOnPort(host: string, port: number): Promise<boolean> {
	if (!host) return false;
	let parsed: URL;
	try {
		parsed = new URL(`http://${host}`);
	} catch {
		return false; // not a host header shape we serve
	}
	return parsed.port === String(port) && (await isOwnHostname(parsed.hostname));
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

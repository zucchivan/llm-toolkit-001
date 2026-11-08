/**
 * Static serving of the built SPA (ui/dist). Assets are inert: no auth needed.
 * The index shell is served by the router after the token handshake validates
 * the cookie.
 */
import { readFile, stat } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".png": "image/png",
	".ico": "image/x-icon",
};

export interface StaticResult {
	served: boolean;
	notFound?: boolean;
}

/** Serve one file under distDir; path must resolve inside distDir (no traversal). */
export async function serveStatic(distDir: string, pathname: string, res: {
	writeHead: (code: number, headers: Record<string, string>) => unknown;
	end: (body?: string | Buffer) => void;
}): Promise<StaticResult> {
	const root = resolve(distDir);
	const rel = normalize(pathname).replace(/^([/\\])+/, "");
	const abs = resolve(root, rel);
	if (abs !== root && !abs.startsWith(root + sep)) {
		res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
		res.end("bad path");
		return { served: true };
	}
	const file = await stat(abs).catch(() => undefined);
	if (!file || !file.isFile()) return { served: false, notFound: true };
	const body = await readFile(abs).catch(() => undefined);
	if (body === undefined) return { served: false, notFound: true };
	const ext = (abs.match(/\.[a-z0-9]+$/i) ?? [""])[0]!.toLowerCase();
	const immutable = rel.startsWith(join("assets", ""));
	res.writeHead(200, {
		"Content-Type": MIME[ext] ?? "application/octet-stream",
		"Content-Length": String(body.length),
		"Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(body);
	return { served: true };
}

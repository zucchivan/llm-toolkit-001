/**
 * llm-toolkit-ui HTTP server (ui/PRD.md §11.2 + Appendix C):
 *   GET  /?token=…          one-time handshake → HttpOnly + CSRF cookies + 302 /
 *   GET  /                  SPA shell (cookie required); static assets without auth
 *   GET  /api/readout       the current KitReadout + mode + at (cookie required)
 *   GET  /api/events        SSE: `readout` snapshots, `job` events, heartbeats (cookie)
 *   GET  /api/jobs          job records + the attached terminal-started run (cookie)
 *   GET  /api/jobs/:id      one job record
 *   GET  /api/jobs/:id/log  tail of a job log (?n=200, max 5000)
 *   GET  /api/tasks/:id/diff       persisted patch + stats (§11.2; 404 if none)
 *   GET  /api/tasks/:id/diff/live  live patch vs the task baseline (409 if not in-flight)
 *   GET  /api/artifacts            artifact list (§11.4)
 *   GET  /api/artifacts/:name      artifact text ≤5 MiB (larger → metadata + download link)
 *   POST /api/actions       { kind, …params } → 202 { jobId } — cookie AND
 *                           X-Kit-Token header AND same-origin (Appendix C step 5)
 *
 * Loopback bind only; the lock is never held between requests; the server never
 * writes loop state — actions run as detached CLI jobs (Appendix B).
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import type { AddressInfo } from "node:net";
import { checkMutationAuth, csrfCookie, hasValidCookie, isLoopbackPeer, MutationAuthError, sessionCookie, tokenEquals } from "./auth.ts";
import { readOnce } from "./readout.ts";
import { artifactList, artifactPath, liveTaskDiff, locateTaskDiff, readArtifact, readTaskDiff, validateName } from "./diff.ts";
import { startAction, stopAction, validateAction } from "./actions.ts";
import { serveStatic } from "./static.ts";
import { currentJobsEvent, startSnapshotHub, type SnapshotHub } from "./sse.ts";
import { jobsViewList, markStaleRecords, pruneJobs, readJobRecord, tailJobLog } from "./jobs.ts";

export interface UiServerOptions {
	/** The project directory this server reads (one project per server). */
	root: string;
	/** Per-start random token (Appendix C). */
	token: string;
	/** 0 = ephemeral; the resolved port lands in the returned url. */
	port: number;
	/** Built client bundle directory (ui/dist). */
	distDir: string;
	heartbeatMs?: number;
	/** Test seam: skip the startup jobs sweep (markStale/prune). */
	skipJobSweep?: boolean;
}

export interface RunningUiServer {
	server: Server;
	url: string;
	port: number;
	hub: SnapshotHub;
	/** Actions spawned/stopped by this server pulse a `job` SSE event via this. */
	shutdown(): Promise<void>;
}

export function startServer(opts: UiServerOptions): Promise<RunningUiServer> {
	const hub = startSnapshotHub(opts.root);
	if (!opts.skipJobSweep) {
		void markStaleRecords(opts.root)
			.then((stale) => {
				if (stale > 0) console.log(`[llm-toolkit-ui] marked ${stale} dead-pid job record(s) stale`);
				return pruneJobs(opts.root);
			})
			.catch((err) => console.error(`[llm-toolkit-ui] job sweep failed: ${(err as Error).message}`));
	}
	const server = createServer((req, res) => {
		void route(req, res, opts, hub).catch((err) => {
			jsonError(res, 500, `ui server error: ${(err as Error).message}`);
		});
	});
	return new Promise((resolveRunning, rejectRunning) => {
		server.once("error", rejectRunning);
		server.listen(opts.port, "127.0.0.1", () => {
			const address = server.address() as AddressInfo;
			resolveRunning({
				server,
				port: address.port,
				hub,
				url: `http://127.0.0.1:${address.port}/?token=${opts.token}`,
				shutdown: async () => {
					hub.stop();
					await closeServer(server);
				},
			});
		});
	});
}

function jsonError(res: ServerResponse, status: number, error: string, detail?: Record<string, unknown>): void {
	if (!res.headersSent) {
		res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	}
	res.end(JSON.stringify({ error, ...(detail ?? {}) }));
}

function closeServer(server: Server): Promise<void> {
	return new Promise((done) => {
		server.closeAllConnections?.();
		server.close(() => done());
	});
}

async function route(req: IncomingMessage, res: ServerResponse, opts: UiServerOptions, hub: SnapshotHub): Promise<void> {
	const port = (res.socket?.localPort) ?? opts.port;
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const pathname = url.pathname;

	// --- token handshake (Appendix C steps 2–3): exactly once, then redirected
	if (pathname === "/" && req.method === "GET") {
		const tokenParam = url.searchParams.get("token");
		if (tokenParam !== null) {
			if (tokenEquals(tokenParam, opts.token)) {
				res.writeHead(302, { "Set-Cookie": [sessionCookie(opts.token), csrfCookie(opts.token)], Location: "/" });
				res.end();
				return;
			}
			res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("invalid token — use the exact URL printed by `llm-toolkit-ui`");
			return;
		}
		if (!hasValidCookie(req, opts.token)) {
			res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("unauthorized — reopen the URL printed by llm-toolkit-ui (each server start mints a fresh token)");
			return;
		}
		const served = await serveStatic(opts.distDir, "/index.html", res);
		if (!served.served) {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("ui client bundle missing — run `npm --prefix ui run build`");
		}
		return;
	}

	// --- API: cookie required for everything under /api (SSE uses the cookie too)
	if (pathname.startsWith("/api/")) {
		if (!isLoopbackPeer(req)) {
			jsonError(res, 403, "this server is loopback-only");
			return;
		}
		const cookieOk = hasValidCookie(req, opts.token);
		if (!cookieOk) {
			jsonError(res, 401, "unauthorized — reopen the URL printed by llm-toolkit-ui");
			return;
		}
		if (req.method !== "GET" && !isLoopbackPeer(req)) {
			jsonError(res, 403, "mutations are loopback-only");
			return;
		}
		if (pathname === "/api/readout") {
			if (req.method !== "GET") return void jsonError(res, 405, `method ${req.method ?? "?"} not allowed`);
			const snapshot = await readOnce(opts.root);
			res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
			res.end(JSON.stringify(snapshot));
			return;
		}
		if (pathname === "/api/events") {
			if (req.method !== "GET") return void jsonError(res, 405, `method ${req.method ?? "?"} not allowed`);
			serveEvents(req, res, opts, hub);
			return;
		}
		if (pathname === "/api/jobs") {
			if (req.method !== "GET") return void jsonError(res, 405, `method ${req.method ?? "?"} not allowed`);
			const payload = await currentJobsEvent(opts.root);
			res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
			res.end(JSON.stringify(payload));
			return;
		}
		const jobMatch = /^\/api\/jobs\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(\/log)?$/.exec(pathname);
		if (jobMatch) {
			if (req.method !== "GET") return void jsonError(res, 405, `method ${req.method ?? "?"} not allowed`);
			return await serveJobRoute(req, res, opts, jobMatch[1]!, jobMatch[2] === "/log", url.searchParams);
		}
		// §11.4: ids/names failing validation 400 INSIDE the handlers — the route
		// stays loose so traversal-shaped ids surface as 400, not a generic 404.
		const taskDiffMatch = /^\/api\/tasks\/([^/]+)\/diff(\/live)?$/.exec(pathname);
		if (taskDiffMatch) {
			if (req.method !== "GET") return void jsonError(res, 405, `method ${req.method ?? "?"} not allowed`);
			return await serveTaskDiffRoute(req, res, opts.root, taskDiffMatch[1]!, taskDiffMatch[2] === "/live", url.searchParams.get("download") === "1");
		}
		const artifactMatch = /^\/api\/artifacts(?:\/([^/]+))?$/.exec(pathname);
		if (artifactMatch) {
			if (req.method !== "GET") return void jsonError(res, 405, `method ${req.method ?? "?"} not allowed`);
			return await serveArtifactRoute(req, res, opts.root, artifactMatch[1], url.searchParams.get("download") === "1");
		}
		if (pathname === "/api/actions" && req.method === "POST") {
			return await serveActionPost(req, res, opts, hub, port);
		}
		if (pathname === "/api/actions") {
			jsonError(res, 405, "use POST for /api/actions");
			return;
		}
		if (req.method !== "GET") {
			jsonError(res, 405, `method ${req.method ?? "?"} not allowed`);
			return;
		}
		res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ error: `no route ${pathname}` }));
		return;
	}

	// --- static assets (inert): no auth
	if (req.method !== "GET") {
		jsonError(res, 405, `method ${req.method ?? "?"} not allowed`);
		return;
	}
	let assetPath = pathname;
	try {
		assetPath = decodeURIComponent(pathname);
	} catch {
		/* malformed escape served as literal bytes; stat will not find it */
	}
	const served = await serveStatic(opts.distDir, assetPath, res);
	if (!served.served) {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end(`no asset ${pathname}`);
	}
}

async function serveTaskDiffRoute(
	req: IncomingMessage,
	res: ServerResponse,
	root: string,
	taskId: string,
	live: boolean,
	download: boolean,
): Promise<void> {
	if (live) {
		const result = await liveTaskDiff(root, taskId);
		if (!result.ok) {
			jsonError(res, result.status, result.error, result.detail);
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
		res.end(JSON.stringify(result.payload));
		return;
	}
	if (download) {
		// Raw patch download: the stored artifact file, as an attachment (it is
		// already ≤ 5 MiB at write time; binary-safe bytes, never previewed).
		const located = await locateTaskDiff(root, taskId);
		if (!located) {
			jsonError(res, 404, `no diff artifacts for task ${taskId} yet (only done/quarantined tasks persist a patch)`);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "application/octet-stream",
			"Content-Disposition": `attachment; filename="${located.patch}"`,
			"Cache-Control": "no-store",
		});
		void createReadStream(located.patchPath)
			.on("error", () => {
				if (!res.writableEnded) res.end();
			})
			.pipe(res);
		return;
	}
	const result = await readTaskDiff(root, taskId);
	if (!result.ok) {
		jsonError(res, result.status, result.error, result.detail);
		return;
	}
	res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(JSON.stringify(result.payload));
}

async function serveArtifactRoute(req: IncomingMessage, res: ServerResponse, root: string, rawName: string | undefined, download: boolean): Promise<void> {
	if (rawName === undefined) {
		const artifacts = await artifactList(root);
		res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
		res.end(JSON.stringify({ at: Date.now(), artifacts }));
		return;
	}
	let name = rawName;
	try {
		name = decodeURIComponent(rawName);
	} catch {
		jsonError(res, 400, "artifact name is not valid URL-encoded text");
		return;
	}
	if (typeof name !== "string" || !validateName(name)) {
		jsonError(res, 400, `bad artifact name ${JSON.stringify(name)} — expected [A-Za-z0-9._-] (no traversal)`);
		return;
	}
	if (download) {
		const path = artifactPath(root, name);
		if (!path) {
			jsonError(res, 400, `bad artifact name ${JSON.stringify(name)} — expected [A-Za-z0-9._-] (no traversal)`);
			return;
		}
		const meta = await import("node:fs/promises").then((fs) => fs.stat(path).catch(() => undefined));
		if (!meta?.isFile()) {
			jsonError(res, 404, `no artifact ${name}`);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "application/octet-stream",
			"Content-Disposition": `attachment; filename="${name}"`,
			"Content-Length": meta.size,
			"Cache-Control": "no-store",
		});
		void createReadStream(path)
			.on("error", () => {
				if (!res.writableEnded) res.end();
			})
			.pipe(res);
		return;
	}
	const read = await readArtifact(root, name);
	if (read.kind === "missing") {
		jsonError(res, 404, `no artifact ${name}`);
		return;
	}
	if (read.kind === "metadata") {
		// §11.4: larger files return metadata + a download link, not content.
		res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
		res.end(JSON.stringify({ name: read.name, bytes: read.bytes, oversized: true, download: read.download }));
		return;
	}
	if (read.kind === "binary") {
		// §11.4: binary patches are labeled, not previewed as text.
		res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
		res.end(JSON.stringify({ name: read.name, bytes: read.bytes, binary: true, download: `/api/artifacts/${encodeURIComponent(read.name)}?download=1` }));
		return;
	}
	res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
	res.end(read.text);
}

async function serveJobRoute(
	req: IncomingMessage,
	res: ServerResponse,
	opts: UiServerOptions,
	id: string,
	wantsLog: boolean,
	params: URLSearchParams,
): Promise<void> {
	const record = await readJobRecord(opts.root, id);
	if (!record) {
		// attached runs are visible on /api/jobs, not as anchored records
		jsonError(res, 404, `no job record ${id}`);
		return;
	}
	if (!wantsLog) {
		res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
		res.end(JSON.stringify({ at: Date.now(), job: record }));
		return;
	}
	const requestedN = Number.parseInt(params.get("n") ?? "200", 10);
	const n = Number.isInteger(requestedN) && requestedN > 0 ? Math.min(5_000, requestedN) : 200;
	const lines = await tailJobLog(record.logPath, n);
	res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(JSON.stringify({ at: Date.now(), job: record, lines }));
}

async function serveActionPost(req: IncomingMessage, res: ServerResponse, opts: UiServerOptions, hub: SnapshotHub, port: number): Promise<void> {
	// Appendix C step 5: cookie (already checked) + X-Kit-Token echo + same-origin.
	try {
		checkMutationAuth(req, opts.token, port);
	} catch (err) {
		if (err instanceof MutationAuthError) {
			jsonError(res, err.status, err.message);
			return;
		}
		throw err;
	}

	// Body: JSON object, guarded size.
	let raw = "";
	for await (const chunk of req) {
		raw += String(chunk);
		if (raw.length > 64 * 1024) {
			jsonError(res, 413, "body too large (actions are small JSON objects)");
			return;
		}
	}
	let parsed: unknown;
	try {
		parsed = raw.trim() ? JSON.parse(raw) : undefined;
	} catch {
		jsonError(res, 400, "body is not valid JSON");
		return;
	}
	const validation = validateAction(parsed);
	if (!validation.ok) {
		jsonError(res, validation.status, validation.error);
		return;
	}
	const body = validation.body;

	// `stop` acts on the new-est running UI job; everything else spawns one.
	if (body.kind === "stop") {
		const result = await stopAction(opts.root);
		if (!result.ok) {
			jsonError(res, result.fail.status, result.fail.error, {
				...(result.fail.holderPid ? { holderPid: result.fail.holderPid } : {}),
				...(result.fail.phase ? { phase: result.fail.phase } : {}),
			});
			return;
		}
		hub.pulseJobs();
		res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ jobId: result.jobId, pid: result.pid, kind: "stop" }));
		return;
	}
	const result = await startAction(opts.root, body);
	if (!result.ok) {
		jsonError(res, result.fail.status, result.fail.error, {
			...(result.fail.holderPid ? { holderPid: result.fail.holderPid } : {}),
			...(result.fail.phase ? { phase: result.fail.phase } : {}),
			...(result.fail.jobId ? { jobId: result.fail.jobId } : {}),
			...(result.fail.missing ? { missing: result.fail.missing } : {}),
			...(result.fail.configError ? { configError: result.fail.configError } : {}),
		});
		return;
	}
	hub.pulseJobs();
	res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify({ jobId: result.job.id, kind: result.job.kind, via: result.via }));
}

function serveEvents(req: IncomingMessage, res: ServerResponse, opts: UiServerOptions, hub: SnapshotHub): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	const write = (chunk: string): void => {
		if (!res.writableEnded) res.write(chunk);
	};
	// reconnect / new client → one full snapshot immediately (PRD §11.3)
	void readOnce(opts.root)
		.then((snapshot) => write(`event: readout\ndata: ${JSON.stringify(snapshot)}\n\n`))
		.catch(() => write("event: readout\ndata: null\n\n"));
	void currentJobsEvent(opts.root)
		.then((payload) => write(`event: job\ndata: ${JSON.stringify(payload)}\n\n`))
		.catch(() => {});
	const unsubscribe = hub.subscribe(write);
	const heartbeatMs = opts.heartbeatMs ?? 15_000;
	const heartbeat = setInterval(() => {
		try {
			write(": heartbeat\n\n");
		} catch {
			cleanup();
		}
	}, heartbeatMs);
	heartbeat.unref?.();
	const cleanup = (): void => {
		clearInterval(heartbeat);
		unsubscribe();
		req.destroy();
	};
	req.on("close", cleanup);
	req.on("error", cleanup);
}

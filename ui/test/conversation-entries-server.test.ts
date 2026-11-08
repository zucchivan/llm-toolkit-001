/**
 * Conversation transcript excerpt HTTP contract tests (Appendix A.5):
 *   GET /api/conversations/:id/entries
 *     200 — the bounded excerpt (plain JSON shapes: ids/timestamps as numbers,
 *           content as strings; truncated flag; Cache-Control: no-store)
 *     404 — an id the project has no conversation for
 *     409 — while another process holds .orch/lock, in the established tone
 *           ("conversation detail returns when the lock is free — a run is live")
 *     401 — the session cookie is required like every other GET
 * The excerpt read is lock-per-read: the lock is taken inside the request and
 * released before the response completes (asserted implicitly — the seeded
 * harness close + a second request both succeed).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningUiServer } from "../server/server.ts";
import { newToken } from "../server/auth.ts";
import { bakeConfiguredDemo } from "./helpers.ts";
import { buildFauxModels, fauxAssistantMessage } from "../../test/fixtures.ts";
import { openProjectHarness } from "../../src/engine/harness.ts";
import { loadPrd, runPlan } from "../../src/engine/planner.ts";
import { readout } from "../../src/engine/inspector.ts";

const ONE_TASK = {
	tasks: [
		{ id: "t1", title: "one", spec: "write src/one.ts with the module.", dependsOn: [], acceptance: ["When src/one.ts exists, the system shall compile."], targetPaths: ["src/"], priority: 1 },
	],
};

let root: string;
let running: RunningUiServer;
let cookie: string;
let base: string;
let plannerConvId: number;

beforeAll(async () => {
	root = await bakeConfiguredDemo();

	// Seed one real conversation (the planner's) through the engine — the same
	// table storage the endpoint will scan.
	const { models, faux } = buildFauxModels([]);
	faux.appendResponses([fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" })]);
	const kit = await openProjectHarness(root, "seed", { modelsOverride: models });
	await runPlan(kit, "docs/prd.md", await loadPrd(kit));
	const read = await readout(kit.loop.paths, { loop: kit });
	const planner = read.storage!.conversations.find((c) => c.role === "planner");
	if (!planner) throw new Error("seed produced no planner conversation");
	plannerConvId = planner.id;
	await kit.loop.close();
	kit.lock.release();

	const token = newToken();
	const dist = await mkdtemp(join(tmpdir(), "ui-conv-dist-"));
	await writeFile(join(dist, "index.html"), "<!doctype html><title>ok</title>", "utf8");
	running = await startServer({ root, token, port: 0, distDir: dist, heartbeatMs: 500, skipJobSweep: true });
	cookie = `kit_ui=${token}; kit_ui_csrf=${token}`;
	base = `http://127.0.0.1:${running.port}`;
}, 60_000);

afterAll(async () => {
	await running?.shutdown().catch(() => {});
	await rm(root, { recursive: true, force: true }).catch(() => {});
});

const get = (path: string): Promise<Response> => fetch(`${base}${path}`, { headers: { cookie } });

describe("GET /api/conversations/:id/entries (A.5)", () => {
	it("200: the planner conversation excerpts as plain JSON, bounded + not truncated", async () => {
		const res = await get(`/api/conversations/${plannerConvId}/entries`);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toContain("no-store");
		const payload = (await res.json()) as {
			at: number;
			conversation: number;
			entries: { id: number; kind: string; ts?: number; role?: string; text: string; toolCalls?: { name: string; input: string }[] }[];
			truncated: boolean;
		};
		expect(payload.conversation).toBe(plannerConvId);
		expect(payload.truncated).toBe(false);
		expect(payload.entries.length).toBeGreaterThanOrEqual(2);
		// the planning prompt (user) and the plan JSON (assistant) are both present
		expect(payload.entries.some((e) => e.kind === "pi.user" && e.text.length > 0)).toBe(true);
		expect(payload.entries.some((e) => e.kind === "pi.assistant" && e.text.includes("t1"))).toBe(true);
		// every shape is plain JSON: numbers + strings only
		expect(() => JSON.parse(JSON.stringify(payload))).not.toThrow();
		for (const entry of payload.entries) {
			expect(Number.isInteger(entry.id)).toBe(true);
			if (entry.ts !== undefined) expect(Number.isFinite(entry.ts)).toBe(true);
			expect(typeof entry.text).toBe("string");
		}
	});

	it("404: an id the project has no conversation for", async () => {
		const res = await get("/api/conversations/999999/entries");
		expect(res.status).toBe(404);
		const payload = (await res.json()) as { error: string };
		expect(payload.error).toContain("no conversation #999999");
	});

	it("409: a live lock holder answers in the established tone (and the lock is free again after)", async () => {
		const holder = await openProjectHarness(root, "holder", { modelsOverride: buildFauxModels([]).models });
		try {
			const res = await get(`/api/conversations/${plannerConvId}/entries`);
			expect(res.status).toBe(409);
			const payload = (await res.json()) as { error: string };
			expect(payload.error).toMatch(/conversation detail returns when the lock is free — a run is live/);
		} finally {
			await holder.loop.close();
			holder.lock.release();
		}
		// lock-per-read: once the holder lets go, the same request is a 200 again
		const after = await get(`/api/conversations/${plannerConvId}/entries`);
		expect(after.status).toBe(200);
	});

	it("405 on a non-GET", async () => {
		const res = await fetch(`${base}/api/conversations/${plannerConvId}/entries`, { method: "POST", headers: { cookie } });
		expect(res.status).toBe(405);
	});

	it("401 without the session cookie", async () => {
		const res = await fetch(`${base}/api/conversations/${plannerConvId}/entries`);
		expect(res.status).toBe(401);
	});
});

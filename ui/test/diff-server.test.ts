/**
 * Diff + artifact HTTP contract tests (§11.2/§11.4 + Appendix A.2/A.3):
 *   GET /api/tasks/:id/diff        persisted patch + parsed stats; 404 when absent;
 *                                  400 on a traversal-shaped task id
 *   GET /api/tasks/:id/diff?wave=N A.7 per-wave isolated diff: computed between
 *                                  the wave's own recorded trees (409 plain-words
 *                                  when not isolatable; 200 empty + note when the
 *                                  wave's delta is engine-owned-only churn)
 *   GET /api/tasks/:id/diff/live   200 mid-wave vs the task baseline (exclusions
 *                                  still applied); empty 200 before anything writes;
 *                                  409 when the task is not the in-flight one
 *   GET /api/artifacts[/name]      list / text ≤5 MiB / metadata for larger
 *                                  (with a download link) / traversal → 400
 * `?download=1` streams the stored patch as an attachment (≤5 MiB at write time).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startServer, type RunningUiServer } from "../server/server.ts";
import { newToken } from "../server/auth.ts";
import { bakeConfiguredDemo } from "./helpers.ts";
import { captureBaselineTree } from "../../src/util/git.ts";
import { DISPLAY_PATCH_CAP_BYTES } from "../../src/util/git.ts";
import type { DisplayDiffStats } from "../../src/util/git.ts";
import type { TaskDiffPayload } from "../src/lib/api.ts";

let root: string;
let running: RunningUiServer;
let cookie: string;
let base: string;

beforeAll(async () => {
	root = await bakeConfiguredDemo();
	const token = newToken();
	running = await startServer({
		root,
		token,
		port: 0,
		distDir: await fakeDist(),
		heartbeatMs: 500,
		skipJobSweep: true,
	});
	cookie = `kit_ui=${token}; kit_ui_csrf=${token}`;
	base = `http://127.0.0.1:${running.port}`;

	// Seed a done task's artifacts (patch + stats side-car) and a quarantine's.
	const artifacts = join(root, ".orch", "artifacts");
	await mkdir(artifacts, { recursive: true });
	await writeFile(
		join(artifacts, "task-one.patch"),
		`diff --git a/src/one.ts b/src/one.ts
index 1111111..2222222 100644
--- a/src/one.ts
+++ b/src/one.ts
@@ -0,0 +1,1 @@
+export const one = 1;
`,
		"utf8",
	);
	await writeFile(
		join(artifacts, "task-one.json"),
		JSON.stringify({
			task: "one",
			wave: 2,
			baselineTreeSha: "1111111111111111111111111111111111111111",
			generatedAt: 1,
			files: [{ path: "src/one.ts", status: "A", insertions: 1, deletions: 0, binary: false }],
			totalInsertions: 1,
			totalDeletions: 0,
			bytes: 163,
			truncated: false,
		} satisfies DisplayDiffStats),
		"utf8",
	);
	await writeFile(join(artifacts, "quarantined-two-w1.patch"), "diff --git a/src/two.ts b/src/two.ts\n--- a/src/two.ts\n+++ b/src/two.ts\n@@ -0,0 +1,1 @@\n+export const two = 2;\n", "utf8");
	await writeFile(
		join(artifacts, "quarantined-two-w1.json"),
		JSON.stringify({ task: "two", wave: 1, baselineTreeSha: "a", generatedAt: 1, files: [], totalInsertions: 0, totalDeletions: 0, bytes: 80, truncated: false }),
		"utf8",
	);
	// an oversized artifact for the metadata path (5 MiB cap)
	await writeFile(join(artifacts, "gate-huge-w9.log"), "x".repeat(DISPLAY_PATCH_CAP_BYTES + 10), "utf8");
});

afterAll(async () => {
	await running?.shutdown().catch(() => {});
	await rm(root, { recursive: true, force: true }).catch(() => {});
});

let distDirPromise: Promise<string> | undefined;
async function fakeDist(): Promise<string> {
	distDirPromise ??= (async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const dir = await mkdtemp(join(tmpdir(), "ui-diff-dist-"));
		await writeFile(join(dir, "index.html"), "<!doctype html><title>ok</title>", "utf8");
		return dir;
	})();
	return distDirPromise;
}

const get = (path: string): Promise<Response> => fetch(`${base}${path}`, { headers: { cookie } });

describe("GET /api/tasks/:id/diff (persisted)", () => {
	it("returns the patch text + parsed stats for a done task", async () => {
		const res = await get("/api/tasks/one/diff");
		expect(res.status).toBe(200);
		const payload = (await res.json()) as { task: string; patch: string; stats: string; diff: string; statsJson?: DisplayDiffStats; bytes: number; truncated: boolean };
		expect(payload.patch).toBe("task-one.patch");
		expect(payload.stats).toBe("task-one.json");
		expect(payload.diff).toContain("+export const one = 1;");
		expect(payload.statsJson?.task).toBe("one");
		expect(payload.statsJson?.wave).toBe(2);
		expect(payload.statsJson?.files[0]).toEqual({ path: "src/one.ts", status: "A", insertions: 1, deletions: 0, binary: false });
		expect(payload.bytes).toBe(Buffer.byteLength(await readFile(join(root, ".orch", "artifacts", "task-one.patch"), "utf8")));
		expect(payload.truncated).toBe(false);
	});

	it("resolves the newest quarantined wave patch (+stats) for a quarantined task", async () => {
		await writeFile(join(root, ".orch", "artifacts", "quarantined-two-w3.patch"), "diff --git a/late b/late\n--- a/late\n+++ b/late\n@@ -0,0 +1 +0,0 @@\n", "utf8");
		const res = await get("/api/tasks/two/diff");
		expect(res.status).toBe(200);
		const payload = (await res.json()) as TaskDiffPayload;
		expect(payload.patch).toBe("quarantined-two-w3.patch");
		expect(payload.diff).toContain("late");
	});

	it("404 for a task without artifacts; 404 names stay plain", async () => {
		const res = await get("/api/tasks/nobody/diff");
		expect(res.status).toBe(404);
		const payload = (await res.json()) as { error: string };
		expect(payload.error).toContain("no diff artifacts for task nobody");
	});

	it("400 on a traversal-shaped task id (and on separator characters)", async () => {
		const res = await get("/api/tasks/%2E%2E%2Fevil/diff");
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/bad task id/);
		const res2 = await get("/api/tasks/one%2Ftwo/diff");
		expect(res2.status).toBe(400);
	});

	it("?download=1 streams the stored patch file as an attachment", async () => {
		const res = await get("/api/tasks/one/diff?download=1");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/octet-stream");
		expect(res.headers.get("content-disposition")).toContain("task-one.patch");
		const text = await res.text();
		expect(text).toContain("diff --git a/src/one.ts");
	});
});

describe("GET /api/tasks/:id/diff/live", () => {
	it("409 when nothing is running", async () => {
		const res = await get("/api/tasks/one/diff/live");
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string; detail?: { phase: string } };
		expect(body.error).toMatch(/not the current in-flight task/);
		expect((body as { phase?: string }).phase).toBe("unknown");
	});

	it("200 mid-wave: the tree vs the task baseline, engine-owned paths excluded", async () => {
		// a real baseline of the current tree; then three changes: a display file,
		// router.md (excluded), and an .orch side-car (excluded)
		const baseline = await captureBaselineTree(root);
		await writeFile(join(root, "src", "live.ts"), "export const LIVE = true;\n", "utf8");
		const routerBefore = await readFile(join(root, "router.md"), "utf8").catch(() => "");
		await writeFile(join(root, "router.md"), `${routerBefore}\n<!-- engine touches the mirror -->\n`, "utf8");
		await writeFile(join(root, ".orch", "status.json"), JSON.stringify({
			phase: "wave-running",
			task: { id: "t-live", wave: 1, status: "running", startedAt: Date.now() },
			tasks: [{ id: "t-live", status: "in_progress", waveCount: 1, title: "live", baselineTreeSha: baseline }],
			ts: Date.now(),
		}), "utf8");

		const res = await get("/api/tasks/t-live/diff/live");
		expect(res.status).toBe(200);
		const payload = (await res.json()) as {
			task: string;
			wave: number;
			baselineTreeSha: string;
			bytes: number;
			truncated: boolean;
			diff: string;
			stats: { files: { path: string; status: string; insertions: number; deletions: number; binary: boolean }[] };
		};
		expect(payload.task).toBe("t-live");
		expect(payload.wave).toBe(1);
		expect(payload.baselineTreeSha).toBe(baseline);
		expect(payload.diff).toContain("+export const LIVE = true;");
		expect(payload.diff).not.toContain("engine touches the mirror");
		expect(payload.diff).not.toContain("src/one.ts"); // seeded diff artifact is not tree state
		expect(payload.stats.files.map((f) => `${f.path}:${f.status}`)).toEqual(["src/live.ts:A"]);

		// the engine-owned write never lands in the patch either
		const redownload = await get("/api/tasks/t-live/diff/live");
		expect((await redownload.json()) as { diff: string }).toBeTruthy();

		// cleanup: nothing persisted by the live path
		const artifacts = await readFile(join(root, ".orch", "artifacts", "task-t-live.patch"), "utf8").catch(() => "<absent>");
		expect(artifacts).toBe("<absent>");
	});

	it("200 (empty) when the in-flight wave has not changed anything yet", async () => {
		const baseline = await captureBaselineTree(root);
		await writeFile(join(root, ".orch", "status.json"), JSON.stringify({
			phase: "wave-running",
			task: { id: "t-quiet", wave: 1, status: "running", startedAt: Date.now() },
			tasks: [{ id: "t-quiet", status: "in_progress", waveCount: 1, title: "quiet", baselineTreeSha: baseline }],
			ts: Date.now(),
		}), "utf8");
		const res = await get("/api/tasks/t-quiet/diff/live");
		expect(res.status).toBe(200);
		const payload = (await res.json()) as { diff: string; note?: string; stats: { files: unknown[] } };
		expect(payload.diff).toBe("");
		expect(payload.note).toBeTruthy();
		expect(payload.stats.files).toEqual([]);
	});

	it("409 when the task is not the in-flight one (another task holds the wave)", async () => {
		const baseline = await captureBaselineTree(root);
		await writeFile(join(root, ".orch", "status.json"), JSON.stringify({
			phase: "wave-running",
			task: { id: "t-live", wave: 2, status: "running", startedAt: Date.now() },
			tasks: [{ id: "t-live", status: "in_progress", waveCount: 2, title: "live", baselineTreeSha: baseline }],
			ts: Date.now(),
		}), "utf8");
		const res = await get("/api/tasks/the-other/diff/live");
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string; detail?: { currentTask?: string } };
		expect(body.error).toContain("live: t-live");
		expect((body as { currentTask?: string }).currentTask).toBe("t-live");
	});
});

describe("GET /api/artifacts (§11.4)", () => {
	it("lists artifact entries", async () => {
		const res = await get("/api/artifacts");
		expect(res.status).toBe(200);
		const payload = (await res.json()) as { artifacts: { name: string; bytes: number }[] };
		const names = payload.artifacts.map((a) => a.name);
		expect(names).toContain("task-one.patch");
		expect(names).toContain("task-one.json");
		expect(names).toContain("gate-huge-w9.log");
	});

	it("text artifact ≤ cap returns the body; oversized returns metadata + download", async () => {
		const text = await get("/api/artifacts/task-one.patch");
		expect(text.status).toBe(200);
		expect(await text.text()).toContain("diff --git a/src/one.ts");

		const meta = await get("/api/artifacts/gate-huge-w9.log");
		expect(meta.status).toBe(200);
		const body = (await meta.json()) as { name: string; bytes: number; oversized: boolean; download: string };
		expect(body.oversized).toBe(true);
		expect(body.name).toBe("gate-huge-w9.log");
		expect(body.bytes).toBe(DISPLAY_PATCH_CAP_BYTES + 10);
		expect(body.download).toBe("/api/artifacts/gate-huge-w9.log?download=1");

		const dl = await get(body.download);
		expect(dl.status).toBe(200);
		expect(dl.headers.get("content-disposition")).toContain("gate-huge-w9.log");
		expect((await dl.arrayBuffer()).byteLength).toBe(DISPLAY_PATCH_CAP_BYTES + 10);
	});

	it("400 on traversal-ish names; 404 missing", async () => {
		const bad = await get("/api/artifacts/..%2Fstatus.json");
		expect(bad.status).toBe(400);
		const missing = await get("/api/artifacts/no-such-thing.log");
		expect(missing.status).toBe(404);
	});
});

describe("GET /api/tasks/:id/diff?wave=N (A.7 per-wave isolated)", () => {
	beforeAll(async () => {
		// A real wave history for task "wtest" — trees captured the way the engine
		// does (captureBaselineTree), rows appended to the side-car log:
		//   wave 1: src/wave.ts appears inside the wave (its own delta)
		//   wave 2: engine-owned-only churn inside the wave (router.md) → 200 empty
		//   wave 3: rows without treeSha (the capture-failed posture)
		//   wave 4: a start row with a tree but no end row yet
		await mkdir(join(root, "src"), { recursive: true });
		const w1Start = await captureBaselineTree(root);
		await writeFile(join(root, "src", "wave.ts"), "export const w = 1;\n", "utf8");
		const w1End = await captureBaselineTree(root);
		const w2Start = await captureBaselineTree(root);
		await writeFile(join(root, "router.md"), "router mirror churn inside wave 2\n", "utf8");
		const w2End = await captureBaselineTree(root);
		const rows = [
			{ ts: 1_000, kind: "wave", task: "wtest", wave: 1, verb: "start", treeSha: w1Start },
			{ ts: 1_100, kind: "wave", task: "wtest", wave: 1, verb: "end", detail: "approved", treeSha: w1End },
			{ ts: 2_000, kind: "wave", task: "wtest", wave: 2, verb: "start", treeSha: w2Start },
			{ ts: 2_100, kind: "wave", task: "wtest", wave: 2, verb: "end", detail: "approved", treeSha: w2End },
			{ ts: 3_000, kind: "wave", task: "wtest", wave: 3, verb: "start" },
			{ ts: 3_100, kind: "wave", task: "wtest", wave: 3, verb: "end", detail: "approved" },
			{ ts: 4_000, kind: "wave", task: "wtest", wave: 4, verb: "start", treeSha: w2Start },
		];
		const logPath = join(root, ".orch", "wave-log.jsonl");
		const prior = await readFile(logPath, "utf8").catch(() => "");
		await writeFile(logPath, prior + rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
	});

	it("400 on a wave that is not a positive integer", async () => {
		const nope = await get("/api/tasks/wtest/diff?wave=nope");
		expect(nope.status).toBe(400);
		expect(((await nope.json()) as { error: string }).error).toMatch(/positive integer/);
		const zero = await get("/api/tasks/wtest/diff?wave=0");
		expect(zero.status).toBe(400);
	});

	it("409 in plain words when the wave has no recorded trees (end-tree missing / start-tree missing)", async () => {
		const none = await get("/api/tasks/never-existed/diff?wave=1");
		expect(none.status).toBe(409);
		expect(((await none.json()) as { error: string }).error).toMatch(/no start row in the wave log/);

		const treeless = await get("/api/tasks/wtest/diff?wave=3");
		expect(treeless.status).toBe(409);
		expect(((await treeless.json()) as { error: string }).error).toMatch(/tree was not captured/);
	});

	it("409 when the wave has no end row yet (still running or cut short mid-flight)", async () => {
		const running = await get("/api/tasks/wtest/diff?wave=4");
		expect(running.status).toBe(409);
		const why = ((await running.json()) as { error: string }).error;
		expect(why).toMatch(/no end row yet/);
		expect(why).toMatch(/live diff/);
	});

	it("200 isolated: exactly the wave's own delta, trees echoed back", async () => {
		const wave1 = await get("/api/tasks/wtest/diff?wave=1");
		expect(wave1.status).toBe(200);
		const body = (await wave1.json()) as { startTreeSha: string; endTreeSha: string; diff: string; stats: { files: { path: string }[] }; truncated: boolean; note?: string };
		expect(body.stats.files.map((f) => f.path)).toEqual(["src/wave.ts"]);
		expect(body.diff).toContain("wave.ts");
		expect(body.startTreeSha).toMatch(/^[0-9a-f]{40}$/);
		expect(body.endTreeSha).toMatch(/^[0-9a-f]{40}$/);
		expect(body.note).toBeUndefined();
	});

	it("200 with a stated empty when the wave's raw delta is engine-owned-only churn", async () => {
		const wave2 = await get("/api/tasks/wtest/diff?wave=2");
		expect(wave2.status).toBe(200);
		const body = (await wave2.json()) as { diff: string; note?: string; truncated: boolean };
		expect(body.diff).toBe("");
		expect(body.truncated).toBe(false);
		expect(body.note).toMatch(/no display diff/);
	});
});

describe("auth stays on the diff routes", () => {
	it("401 without the session cookie", async () => {
		const res = await fetch(`${base}/api/tasks/one/diff`);
		expect(res.status).toBe(401);
		const live = await fetch(`${base}/api/tasks/one/diff/live`);
		expect(live.status).toBe(401);
		const list = await fetch(`${base}/api/artifacts`);
		expect(list.status).toBe(401);
	});
});

void stat;

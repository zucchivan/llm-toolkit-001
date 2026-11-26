/**
 * SSE job updates (§11.3 + M1): a `job` event frame carries the job list both
 * at subscribe (second client) and when a record changes (spawn/finish).
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/server.ts";
import { newToken } from "../server/auth.ts";
import { readJobRecord } from "../server/jobs.ts";
import { jobsDirectoryFingerprint, readoutFingerprint } from "../server/sse.ts";
import { bake, cleanup, postAction, actionHeaders, waitFor, spawnSleeper, type Baked } from "./actions-helper.ts";

/** Accumulate SSE bytes until `event: job` appears with parseable JSON. */
async function firstJobEvent(base: string, cookie: string, budgetMs = 8_000): Promise<{ jobs: { id: string }[]; attached?: unknown }> {
	const events = await fetch(`${base}/api/events`, { headers: { cookie } });
	expect(events.status).toBe(200);
	const reader = events.body!.getReader();
	const decoder = new TextDecoder();
	let acc = "";
	try {
		const deadline = Date.now() + budgetMs;
		while (Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) break;
			acc += decoder.decode(value, { stream: true });
			const marker = acc.lastIndexOf("event: job\ndata: ");
			if (marker >= 0) {
				const frame = acc.slice(marker + "event: job\ndata: ".length).split("\n")[0]!;
				return JSON.parse(frame);
			}
		}
		throw new Error(`no job event within ${budgetMs}ms`);
	} finally {
		await reader.cancel().catch(() => {});
	}
}

describe("sse job events", () => {
	let baked: Baked;
	const dists: string[] = [];
	afterAll(async () => {
		if (baked) await cleanup(baked);
	});

	it("subscribe receives the current job list; a spawned job is announced", async () => {
		baked = await bake({ skipJobSweep: false });
		const first = await firstJobEvent(baked.base, baked.cookie); // immediate snapshot on connect
		expect(first.jobs).toEqual([]);

		const accept = await postAction(baked.base, baked.cookie, { kind: "plan" }, actionHeaders(baked.csrf));
		expect(accept.status).toBe(202);
		const { jobId } = (await accept.json()) as { jobId: string };

			// one of the pulse/exit broadcasts carries the record (running then exited)
		const payload = await firstJobEvent(baked.base, baked.cookie);
		expect(payload.jobs.map((j) => j.id)).toContain(jobId);

		const final = await waitFor(() => readJobRecord(baked.root, jobId), (j) => j !== undefined && j.status === "exited", 8_000);
		expect(final!.status).toBe("exited");
		expect(final!.exitCode).toBe(0);
	});

	// M3 hardening (found in demo acceptance, cut 7 aftermath): the attached
	// terminal-started run leaves no record in .orch/ui/jobs — its attach and
	// exit must still emit a `job` event, or a client keeps a stale attached
	// badge until reload.
	it("the attached terminal run is announced when it appears and when it exits", async () => {
		baked = await bake({ skipJobSweep: false });

		// a foreign live run: a real sleeper pid owning .orch/lock, no job record
		const sleeper = spawnSleeper(9);
		try {
			const statusPath = join(baked.root, ".orch", "status.json");
			try {
				await readFile(statusPath, "utf8");
			} catch {
				await writeFile(statusPath, JSON.stringify({ kit: "0", piDurable: "1.5.0", root: baked.root, phase: "idle" }), "utf8");
			}
			const before = JSON.parse(await readFile(statusPath, "utf8")) as { phase?: string };
			await writeFile(statusPath, JSON.stringify({ ...before, lockedByPid: sleeper.pid, phase: "wave-running", task: { id: "t1", wave: 1, status: "running" }, ts: Date.now() }), "utf8");

			const appear = await firstJobEvent(baked.base, baked.cookie, 8_000);
			expect(appear?.attached).toBeTruthy();

				// exit: the sleeper dies — the next fingerprint change announces none
		} finally {
			sleeper.child.kill("SIGKILL");
		}
		// after the exit the payload's attached must clear (poll events one by one:
		// each firstJobEvent call opens a fresh stream and returns the first frame)
		await waitFor(
			async () => {
				const payload = await firstJobEvent(baked.base, baked.cookie, 6_000).catch(() => undefined);
				return payload?.attached === undefined ? payload : undefined;
			},
			(p) => p !== undefined,
			12_000,
		);
	});
});

describe("M1-P01 step (g): SSE fingerprints use the pinned no-follow boundary", () => {
	it("snapshot inputs are fingerprinted from fstat on the pinned entries (absent = '-')", async () => {
		const root = await mkdtemp(join(tmpdir(), "ui-sse-fp-"));
		try {
			// fresh project: no .orch at all = the defined "none" state
			expect(await readoutFingerprint(root)).toBe("none");

			await mkdir(join(root, ".orch", "artifacts"), { recursive: true });
			await writeFile(join(root, ".orch", "status.json"), "{}", "utf8");
			await writeFile(join(root, ".orch", "wave-log.jsonl"), "", "utf8");
			const token = await readoutFingerprint(root);
			// three parts: two files (mtime:size) and the artifacts directory (mtime:size)
			expect(token.split("|")).toHaveLength(3);
			expect(token.split("|")[0]).toMatch(/^\d+(\.\d+)?:2$/);
			expect(token.split("|")[2]).toMatch(/^\d+(\.\d+)?:\d+$/);

			// an absent file within an existing .orch stays a distinct token
			await rm(join(root, ".orch", "wave-log.jsonl"));
			expect((await readoutFingerprint(root)).split("|")[1]).toBe("-");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("a symlinked status/wave-log/artifacts or jobs record is a refusal token, never the link target's metadata", async () => {
		const outside = await mkdtemp(join(tmpdir(), "ui-sse-fp-outside-"));
		const root = await mkdtemp(join(tmpdir(), "ui-sse-fp-"));
		try {
			await writeFile(join(outside, "status.json"), "{".repeat(100), "utf8");
			await mkdir(join(root, ".orch"), { recursive: true });
			await symlink(join(outside, "status.json"), join(root, ".orch", "status.json"));

			const token = await readoutFingerprint(root);
			expect(token.split("|")[0]).toBe("refused:symlink");
			// No outside size/mtime ever reaches the fingerprint (only the refusal code).
			expect(token).not.toMatch(/:\d/);

			// A symlinked .orch ancestor refuses the whole snapshot fingerprint.
			const linkedRoot = await mkdtemp(join(tmpdir(), "ui-sse-fp-"));
			try {
				await symlink(outside, join(linkedRoot, ".orch"));
				expect(await readoutFingerprint(linkedRoot)).toBe("refused:symlink");
			} finally {
				await rm(linkedRoot, { recursive: true, force: true });
			}

			// Jobs dir: an absent dir is "none"; a symlinked record is a refusal token.
			expect(await jobsDirectoryFingerprint(root)).toEqual(["none"]);
			await mkdir(join(root, ".orch", "ui", "jobs"), { recursive: true });
			await writeFile(join(root, ".orch", "ui", "jobs", "job-1.json"), "{}", "utf8");
			await symlink(join(outside, "status.json"), join(root, ".orch", "ui", "jobs", "job-2.json"));
			const jobs = await jobsDirectoryFingerprint(root);
			expect(jobs.some((part) => part.startsWith("job-1.json:"))).toBe(true);
			expect(jobs).toContain("job-2.json:refused:symlink");
			expect(JSON.stringify(jobs)).not.toMatch(/status\.json/);
		} finally {
			await rm(outside, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("M1-P01 step (g): a hostile .orch read is refused on the SSE snapshot frame", () => {
	it("a symlinked wave-log makes the connect frame `null` — no partial snapshot, no outside rows", async () => {
		const baked = await bake({ skipJobSweep: true });
		const outside = await mkdtemp(join(tmpdir(), "ui-sse-outside-"));
		try {
			const secretRow = { ts: 1, kind: "wave", task: "LEAKED-TASK", wave: 1, verb: "start", treeSha: "a".repeat(40) };
			await writeFile(join(outside, "wave-log.jsonl"), `${JSON.stringify(secretRow)}\n`, "utf8");
			const log = join(baked.root, ".orch", "wave-log.jsonl");
			await rm(log, { force: true });
			await symlink(join(outside, "wave-log.jsonl"), log);

			const events = await fetch(`${baked.base}/api/events`, { headers: { cookie: baked.cookie } });
			expect(events.status).toBe(200);
			const reader = events.body!.getReader();
			const decoder = new TextDecoder();
			let acc = "";
			const deadline = Date.now() + 8_000;
			try {
				while (Date.now() < deadline) {
					const { value, done } = await reader.read();
					if (done) break;
					acc += decoder.decode(value, { stream: true });
					if (acc.includes("event: readout")) break;
				}
			} finally {
				await reader.cancel().catch(() => {});
			}
			const frame = acc.split("event: readout\ndata: ").pop()!.split("\n")[0]!;
			expect(frame).toBe("null");
			expect(acc).not.toContain("LEAKED-TASK");
		} finally {
			await rm(join(baked.root, ".orch", "wave-log.jsonl"), { force: true });
			await rm(outside, { recursive: true, force: true });
			await cleanup(baked);
		}
	}, 30_000);
});

describe("M1-P01 step (g): a hostile status.json refuses the snapshot, never its extras", () => {
	it("reports the typed refusal instead of the link target's sleep/prdPath fields", async () => {
		const baked = await bake({ skipJobSweep: true });
		const outside = await mkdtemp(join(tmpdir(), "ui-sse-status-outside-"));
		try {
			await writeFile(
				join(outside, "status.json"),
				JSON.stringify({ phase: "idle", sleepUntil: 1, prdPath: "OUTSIDE/host-prd.md", tasks: [] }),
				"utf8",
			);
			const statusPath = join(baked.root, ".orch", "status.json");
			await rm(statusPath, { force: true });
			await symlink(join(outside, "status.json"), statusPath);

			const res = await fetch(`${baked.base}/api/readout`, { headers: { cookie: baked.cookie } });
			expect(res.status).toBe(500);
			const raw = await res.text();
			expect(raw).toContain("symbolic link");
			expect(raw).not.toContain("OUTSIDE/host-prd.md");
			expect(raw).not.toContain("sleepUntil");
		} finally {
			await rm(join(baked.root, ".orch", "status.json"), { force: true });
			await rm(outside, { recursive: true, force: true });
			await cleanup(baked);
		}
	}, 30_000);
});

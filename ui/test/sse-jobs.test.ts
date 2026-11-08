/**
 * SSE job updates (§11.3 + M1): a `job` event frame carries the job list both
 * at subscribe (second client) and when a record changes (spawn/finish).
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/server.ts";
import { newToken } from "../server/auth.ts";
import { readJobRecord } from "../server/jobs.ts";
import { bake, postAction, actionHeaders, waitFor, spawnSleeper, type Baked } from "./actions-helper.ts";

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
		await baked?.running.shutdown().catch(() => {});
		await rm(baked?.root, { recursive: true, force: true }).catch(() => {});
	});

	it("subscribe receives the current job list; a spawned job is announced", async () => {
		baked = await bake({ skipJobSweep: false });
		process.env["KIT_UI_CLI_BIN"] = baked.stubCli;
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

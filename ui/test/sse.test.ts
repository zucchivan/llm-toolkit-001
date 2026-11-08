/** SSE behavior (§11.3): full snapshot on connect, heartbeats, cookie required. */
import { describe, expect, it } from "vitest";
import { startServer } from "../server/server.ts";
import { newToken } from "../server/auth.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bakeConfiguredDemo } from "./helpers.ts";

/** Accumulate one SSE response until a predicate holds (single reader). */
async function readSseUntil(body: ReadableStream<Uint8Array>, predicate: (acc: string) => boolean, timeoutMs = 8_000): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let acc = "";
	try {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) break;
			acc += decoder.decode(value, { stream: true });
			if (predicate(acc)) return acc;
		}
		throw new Error(`sse never matched: ${acc.slice(0, 400)}`);
	} finally {
		await reader.cancel().catch(() => {});
	}
}

describe("sse", () => {
	it("cookie required; connect sends one full readout frame + heartbeat comments", async () => {
		const root = await bakeConfiguredDemo();
		const token = newToken();
		const dist = await mkdtemp(join(tmpdir(), "ui-sse-dist-"));
		const running = await startServer({ root, token, port: 0, distDir: dist, heartbeatMs: 250 });
		try {
			const base = `http://127.0.0.1:${running.port}`;

			const denied = await fetch(`${base}/api/events`);
			expect(denied.status).toBe(401);

			const events = await fetch(`${base}/api/events`, { headers: { cookie: `kit_ui=${token}` } });
			expect(events.status).toBe(200);
			expect(events.headers.get("content-type")).toContain("text/event-stream");

			// ONE read until both the snapshot frame and a heartbeat comment arrived.
			const acc = await readSseUntil(events.body!, (a) => a.includes("event: readout") && a.includes(": heartbeat"));
			const frame = acc.split("event: readout\ndata: ").pop()!.split("\n")[0]!;
			const snap = JSON.parse(frame) as { readout: { seam: number }; mode: string; at: number };
			expect(snap.readout.seam).toBe(1);
			expect(snap.mode === "storage" || snap.mode === "sidecars").toBe(true);
			expect(snap.at).toBeGreaterThan(0);
		} finally {
			await running.shutdown();
		}
	});
});

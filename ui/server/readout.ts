/**
 * Readout acquisition (ui/PRD.md §11.1): per request; never hold the lock.
 * Storage mode = we briefly acquire `.orch/lock`, open the inspector readout
 * in-process, release. LockBusy → retry briefly (covers the hand-off moment
 * around a run's start/exit) then degrade to the atomic side-cars.
 *
 * The snapshot is augmented with two UI-only fields read straight from
 * `.orch/status.json` (never storage, single-owner rule intact):
 *   - `sleep` — the governor's armed rate-limit sleep (§8.5 sleeping banner +
 *     countdown); A.1 already flushes these, M0 shipped the flush.
 *   - `prdPath` — the configured PRD path (§8.2 plan dialog prefill).
 */
import { openProjectHarness, projectPaths } from "../../src/engine/harness.ts";
import type { StatusPayloads } from "../../src/engine/harness.ts";
import { readout } from "../../src/engine/inspector.ts";
import type { KitReadout } from "../../src/engine/inspector.ts";
import { LockBusyError } from "../../src/util/lockfile.ts";
import { dirname, join } from "node:path";
import { readJson } from "../../src/util/fsx.ts";
import { loadConfig } from "../../src/config.ts";

export interface ReadoutSnapshot {
	readout: KitReadout;
	/** `storage`: we held the lock while building it; `sidecars`: degraded. */
	mode: "storage" | "sidecars";
	at: number;
	/** Armed rate-limit sleep from the last status.json flush when present. */
	sleep?: { until: number; cycleCount?: number; alert?: string };
	/** PRD path for the Plan prefill (status.json last knows it). */
	prdPath?: string;
}

const LOCK_RETRIES = 2;
const LOCK_RETRY_DELAY_MS = 120;

export async function readOnce(projectRoot: string): Promise<ReadoutSnapshot> {
	const paths = projectPaths(projectRoot);
	for (let attempt = 0; ; attempt++) {
		let loop: Awaited<ReturnType<typeof openProjectHarness>>;
		try {
			// readView: visibility never sends model requests; unknown role
			// providers wired leniently instead of erroring (same as `inspect`).
			loop = await openProjectHarness(projectRoot, "ui", { readView: true });
		} catch (err) {
			if (err instanceof LockBusyError) {
				if (attempt < LOCK_RETRIES) {
					await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
					continue;
				}
				// A live run owns the lock: side-cars are the truth (and the answer).
				return { readout: await readout(paths), mode: "sidecars", at: Date.now(), ...await statusExtras(projectRoot) };
			}
			// Anything else (invalid config, transient storage failure): degrade
			// rather than 500-ing a long-lived server; side-cars still parse.
			console.error(`[llm-toolkit-ui] storage read failed${projectRoot !== process.cwd() ? ` in ${projectRoot}` : ""}: ${(err as Error).message} — degrading to side-cars`);
			return { readout: await readout(paths), mode: "sidecars", at: Date.now(), ...await statusExtras(projectRoot) };
		}
		try {
			const read = await readout(loop.loop.paths, { loop });
			return { readout: read, mode: "storage", at: Date.now(), ...await statusExtras(projectRoot) };
		} finally {
			// release immediately — the lock is never held between requests
			await loop.loop.close().catch(() => {});
			loop.lock.release();
		}
	}
}

async function statusExtras(projectRoot: string): Promise<Pick<ReadoutSnapshot, "sleep" | "prdPath">> {
	const statusPath = join(projectRoot, ".orch", "status.json");
	const payload = await readJson<StatusPayloads>(statusPath).catch(() => undefined);
	const sleep =
		payload?.sleepUntil !== undefined
			? { until: payload.sleepUntil, cycleCount: payload.sleepCycleCount, alert: payload.alert }
			: undefined;
	// §8.2 prefill: the config's [paths].prd is the fallback before any flush knows a prdPath.
	const prdPath = payload?.prdPath ?? readConfigPrdPathSilent(join(projectRoot, ".orch", "config.toml"));
	return { sleep, prdPath };
}

function readConfigPrdPathSilent(configPath: string): string | undefined {
	try {
		const config = loadConfig(dirname(configPath), configPath);
		const prd = (config as { paths?: { prd?: string } }).paths?.prd;
		return typeof prd === "string" && prd.trim() ? prd : undefined;
	} catch {
		return undefined; // no config or parse issue: no prefill (the plan CLI reports it)
	}
}

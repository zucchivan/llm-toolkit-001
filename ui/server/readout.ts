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
import { loadConfig, ROLES } from "../../src/config.ts";

/** One configured role, as the plan/run dialogs render it (§7.2 friendliness). */
export interface RoleModelInfo {
	name: (typeof ROLES)[number];
	provider: string;
	modelId: string;
}

export interface ReadoutSnapshot {
	readout: KitReadout;
	/** `storage`: we held the lock while building it; `sidecars`: degraded. */
	mode: "storage" | "sidecars";
	at: number;
	/** Armed rate-limit sleep from the last status.json flush when present. */
	sleep?: { until: number; cycleCount?: number; alert?: string };
	/** PRD path for the Plan prefill (status.json last knows it). */
	prdPath?: string;
	/** The configured role models straight from .orch/config.toml; undefined when the config itself is unreadable (see configError). */
	roles?: RoleModelInfo[];
	/** The config failed to load mid-session (bad TOML edit): the reason, the UI's words, so dialogs can be kind about it. */
	configError?: string;
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

async function statusExtras(projectRoot: string): Promise<Pick<ReadoutSnapshot, "sleep" | "prdPath" | "roles" | "configError">> {
	const statusPath = join(projectRoot, ".orch", "status.json");
	const payload = await readJson<StatusPayloads>(statusPath).catch(() => undefined);
	const sleep =
		payload?.sleepUntil !== undefined
			? { until: payload.sleepUntil, cycleCount: payload.sleepCycleCount, alert: payload.alert }
			: undefined;
	// One config load per snapshot covers every config-derived extra: the plan
	// prefill (§8.2), the visible role models (§7.2 — "is a model even set?"),
	// and a mid-session config break rendered in kind words. Read-only; the UI
	// never writes the config (the CLI is the only mutation path).
	try {
		const config = loadConfig(projectRoot);
		const prdPath = payload?.prdPath ?? config.paths.prd;
		const roles = ROLES.map((name) => ({ name, provider: config.roles[name].provider, modelId: config.roles[name].modelId }));
		return { sleep, prdPath, roles };
	} catch (err) {
		return { sleep, prdPath: payload?.prdPath, configError: (err as Error).message };
	}
}

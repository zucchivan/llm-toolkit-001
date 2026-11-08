/**
 * Snapshot hub (ui/PRD.md §11.3): watches `.orch/status.json`,
 * `.orch/wave-log.jsonl` and `.orch/artifacts/` (fs.watch + 1s fallback poll),
 * debounces, and broadcasts one full readout snapshot per change — while a run
 * is live, at least one snapshot every 2s so elapsed time stays fresh even
 * when the side-car is quiet. Storage-mode readouts are throttled to ≥1s
 * between scans. The hub runs only while at least one SSE client subscribes.
 *
 * M1 adds `job` events: the `.orch/ui/jobs/` directory is fingerprinted too;
 * a record spawn/exit/stop change broadcasts `{ at, jobs, attached? }`. The
 * attached terminal-started run is in the fingerprint as well (it leaves no
 * record), so its attach/exit also emits one event.
 */
import type { FSWatcher } from "node:fs";
import { watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readOnce, type ReadoutSnapshot } from "./readout.ts";
import { attachedRun, jobsDir, jobsList, jobsViewList, runningJobPids, type AttachedRun } from "./jobs.ts";
import type { JobRecord, JobView } from "./jobs.ts";
import { attachedStopView } from "./attached-stop.ts";

export interface HubOptions {
	pollMs?: number;
	/** Gap between automatic live refreshes of the snapshot (running reads only). */
	liveRefreshMs?: number;
	/** Minimum gap between any two full readout builds. */
	minScanGapMs?: number;
	/** Watch `.orch/ui/jobs` too (default true; tests may mute it). */
	watchJobs?: boolean;
}

/** Payload of a `job` SSE event: the full job list + the attached run if any. Records carry a bounded reason tail on diagnostic outcomes (failed/stale/42) so toasts can cite it. */
export interface JobsEventPayload {
	at: number;
	jobs: JobView[];
	attached?: AttachedRun;
}

export async function currentJobsEvent(projectRoot: string): Promise<JobsEventPayload> {
	const jobs = await jobsViewList(projectRoot);
	const attached = await attachedRun(projectRoot, jobs);
	if (attached) {
		// §7.2.1: the attached run's stop affordance, verified read-only per
		// payload (a failed check never signals; the POST re-verifies anyway).
		attached.stop = await attachedStopView(projectRoot, attached.pid, runningJobPids(jobs));
	}
	return { at: Date.now(), jobs, attached };
}

export interface SnapshotHub {
	subscribe(write: (chunk: string) => void): () => void;
	stop(): void;
	/** Force one `job` event now — after THIS server spawns/stops a job itself. */
	pulseJobs(): void;
}

interface Sub {
	write: (chunk: string) => void;
	alive: boolean;
}

const DEBOUNCE_MS = 150;

export function startSnapshotHub(projectRoot: string, options: HubOptions = {}): SnapshotHub {
	const pollMs = options.pollMs ?? 1_000;
	const liveRefreshMs = options.liveRefreshMs ?? 2_000;
	const minScanGapMs = options.minScanGapMs ?? 1_000;
	const watchJobs = options.watchJobs ?? true;

	const subs = new Set<Sub>();
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let watcher: FSWatcher | undefined;
	let inFlight = false;
	let dirty = false;
	let lastScanMs = 0;
	let lastSentMs = 0;
	let lastFingerprint = "";
	let lastJobsFingerprint = "";
	let running = false; // last snapshot reported a live wave
	let stopped = false;

	function broadcast(snapshot: ReadoutSnapshot): void {
		const chunk = `event: readout\ndata: ${JSON.stringify(snapshot)}\n\n`;
		submit(chunk);
	}

	function submit(chunk: string): void {
		for (const sub of subs) {
			try {
				if (!sub.alive) continue;
				sub.write(chunk);
			} catch {
				sub.alive = false;
				subs.delete(sub);
			}
		}
	}

	async function fingerprint(): Promise<string> {
		const parts = await Promise.all([
			statFingerprint(join(projectRoot, ".orch", "status.json")),
			statFingerprint(join(projectRoot, ".orch", "wave-log.jsonl")),
			statFingerprint(join(projectRoot, ".orch", "artifacts")),
		]);
		return parts.join("|");
	}

	async function jobsFingerprint(): Promise<string> {
		let names: string[] = [];
		try {
			names = await readdir(jobsDir(projectRoot));
		} catch {
			return "none";
		}
		const parts = await Promise.all(
			names.sort().map(async (name) => {
				const s = await stat(join(jobsDir(projectRoot), name)).catch(() => undefined);
				return `${name}:${s ? `${s.mtimeMs}:${s.size}` : "-"}`;
			}),
		);
		// The attached terminal-started run carries NO job record — without its
		// identity in the fingerprint an attached run appearing or exiting (each
		// leaves the last status.json flush in place) would never emit a `job`
		// event and a connected client would keep a stale attached badge until
		// reload. Mirror currentJobsEvent's exact computation so the fingerprint
		// can only change when the payload does.
		const jobs = await jobsList(projectRoot).catch(() => []);
		const attached = await attachedRun(projectRoot, jobs);
		return `${parts.join("|")}|${attached ? `attached:${attached.pid}:${attached.phase}:${attached.task ?? "-"}` : "none"}`;
	}

	/** Diff the jobs dir; a change emits one `job` event with the fresh list. */
	async function broadcastJobsIfChanged(force = false): Promise<void> {
		if (!watchJobs || stopped) return;
		const fp = await jobsFingerprint();
		if (!force && fp === lastJobsFingerprint) return;
		lastJobsFingerprint = fp;
		try {
			const payload = await currentJobsEvent(projectRoot);
			submit(`event: job\ndata: ${JSON.stringify(payload)}\n\n`);
		} catch (err) {
			console.error(`[llm-toolkit-ui] job event build failed: ${(err as Error).message}`);
		}
	}

	async function scan(): Promise<void> {
		if (inFlight || stopped) return;
		if (Date.now() - lastScanMs < minScanGapMs) {
			dirty = true; // too soon; the 1s poll retries
			return;
		}
		inFlight = true;
		try {
			const snapshot = await readOnce(projectRoot);
			running = snapshot.readout.live !== undefined;
			broadcast(snapshot);
			lastSentMs = Date.now();
			if (watchJobs) await broadcastJobsIfChanged(); // a start/stop also lands in job records
		} catch (err) {
			console.error(`[llm-toolkit-ui] snapshot build failed: ${(err as Error).message}`);
		} finally {
			inFlight = false;
			dirty = false;
			lastScanMs = Date.now();
			lastFingerprint = await fingerprint();
		}
	}

	const scheduleScan = (): void => {
		void scan();
	};

	function tick(): void {
		if (inFlight || stopped) return;
		void (async () => {
			const fp = await fingerprint();
			if (fp !== lastFingerprint) dirty = true;
			const due =
				(dirty && Date.now() - lastScanMs >= minScanGapMs) ||
				(running && Date.now() - lastSentMs >= liveRefreshMs);
			if (due) await scan();
			else if (watchJobs) await broadcastJobsIfChanged();
		})().catch(() => {});
	}

	/** Force one `job` event now — after THIS server spawns/stops a job itself. */
	function pulseJobs(): void {
		void broadcastJobsIfChanged(true);
	}

	function stop(): void {
		stopped = true;
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		watcher?.close();
		watcher = undefined;
		subs.clear();
	}

	function watchFs(): void {
		const dir = join(projectRoot, ".orch");
		try {
			// Only the four inputs a snapshot can change matter; ignoring everything
			// else (`.orch/lock` in particular, which each of our own reads creates
			// and releases) stops the watcher from feeding itself into new scans.
			watcher = watch(dir, { persistent: false, recursive: false }, (_event, filename) => {
				if (filename === "status.json" || filename === "wave-log.jsonl" || filename === "artifacts") {
					dirty = true;
					setTimeout(scheduleScan, DEBOUNCE_MS);
					return;
				}
				if (filename === "ui") void broadcastJobsIfChanged(); // .orch/ui/jobs churn
			});
			watcher.on("error", () => {
				/* filesystem without events: the poll covers it */
			});
		} catch {
			watcher = undefined; // fs.watch unavailable here; the 1s poll is the fallback
		}
	}

	return {
		subscribe(write): () => void {
			const sub: Sub = { write, alive: true };
			subs.add(sub);
			if (subs.size === 1) {
				// First (or reconnected) client: (re-)arm the hub — stop() only ran
				// after every subscriber left, so this may follow one.
				stopped = false;
				lastFingerprint = "";
				lastJobsFingerprint = "";
				void scan(); // an immediate full snapshot (scan also emits `job` on change)
				watchFs();
				if (pollTimer === undefined) {
					pollTimer = setInterval(tick, pollMs);
					pollTimer.unref?.();
				}
			} else {
				const jobsNow = currentJobsEvent(projectRoot);
				void jobsNow.then((payload) => {
					try {
						write(`event: job\ndata: ${JSON.stringify(payload)}\n\n`);
					} catch {
						sub.alive = false;
					}
				});
			}
			return () => {
				sub.alive = false;
				subs.delete(sub);
				if (subs.size === 0) stop();
			};
		},
		pulseJobs,
		stop,
	};
}

function statFingerprint(path: string): Promise<string> {
	return stat(path)
		.then((s) => `${s.mtimeMs}:${s.size}`)
		.catch(() => "-");
}

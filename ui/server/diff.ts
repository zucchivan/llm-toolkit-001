/**
 * Task diff serving (ui/PRD.md §11.2 + §11.4 + Appendix A.2/A.3):
 *   GET /api/tasks/:id/diff        persisted patch (+stats side-car) for the
 *                                  current plan revision; 404 if none; legacy
 *                                  pre-revision artifacts labeled historical
 *   GET /api/tasks/:id/diff/live   the in-flight task's LATEST FROZEN
 *                                  CHECKPOINT, tree-to-tree; 409 when the task
 *                                  is not in flight OR before its first
 *                                  checkpoint (stated reason)
 *   GET /api/artifacts[:name]      artifact list / text; names validated,
 *                                  5 MiB text cap, larger → metadata + download
 *
 * The git work is the engine's own display seam (src/util/git.ts
 * diffDisplayTrees): same exclusions (.orch/**, router.md, PROMPT.md), same
 * 5 MiB cap. Live diffs read a frozen checkpoint's immutable trees — never
 * the operator checkout — and are NEVER persisted; the lock is never taken —
 * all reads here are side-car/artifact filesystem reads plus pure tree-to-tree
 * git plumbing, so the lock contract of §11.1 stays intact.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve as resolvePath, sep } from "node:path";
import { readJson } from "../../src/util/fsx.ts";
import { diffDisplayTrees, DISPLAY_PATCH_CAP_BYTES } from "../../src/util/git.ts";
import type { DiffStats, DisplayDiffStats } from "../../src/util/git.ts";
import type { StatusPayloads } from "../../src/engine/harness.ts";
import type { WaveRow } from "../../src/engine/infos.ts";

/** §11.4: artifact (and task-id) names stay inside this class; anything with
 *  separators or outside it is `400` (path traversal → 400, never a peek). */
const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function validateName(name: string): boolean {
	return NAME_RE.test(name) && !name.includes("..");
}

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type Validation = { ok: true } | { ok: false; status: 400; error: string };

export function validateTaskId(taskId: string): Validation {
	if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId) || taskId.includes("..")) {
		return { ok: false, status: 400, error: `bad task id ${JSON.stringify(taskId)} — expected [A-Za-z0-9._-] (no traversal)` };
	}
	return { ok: true };
}

/**
 * Where a task's persisted diff lives. P15: the CURRENT plan revision's
 * newest revision-qualified candidate artifact
 * (`candidate-<revision>-<task>-w<N>.patch`, mirroring the core readout's
 * selection) is the only "current" patch — a legacy `task-*.patch` /
 * `quarantined-*` artifact is served ONLY when no plan revision is known at
 * all (pre-P14 project), labeled `historical` (no receipt backing it), and is
 * never selected for a new revision that reuses a task id.
 */
export interface PatchLocation {
	task: string;
	patch: string;
	patchPath: string;
	stats?: string;
	statsPath?: string;
	/** legacy artifact from a pre-revision kit run — display only, no receipt. */
	historical?: boolean;
}

/** The current plan revision from the status side-car (undefined when unknown). */
async function currentPlanRevision(root: string): Promise<string | undefined> {
	const payload = await readJson<StatusPayloads>(join(root, ".orch", "status.json")).catch(() => undefined);
	return typeof payload?.planRevision === "string" ? payload.planRevision : undefined;
}

export async function locateTaskDiff(root: string, taskId: string): Promise<PatchLocation | undefined> {
	const revision = await currentPlanRevision(root);
	if (revision) {
		// Revision-qualified selection — the same rule the core readout applies.
		// A revision exists but no candidate artifact for this task → 404: a
		// legacy same-named artifact must never present as current.
		const prefix = `candidate-${revision}-${taskId}-w`;
		let bestWave = 0;
		let bestName: string | undefined;
		try {
			for (const name of await readdir(join(root, ".orch", "artifacts"))) {
				if (!name.startsWith(prefix) || !name.endsWith(".patch")) continue;
				const wave = Number(/-w(\d+)\.patch$/.exec(name)?.[1]);
				if (Number.isSafeInteger(wave) && wave > bestWave) {
					bestWave = wave;
					bestName = name;
				}
			}
		} catch {
			/* no artifacts dir → no diff */
		}
		return bestName ? located(root, taskId, bestName, false) : undefined;
	}
	// No known revision (pre-P14 project): legacy names, labeled historical.
	const candidates = [`task-${taskId}.patch`];
	try {
		const names = await readdir(join(root, ".orch", "artifacts"));
		let bestWave = 0;
		for (const name of names) {
			if (!name.startsWith(`quarantined-${taskId}-w`) || !name.endsWith(".patch")) continue;
			const wave = Number(/-w(\d+)\.patch$/.exec(name)?.[1]);
			if (Number.isInteger(wave) && wave > bestWave) bestWave = wave;
		}
		if (bestWave > 0) candidates.push(`quarantined-${taskId}-w${bestWave}.patch`);
	} catch {
		/* no artifacts dir → no diff */
	}
	for (const patch of candidates) {
		const locatedPatch = located(root, taskId, patch, true);
		if (locatedPatch) return locatedPatch;
	}
	return undefined;
}

/** Validate + stat one constructed artifact name (§11.4 even for our own names). */
async function located(root: string, taskId: string, patch: string, historical: boolean): Promise<PatchLocation | undefined> {
	const patchPath = join(root, ".orch", "artifacts", patch);
	if (!validateName(patch) || livesOutsideArtifacts(root, patchPath)) return undefined;
	const meta = await stat(patchPath).catch(() => undefined);
	if (!meta?.isFile()) return undefined;
	const statsName = patch.replace(/\.patch$/, ".json");
	const statsPath = join(root, ".orch", "artifacts", statsName);
	const statsMeta = validateName(statsName) ? await stat(statsPath).catch(() => undefined) : undefined;
	return {
		task: taskId,
		patch,
		patchPath,
		...(historical ? { historical: true } : {}),
		...(statsMeta?.isFile() ? { stats: statsName, statsPath } : {}),
	};
}

function livesOutsideArtifacts(root: string, resolved: string): boolean {
	const base = resolvePath(join(root, ".orch", "artifacts"));
	return resolved !== base && !resolved.startsWith(base + sep);
}

export interface TaskDiffPayload {
	at: number;
	task: string;
	/** patch artifact NAME */
	patch: string;
	/** stats side-car artifact NAME when present */
	stats: string | null;
	/** patch bytes on disk */
	bytes: number;
	/** true when the stats side-car recorded the 5 MiB cap hit */
	truncated: boolean;
	/** patch TEXT (≤ 5 MiB: artifacts are capped when written) */
	diff: string;
	/** parsed stats side-car when present */
	statsJson?: DisplayDiffStats;
	baselineTreeSha?: string;
	/** P15: a legacy pre-revision artifact — display only, no receipt backs it. */
	historical?: boolean;
}

export type Api<T> = { ok: true; payload: T } | { ok: false; status: number; error: string; detail?: Record<string, unknown> };

/** GET /api/tasks/:id/diff body (patch text + parsed stats; 404 when absent). */
export async function readTaskDiff(root: string, taskId: string): Promise<Api<TaskDiffPayload>> {
	const id = validateTaskId(taskId);
	if (!id.ok) return id;
	const located = await locateTaskDiff(root, taskId);
	if (!located) {
		return { ok: false, status: 404, error: `no diff artifacts for task ${taskId} yet (only done/quarantined tasks persist a patch)` };
	}
	// Artifacts are written capped, but any hand-seeded file stays within §11.4.
	const raw = await readFile(located.patchPath, "utf8").catch(() => undefined);
	if (raw === undefined) return { ok: false, status: 404, error: `patch artifact ${located.patch} is unreadable` };
	const truncatedOnDisk = Buffer.byteLength(raw, "utf8") > DISPLAY_PATCH_CAP_BYTES;
	const text = truncatedOnDisk ? Buffer.from(raw, "utf8").subarray(0, DISPLAY_PATCH_CAP_BYTES).toString("utf8") : raw;
	const payload: TaskDiffPayload = {
		at: Date.now(),
		task: taskId,
		patch: located.patch,
		stats: located.stats ?? null,
		bytes: (await stat(located.patchPath).catch(() => ({ size: 0 }))).size,
		truncated: false,
		diff: text,
		...(located.historical ? { historical: true } : {}),
	};
	if (located.statsPath) {
		const stats = await readJson<DisplayDiffStats>(located.statsPath).catch(() => undefined);
		if (stats) {
			payload.statsJson = stats;
			payload.truncated = stats.truncated === true || truncatedOnDisk;
			payload.baselineTreeSha = stats.baselineTreeSha;
		}
	} else {
		payload.truncated = truncatedOnDisk;
	}
	return { ok: true, payload };
}

export interface LiveDiffPayload {
	at: number;
	task: string;
	/** the frozen checkpoint's wave (a previous wave's checkpoint can be the
	 *  latest frozen one while a retry wave is mid-flight — the label says). */
	wave: number;
	/** the checkpoint's base tree (start-of-wave tree). */
	baselineTreeSha: string;
	/** P15: the checkpoint's freeze timestamp — the drawer's "frozen at" label. */
	frozenAt: number;
	/** response diff bytes (≤ 5 MiB cap) */
	bytes: number;
	truncated: boolean;
	/** patch TEXT between the frozen trees; "" + note when nothing displayable */
	diff: string;
	stats: DiffStats;
	note?: string;
}

/**
 * GET /api/tasks/:id/diff/live body (P15): the requested task's LATEST FROZEN
 * CHECKPOINT — a tree-to-tree display diff between the checkpoint's immutable
 * base tree and candidate tree. Reads ONLY .orch/status.json (side-car; the
 * run owns the lock) and runs pure git tree-to-tree plumbing: no working-copy
 * read, no staging, no temporary index, nothing persisted — later
 * operator-checkout edits are not task changes and cannot leak in. Before the
 * first frozen checkpoint the answer is 409 with the reason (never a
 * fabricated empty patch).
 */
export async function liveTaskDiff(root: string, taskId: string): Promise<Api<LiveDiffPayload>> {
	const id = validateTaskId(taskId);
	if (!id.ok) return id;
	const payload = await readJson<StatusPayloads>(join(root, ".orch", "status.json")).catch(() => undefined);
	if (!payload?.task || payload.phase !== "wave-running" || payload.task.id !== taskId) {
		return {
			ok: false,
			status: 409,
			error: `task ${taskId} is not the current in-flight task${payload?.task?.id ? ` (live: ${payload.task.id})` : " (no wave running)"}`,
			detail: { phase: payload?.phase ?? "unknown", currentTask: payload?.task?.id },
		};
	}
	const checkpoint = payload.checkpoint;
	if (!checkpoint) {
		return {
			ok: false,
			status: 409,
			error: `no frozen checkpoint yet for ${taskId} — the wave is before its first checkpoint (the candidate has not been frozen); there is nothing task-attributable to show`,
			detail: { phase: payload.phase, currentTask: payload.task.id, checkpoint: "none" },
		};
	}
	const computed = await diffDisplayTrees(root, checkpoint.baseTree, checkpoint.candidateTree);
	const base = {
		at: Date.now(),
		task: taskId,
		wave: checkpoint.wave,
		baselineTreeSha: checkpoint.baseTree,
		frozenAt: checkpoint.asOf,
		stats: computed.ok ? computed.stats : { files: [], totalInsertions: 0, totalDeletions: 0 },
	};
	if (!computed.ok) {
		return {
			ok: true,
			payload: {
				...base,
				bytes: 0,
				truncated: false,
				diff: "",
				note: computed.reason ?? "no display diff between the frozen checkpoint trees",
			},
		};
	}
	return {
		ok: true,
		payload: { ...base, bytes: computed.bytes, truncated: computed.truncated, diff: computed.text },
	};
}

// ---------------------------------------------------------------------------
// Per-wave isolated diffs (Appendix A.7)
// ---------------------------------------------------------------------------

export interface WaveDiffPayload {
	at: number;
	task: string;
	wave: number;
	/** the wave start row's treeSha */
	startTreeSha: string;
	/** the wave end row's treeSha */
	endTreeSha: string;
	/** response diff bytes (≤ 5 MiB cap) */
	bytes: number;
	truncated: boolean;
	/** patch TEXT between the wave's own trees; "" + note when nothing to show */
	diff: string;
	stats: DiffStats;
	note?: string;
}

/** `?wave=` validation: a positive integer, never a doc reference. */
export function validateWaveNumber(raw: unknown): { ok: true; wave: number } | { ok: false; status: 400; error: string } {
	if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) {
		return { ok: false, status: 400, error: `bad wave ${JSON.stringify(raw)} — expected a positive integer (e.g. ?wave=2), the wave number the task's wave count reports` };
	}
	return { ok: true as const, wave: Number(raw) };
}

/** The wave-log side-car, parsed tolerantly: a torn append skips its line and keeps the rest. */
async function readWaveRows(root: string): Promise<WaveRow[]> {
	const raw = await readFile(join(root, ".orch", "wave-log.jsonl"), "utf8").catch(() => undefined);
	if (raw === undefined) return [];
	const rows: WaveRow[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line) as WaveRow);
		} catch {
			/* torn append mid-flush: skip the line, keep the rest */
		}
	}
	return rows;
}

/**
 * GET /api/tasks/:id/diff?wave=N — A.7's per-wave isolated diff between the
 * wave's own recorded trees (start row's vs end row's). Reads ONLY the
 * wave-log side-car + git plumbing between two immutable shas — never
 * persisted, never a lock, never a rollback input. Rows without treeSha
 * (pre-seam log, failed capture) and end-row-less waves answer 409 in plain
 * words; the task's cumulative diff stands as-is.
 */
export async function waveTaskDiff(root: string, taskId: string, waveRaw: unknown): Promise<Api<WaveDiffPayload>> {
	const id = validateTaskId(taskId);
	if (!id.ok) return id;
	const wave = validateWaveNumber(waveRaw);
	if (!wave.ok) return wave;
	const rows = await readWaveRows(root);
	const startRow = rows.find((r) => r.kind === "wave" && r.task === taskId && r.wave === wave.wave && r.verb === "start");
	if (!startRow) {
		return {
			ok: false,
			status: 409,
			error: `wave ${wave.wave} of task ${taskId} has no start row in the wave log — the log predates seam A.7 or wave ${wave.wave} is not this task's; the task's diff stays cumulative since its baseline`,
		};
	}
	if (!startRow.treeSha) {
		return {
			ok: false,
			status: 409,
			error: `wave ${wave.wave} of task ${taskId} started but its tree was not captured (the capture failed) — that wave is not isolatable; the task's diff stays cumulative since its baseline`,
		};
	}
	const endRow = rows.find((r) => r.kind === "wave" && r.task === taskId && r.wave === wave.wave && r.verb === "end");
	if (!endRow) {
		return {
			ok: false,
			status: 409,
			error: `wave ${wave.wave} of task ${taskId} has no end row yet — the wave is still running or was cut short mid-flight; the in-flight view is the live diff (…/diff/live)`,
		};
	}
	if (!endRow.treeSha) {
		return {
			ok: false,
			status: 409,
			error: `wave ${wave.wave} of task ${taskId} ended but its end tree was not captured (the capture failed) — that wave is not isolatable; the task's diff stays cumulative since its baseline`,
		};
	}
	const computed = await diffDisplayTrees(root, startRow.treeSha, endRow.treeSha);
	const base = {
		at: Date.now(),
		task: taskId,
		wave: wave.wave,
		startTreeSha: startRow.treeSha,
		endTreeSha: endRow.treeSha,
		stats: computed.stats,
	};
	if (!computed.ok) {
		return {
			ok: true as const,
			payload: { ...base, bytes: 0, truncated: false, diff: "", note: computed.reason ?? "no isolated wave diff" },
		};
	}
	return {
		ok: true as const,
		payload: { ...base, bytes: computed.bytes, truncated: computed.truncated, diff: computed.text },
	};
}

// ---------------------------------------------------------------------------
// Artifact access (§11.4)
// ---------------------------------------------------------------------------

export interface ArtifactEntry {
	name: string;
	bytes: number;
	mtimeMs: number;
}

export async function artifactList(root: string): Promise<ArtifactEntry[]> {
	try {
		const names = await readdir(join(root, ".orch", "artifacts"));
		const entries = await Promise.all(
			names.map(async (name) => {
				const meta = await stat(join(root, ".orch", "artifacts", name)).catch(() => undefined);
				return meta?.isFile() ? { name, bytes: meta.size, mtimeMs: meta.mtimeMs } : undefined;
			}),
		);
		return entries.filter((e): e is ArtifactEntry => e !== undefined).sort((a, b) => b.mtimeMs - a.mtimeMs);
	} catch {
		return [];
	}
}

export type ArtifactRead =
	| { kind: "text"; name: string; text: string; bytes: number; truncated: boolean }
	| { kind: "metadata"; name: string; bytes: number; download: string }
	| { kind: "missing"; name: string }
	| { kind: "binary"; name: string; bytes: number };

/** validated fs path for one artifact name (§11.4 anchor + traversal guard). */
export function artifactPath(root: string, name: string): string | undefined {
	if (!validateName(name)) return undefined;
	const resolved = resolvePath(join(root, ".orch", "artifacts", name));
	if (resolved !== resolvePath(join(root, ".orch", "artifacts")) && !resolved.startsWith(resolvePath(join(root, ".orch", "artifacts")) + sep)) {
		return undefined;
	}
	return resolved;
}

/**
 * One artifact: JSON `{name, bytes, mtimeMs}` metadata for oversized text,
 * `binary` for content with NUL bytes, plain text otherwise (≤ 5 MiB).
 */
export async function readArtifact(root: string, name: string): Promise<ArtifactRead> {
	const path = artifactPath(root, name);
	const meta = path ? await stat(path).catch(() => undefined) : undefined;
	if (!path || !meta?.isFile()) return { kind: "missing", name };
	if (meta.size > DISPLAY_PATCH_CAP_BYTES) {
		return { kind: "metadata", name, bytes: meta.size, download: `/api/artifacts/${encodeURIComponent(name)}?download=1` };
	}
	const buf = await readFile(path).catch(() => undefined);
	if (buf === undefined) return { kind: "missing", name };
	if (buf.includes(0)) return { kind: "binary", name, bytes: meta.size };
	return { kind: "text", name, text: buf.toString("utf8"), bytes: buf.length, truncated: false };
}

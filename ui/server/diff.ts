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
import { diffDisplayTrees, DISPLAY_PATCH_CAP_BYTES } from "../../src/util/git.ts";
import { resolveCanonicalProjectRoot } from "../../src/sandbox/host-profile.ts";
import { openSafeDirectory, openSafeFile, readSafeText, resolveSafeReadRoot } from "../../src/util/safe-read.ts";
import type { SafeReadResult } from "../../src/util/safe-read.ts";
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
	/** stats side-car artifact NAME when present */
	stats?: string;
	/** legacy artifact from a pre-revision kit run — display only, no receipt. */
	historical?: boolean;
}

/** Canonical root for this request; undefined when the root itself is unusable. */
async function canonicalRoot(root: string): Promise<string | undefined> {
	try { return await resolveCanonicalProjectRoot(root); } catch { return undefined; }
}

/** Read one small `.orch` side-car through the no-follow boundary (JSON or undefined). */
async function readSidecarJson<T>(rootInput: string, path: string): Promise<T | undefined> {
	const root = await canonicalRoot(rootInput);
	if (!root) return undefined;
	const read = await readSafeText({ root, path });
	if (read.kind !== "ok") return undefined;
	try { return JSON.parse(read.value) as T; } catch { return undefined; }
}

/** The current plan revision from the status side-car (undefined when unknown). */
async function currentPlanRevision(root: string): Promise<string | undefined> {
	const payload = await readSidecarJson<StatusPayloads>(root, ".orch/status.json");
	return typeof payload?.planRevision === "string" ? payload.planRevision : undefined;
}

/**
 * Artifact entries under `.orch/artifacts` through the pinned no-follow
 * directory handle (M1-P01 step g). Absence is the defined "no artifacts yet";
 * a refused directory is `undefined`, so a display route degrades to its stated
 * 404/409 rather than listing a link target's metadata.
 */
async function artifactNames(rootInput: string): Promise<string[] | undefined> {
	const root = await canonicalRoot(rootInput);
	if (!root) return undefined;
	const opened = await openSafeDirectory({ root, path: ".orch/artifacts" });
	if (opened.kind !== "ok") return undefined;
	try {
		const listed = await opened.value.list();
		if (listed.kind !== "ok") return undefined;
		return listed.value.filter((entry) => entry.kind === "file").map((entry) => entry.name).sort();
	} finally {
		await opened.value.close();
	}
}

export async function locateTaskDiff(rootInput: string, taskId: string): Promise<PatchLocation | undefined> {
	const root = await canonicalRoot(rootInput);
	if (!root) return undefined;
	const names = await artifactNames(root);
	if (!names) return undefined;
	const revision = await currentPlanRevision(root);
	if (revision) {
		// Revision-qualified selection — the same rule the core readout applies.
		// A revision exists but no candidate artifact for this task → 404: a
		// legacy same-named artifact must never present as current.
		const prefix = `candidate-${revision}-${taskId}-w`;
		let bestWave = 0;
		let bestName: string | undefined;
		for (const name of names) {
			if (!name.startsWith(prefix) || !name.endsWith(".patch")) continue;
			const wave = Number(/-w(\d+)\.patch$/.exec(name)?.[1]);
			if (Number.isSafeInteger(wave) && wave > bestWave) {
				bestWave = wave;
				bestName = name;
			}
		}
		return bestName ? located(names, taskId, bestName, false) : undefined;
	}
	// No known revision (pre-P14 project): legacy names, labeled historical.
	const candidates = [`task-${taskId}.patch`];
	let bestWave = 0;
	for (const name of names) {
		if (!name.startsWith(`quarantined-${taskId}-w`) || !name.endsWith(".patch")) continue;
		const wave = Number(/-w(\d+)\.patch$/.exec(name)?.[1]);
		if (Number.isInteger(wave) && wave > bestWave) bestWave = wave;
	}
	if (bestWave > 0) candidates.push(`quarantined-${taskId}-w${bestWave}.patch`);
	for (const patch of candidates) {
		const locatedPatch = located(names, taskId, patch, true);
		if (locatedPatch) return locatedPatch;
	}
	return undefined;
}

/**
 * Validate one constructed artifact name (§11.4 even for our own names). The
 * name must be in the pinned listing — the patch and its stats side-car are
 * never stat'ed through a path.
 */
function located(names: readonly string[], taskId: string, patch: string, historical: boolean): PatchLocation | undefined {
	if (!validateName(patch) || !names.includes(patch)) return undefined;
	const statsName = patch.replace(/\.patch$/, ".json");
	return {
		task: taskId,
		patch,
		...(historical ? { historical: true } : {}),
		...(validateName(statsName) && names.includes(statsName) ? { stats: statsName } : {}),
	};
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
	// The patch (and its stats side-car) are read through the no-follow boundary:
	// a symlinked artifact or `.orch` ancestor is refused, never disclosed.
	const locatedPatch = await readArtifactFile(root, located.patch);
	if (locatedPatch === undefined) return { ok: false, status: 404, error: `patch artifact ${located.patch} is unreadable` };
	const raw = locatedPatch.text;
	const truncatedOnDisk = Buffer.byteLength(raw, "utf8") > DISPLAY_PATCH_CAP_BYTES;
	const text = truncatedOnDisk ? Buffer.from(raw, "utf8").subarray(0, DISPLAY_PATCH_CAP_BYTES).toString("utf8") : raw;
	const payload: TaskDiffPayload = {
		at: Date.now(),
		task: taskId,
		patch: located.patch,
		stats: located.stats ?? null,
		bytes: locatedPatch.size,
		truncated: false,
		diff: text,
		...(located.historical ? { historical: true } : {}),
	};
	if (located.stats) {
		const stats = await readSidecarJson<DisplayDiffStats>(root, `.orch/artifacts/${located.stats}`);
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

/**
 * One validated artifact read: root-relative, no-follow, §2-capped (32 MiB).
 * Undefined means absent OR refused; callers never see bytes from a link target.
 */
async function readArtifactFile(rootInput: string, name: string): Promise<{ text: string; size: number } | undefined> {
	const root = await canonicalRoot(rootInput);
	if (!root || !validateName(name)) return undefined;
	const opened = await openSafeFile({ root, path: `.orch/artifacts/${name}` });
	if (opened.kind !== "ok") return undefined;
	try {
		const read = await opened.value.readBytes();
		if (read.kind !== "ok") return undefined;
		return { text: read.value.toString("utf8"), size: opened.value.size };
	} finally {
		await opened.value.close();
	}
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
	const payload = await readSidecarJson<StatusPayloads>(root, ".orch/status.json");
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

/**
 * Wave-log TAIL policy (M1-P01 step g): the side-car is append-only and grows
 * for the life of a project, so the UI reads at most the last
 * `WAVE_LOG_TAIL_BYTES` through the pinned no-follow handle (`readTailText`),
 * which drops the possibly-partial first line of the window. Parsing stays
 * tolerant: a torn append skips its line and keeps the rest. Absence is the
 * defined "no log yet"; a refused file degrades to no rows so the display
 * route keeps its stated 409 (never a link target's bytes, never a full load).
 */
export const WAVE_LOG_TAIL_BYTES = 4 * 1024 * 1024;
export const WAVE_LOG_TAIL_ROWS = 20_000;

async function readWaveRows(rootInput: string): Promise<WaveRow[]> {
	const resolved = await resolveSafeReadRoot(rootInput);
	if (resolved.kind !== "ok") return [];
	const opened = await openSafeFile({ root: resolved.root, path: ".orch/wave-log.jsonl" });
	if (opened.kind !== "ok") return [];
	try {
		const tail = await opened.value.readTailText({ maxBytes: WAVE_LOG_TAIL_BYTES });
		if (tail.kind !== "ok") return [];
		const rows: WaveRow[] = [];
		for (const line of tail.value.text.split("\n")) {
			if (!line.trim()) continue;
			try {
				rows.push(JSON.parse(line) as WaveRow);
			} catch {
				/* torn append mid-flush: skip the line, keep the rest */
			}
		}
		return rows.length > WAVE_LOG_TAIL_ROWS ? rows.slice(-WAVE_LOG_TAIL_ROWS) : rows;
	} finally {
		await opened.value.close();
	}
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

/**
 * `.orch/artifacts` entries through the pinned no-follow directory handle
 * (M1-P01 step g): absence is the defined empty list, a refused directory or a
 * symlink/special entry is an empty list (this display route states "none";
 * the download route reports the refusal), and metadata comes from fstat on the
 * opened pinned descriptor — never a path stat that could follow a link.
 */
export async function artifactList(rootInput: string): Promise<ArtifactEntry[]> {
	const resolved = await resolveSafeReadRoot(rootInput);
	if (resolved.kind !== "ok") return [];
	const opened = await openSafeDirectory({ root: resolved.root, path: ".orch/artifacts" });
	if (opened.kind !== "ok") return [];
	try {
		const listed = await opened.value.list();
		if (listed.kind !== "ok") return [];
		const entries: ArtifactEntry[] = [];
		for (const entry of listed.value) {
			if (entry.kind !== "file") continue;
			const file = await opened.value.openFile(entry.name);
			if (file.kind !== "ok") continue;
			try {
				entries.push({ name: entry.name, bytes: file.value.size, mtimeMs: file.value.mtimeMs });
			} finally {
				await file.value.close();
			}
		}
		return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	} finally {
		await opened.value.close();
	}
}

export type ArtifactRead =
	| { kind: "text"; name: string; text: string; bytes: number; truncated: boolean }
	| { kind: "metadata"; name: string; bytes: number; download: string }
	| { kind: "missing"; name: string }
	| { kind: "binary"; name: string; bytes: number };

/**
 * Download bytes for one artifact, from the pinned safe-read handle (M1-P01
 * step g). This replaces the old `stat` + `createReadStream` pair, which could
 * follow a project symlink. Absent and refused stay distinct results: the route
 * answers 404 for absence and 409 with the typed refusal code (and NO bytes)
 * for a symlink/escape/type/cap/permission refusal.
 */
export async function readArtifactBytes(rootInput: string, name: string): Promise<SafeReadResult<Buffer>> {
	if (!validateName(name)) {
		return { kind: "refused", code: "unsafe-path", path: name, message: `bad artifact name ${JSON.stringify(name)} — expected [A-Za-z0-9._-] (no traversal)` };
	}
	const resolved = await resolveSafeReadRoot(rootInput);
	if (resolved.kind !== "ok") return resolved;
	const opened = await openSafeFile({ root: resolved.root, path: `.orch/artifacts/${name}` });
	if (opened.kind !== "ok") return opened;
	try {
		return await opened.value.readBytes();
	} finally {
		await opened.value.close();
	}
}

/**
 * One artifact: JSON `{name, bytes, mtimeMs}` metadata for oversized text,
 * `binary` for content with NUL bytes, plain text otherwise (≤ 5 MiB).
 * The bytes come from the no-follow, capped boundary; the path/stat check here
 * only picks the metadata branch and never discloses file content.
 */
export async function readArtifact(root: string, name: string): Promise<ArtifactRead> {
	if (!validateName(name)) return { kind: "missing", name };
	const canonical = await canonicalRoot(root);
	if (!canonical) return { kind: "missing", name };
	const opened = await openSafeFile({ root: canonical, path: `.orch/artifacts/${name}` });
	if (opened.kind !== "ok") return { kind: "missing", name };
	try {
		const size = opened.value.size;
		if (size > DISPLAY_PATCH_CAP_BYTES) {
			return { kind: "metadata", name, bytes: size, download: `/api/artifacts/${encodeURIComponent(name)}?download=1` };
		}
		const read = await opened.value.readBytes();
		if (read.kind !== "ok") return { kind: "missing", name };
		if (read.value.includes(0)) return { kind: "binary", name, bytes: size };
		return { kind: "text", name, text: read.value.toString("utf8"), bytes: read.value.length, truncated: false };
	} finally {
		await opened.value.close();
	}
}

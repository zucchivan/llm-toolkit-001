/** Client API access + the wire types the ui server speaks (§11.2). */
import type { KitReadout } from "../../../src/engine/inspector.ts";
import type { JobRecord, AttachedRun } from "../../server/jobs.ts";
import type { DiffStats, DisplayDiffStats } from "../../../src/util/git.ts";

/** Stats-sidecar-free per-file view (wire shape from the live endpoint). */
export type { DiffStats, DisplayDiffStats };

/** GET /api/tasks/:id/diff wire shape (persisted patch + parsed stats). */
export interface TaskDiffPayload {
	at: number;
	task: string;
	patch: string;
	stats: string | null;
	bytes: number;
	truncated: boolean;
	diff: string;
	statsJson?: DisplayDiffStats;
	baselineTreeSha?: string;
}

/** GET /api/tasks/:id/diff/live wire shape (computed on demand, never persisted). */
export interface LiveDiffPayload {
	at: number;
	task: string;
	wave: number;
	baselineTreeSha: string;
	bytes: number;
	truncated: boolean;
	diff: string;
	stats: DiffStats;
	note?: string;
}

/** One normalized diff doc for the drawer (either endpoint). */
export interface DiffDoc {
	task: string;
	wave?: number;
	live: boolean;
	diff: string;
	bytes: number;
	truncated: boolean;
	statsJson?: DisplayDiffStats;
	/* live payload's plain stats → shaped like the side-car for uniform rendering */
	statsFiles?: DiffStats["files"];
	note?: string;
	baselineTreeSha?: string;
}

export function normalize(live: LiveDiffPayload): DiffDoc {
	return {
		task: live.task,
		wave: live.wave,
		live: true,
		diff: live.diff,
		bytes: live.bytes,
		truncated: live.truncated,
		statsFiles: live.stats.files,
		...(live.note !== undefined ? { note: live.note } : {}),
	};
}

export function normalizePersisted(p: TaskDiffPayload): DiffDoc {
	return {
		task: p.task,
		wave: p.statsJson?.wave,
		live: false,
		diff: p.diff,
		bytes: p.bytes,
		truncated: p.truncated,
		statsJson: p.statsJson,
		...(p.baselineTreeSha !== undefined ? { baselineTreeSha: p.baselineTreeSha } : {}),
	};
}

export interface ReadoutSnapshot {
	readout: KitReadout;
	mode: "storage" | "sidecars";
	at: number;
	/** Augmented from status.json: the governor's armed sleep (§8.5). */
	sleep?: { until: number; cycleCount?: number; alert?: string };
	/** Augmented from status.json: the PRD path (§8.2 plan prefill). */
	prdPath?: string;
}

export interface JobsPayload {
	at: number;
	jobs: JobRecord[];
	attached?: AttachedRun;
}

export async function fetchReadout(): Promise<ReadoutSnapshot> {
	const res = await fetch("/api/readout");
	if (!res.ok) throw new Error(await errorMessage(res));
	return (await res.json()) as ReadoutSnapshot;
}

/** GET /api/tasks/:id/diff (§11.2): the persisted diff; 404 surfaces as a thrown Error. */
export async function fetchTaskDiff(task: string): Promise<TaskDiffPayload> {
	const res = await fetch(`/api/tasks/${encodeURIComponent(task)}/diff`);
	if (!res.ok) throw new Error(await errorMessage(res) || `HTTP ${res.status}`);
	return (await res.json()) as TaskDiffPayload;
}

/** GET /api/tasks/:id/diff/live: computed vs the baseline; 409 when not in-flight. */
export async function fetchLiveDiff(task: string): Promise<LiveDiffPayload> {
	const res = await fetch(`/api/tasks/${encodeURIComponent(task)}/diff/live`);
	if (!res.ok) throw new Error(await errorMessage(res) || `HTTP ${res.status}`);
	return (await res.json()) as LiveDiffPayload;
}

/** The raw patch as a browser download (attachment; the cookie authenticates). */
export function diffDownloadUrl(task: string): string {
	return `/api/tasks/${encodeURIComponent(task)}/diff?download=1`;
}

export async function fetchJobs(): Promise<JobsPayload> {
	const res = await fetch("/api/jobs");
	if (!res.ok) throw new Error(await errorMessage(res));
	return (await res.json()) as JobsPayload;
}

export async function fetchJobLog(id: string, lines = 200): Promise<{ lines: string[] }> {
	const res = await fetch(`/api/jobs/${encodeURIComponent(id)}/log?n=${encodeURIComponent(String(lines))}`);
	if (!res.ok) throw new Error(await errorMessage(res));
	return (await res.json()) as { lines: string[] };
}

export type ActionBody =
	| { kind: "plan"; prd?: string }
	| { kind: "run"; approve: true; tasks?: string[] }
	| { kind: "run"; resume: true }
	| { kind: "stop" }
	| { kind: "handoff"; note: string }
	| { kind: "verify"; task: string }
	| { kind: "export" };

export interface ActionAccepted {
	jobId: string;
	kind: string;
}

/**
 * POST /api/actions (Appendix C step 5): same-origin by construction (the page
 * itself), the session's CSRF cookie echoed in the X-Kit-Token header.
 * 202 { jobId } on accept; other statuses surface the server's plain error.
 */
export async function postAction(body: ActionBody): Promise<ActionAccepted> {
	const res = await fetch("/api/actions", {
		method: "POST",
		headers: { "content-type": "application/json", "x-kit-token": csrfToken() },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(await errorMessage(res));
	return (await res.json()) as ActionAccepted;
}

/**
 * The CSRF cookie (non-HttpOnly companion, minted at handshake). Missing → "" —
 * the server answers 403 with a plain "reopen the URL" message.
 */
export function csrfToken(): string {
	for (const part of document.cookie.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === "kit_ui_csrf") return decodeURIComponent(rest.join("="));
	}
	return "";
}

async function errorMessage(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { error?: string };
		if (body.error) return body.error;
	} catch {
		/* non-JSON body */
	}
	return `HTTP ${res.status}`;
}

/** Client API access + the wire types the ui server speaks (§11.2). */
import type { ConvEntryView, KitReadout } from "../../../src/engine/inspector.ts";
import type { ProjectSourcesPayload } from "../../server/sources.ts";
import type { JobRecord, JobView, AttachedRun } from "../../server/jobs.ts";
import type { RoleModelInfo } from "../../server/readout.ts";
import type { DiffStats, DisplayDiffStats } from "../../../src/util/git.ts";

export type { RoleModelInfo, JobView };

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
	/** Augmented from status.json + config: the configured role models (plan/run dialogs render them). */
	roles?: RoleModelInfo[];
	/** The project config failed to load mid-session: the reason in kind words (dialogs explain instead of spawning doomed jobs). */
	configError?: string;
	/** Augmented from status.json: the PRD path (§8.2 plan prefill). */
	prdPath?: string;
}

export interface JobsPayload {
	at: number;
	/** Records with a bounded reason tail attached on diagnostic outcomes (failed/stale/42). */
	jobs: JobView[];
	attached?: AttachedRun;
}

export async function fetchReadout(): Promise<ReadoutSnapshot> {
	const res = await fetch("/api/readout");
	if (!res.ok) throw new Error(await errorMessage(res));
	return (await res.json()) as ReadoutSnapshot;
}

/** Server <-> client shared shape for one read-only project source (ui/server/sources.ts). */
export type { SourceFileView, ProjectSourcesPayload } from "../../server/sources.ts";

/** M5-a: GET /api/project/sources — raw config + PRD text + verdicts (read-only, both modes). */
export async function fetchProjectSources(): Promise<ProjectSourcesPayload> {
	const res = await fetch("/api/project/sources");
	if (!res.ok) throw new Error(await errorMessage(res) || `HTTP ${res.status}`);
	return (await res.json()) as ProjectSourcesPayload;
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

/** A.5: GET /api/conversations/:id/entries wire shape (bounded transcript excerpt). */
export interface ConversationEntriesPayload {
	at: number;
	conversation: number;
	entries: ConvEntryView[];
	truncated: boolean;
}

/**
 * A.5: the bounded transcript excerpt for one conversation. 404 (unknown id)
 * and 409 (a run owns the lock — the established empty state) surface as
 * thrown Errors whose message the drawer classifies (excerptErrorState).
 */
export async function fetchConversationEntries(conversation: number): Promise<ConversationEntriesPayload> {
	const res = await fetch(`/api/conversations/${conversation}/entries`);
	if (!res.ok) throw new Error(await errorMessage(res) || `HTTP ${res.status}`);
	return (await res.json()) as ConversationEntriesPayload;
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
	| { kind: "stop"; target?: "job" }
	| { kind: "stop"; target: "attached"; pid: number }
	| { kind: "handoff"; note: string }
	| { kind: "verify"; task: string }
	| { kind: "export" };

export interface ActionAccepted {
	kind: string;
	/** The spawned job record — absent on an attached stop (there is no record; the pid is the answer). */
	jobId?: string;
	/** stop: the signalled pid (either path). */
	pid?: number;
	/** stop target "attached" echoes back. */
	target?: "attached";
}

/**
 * POST /api/actions (Appendix C step 5): same-origin by construction (the page
 * itself), the session's CSRF cookie echoed in the X-Kit-Token header.
 * 202 { jobId } on accept; other statuses surface the server's plain error.
 * An attached stop (§7.2.1) answers { kind, target: "attached", pid } — the
 * server verified the runner's identity and sent exactly one SIGINT.
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

/**
 * Durable state reader/writer for the kit's three session docs
 * (RouterDoc, WaveLogDoc, RunStatusDoc) plus the side-cars that surface them:
 * router.md (human mirror), .orch/wave-log.jsonl (append-only JSONL mirror),
 * and .orch/status.json (atomic cross-process status payload).
 */
import { BACKGROUND_CONTEXT } from "./kit.ts";
import { RouterDoc, RunStatusDoc, WaveLogDoc, syncSideCars } from "./infos.ts";
import { readJson } from "../util/fsx.ts";
import type { RouterDocValue, RouterTask, RunStatusDocValue, WaveRow } from "./infos.ts";
import { flushStated } from "./harness.ts";
import type { LoopAndLock, ProjectPaths, ReportRow, StatusPayloads } from "./harness.ts";
import type { Session, Draft } from "./kit.ts";
import type { Draft as ChordDraft } from "@earendil-works/chord";

export interface SessionState {
	router: RouterDocValue;
	runStatus: RunStatusDocValue;
	rows: WaveRow[];
}

export async function readSessionState(kit: Session): Promise<SessionState> {
	const [router, runStatus, wavelog] = await Promise.all([
		kit.snapshot(RouterDoc, BACKGROUND_CONTEXT),
		kit.snapshot(RunStatusDoc, BACKGROUND_CONTEXT),
		kit.snapshot(WaveLogDoc, BACKGROUND_CONTEXT),
	]);
	return {
		router: { ...(router ?? { version: 1, phase: "empty", tasks: [] }) },
		runStatus: { ...(runStatus ?? defaultRunStatus()) },
		rows: wavelog?.rows ?? [],
	};
}

function defaultRunStatus(): RunStatusDocValue {
	return {
		version: 1,
		budgetSpentUsd: 0,
		sleepCycleCount: 0,
		consecutiveErrors: 0,
		kitVersion: "0.1.0",
	};
}

export interface StateInput {
	/** Mutate the RouterDoc draft inside the commit. Edits apply last. */
	router?: RouterDocValue | ((d: ChordDraft<RouterDocValue>) => void);
	/** Mutate the RunStatus draft inside the commit. */
	runStatus?: RunStatusDocValue | ((d: ChordDraft<RunStatusDocValue>) => void);
	/** Wave-log rows appended inside the commit (then mirrored to JSONL). */
	rows?: WaveRow[];
	/** What status.json should show after this commit. */
	statusPhase?: StatusPhase;
	/** Latest engine reports to carry into status.json. */
	reports?: ReportRow[];
}

export type StatusPhase =
	| { phase: "planning" }
	/** UI seam A.1: wave-running carries `startedAt` (epoch ms of the wave's start
	 *  row) so an attached UI can render the elapsed timer truthfully. */
	| { phase: "wave-running"; task?: string; wave?: number; startedAt?: number }
	| { phase: "idle"; message?: string }
	| { phase: "closed" };

const EMPTY_ROUTER: RouterDocValue = { version: 1, phase: "empty", tasks: [] };

/**
 * Flush the status side-car WITHOUT a storage commit (visibility-only snapshot).
 * Additive UI seam A.1: e.g. the planner marks phase "planning" before its
 * conversation starts, so an attached UI sees the planning state immediately.
 */
export async function flushStatusSnapshot(loopAndLock: LoopAndLock, statusPhase: StatusPhase): Promise<void> {
	const state = await readSessionState(loopAndLock.loop.harness);
	const sessionUsage = await loopAndLock.loop.sessionUsage();
	await flushStated(loopAndLock.loop.paths, composeStatusPayload(loopAndLock, {
		routerAfter: state.router,
		statusAfter: state.runStatus,
		statusPhase,
		sessionUsageUsd: sessionUsage.totalUsd,
	}));
}

interface PayloadInput {
	routerAfter: RouterDocValue;
	statusAfter: RunStatusDocValue;
	statusPhase?: StatusPhase;
	reports?: ReportRow[];
	sessionUsageUsd: number;
}

/** The single status.json composer: commit flushes and commit-less snapshots share it. */
function composeStatusPayload(loopAndLock: LoopAndLock, input: PayloadInput): StatusPayloads {
	const paths: ProjectPaths = loopAndLock.loop.paths;
	// Drafts are commit-scoped: callers pass the committed values; `sp` narrows
	// the one StatusPhase variant that carries task/wave/startedAt. (Sticky
	// wave-running is resolved in postCommit BEFORE this composer: wave-internal
	// commits without an explicit phase keep the side-car inside the live wave;
	// every wave END passes its own phase and clears it.)
	const sp = input.statusPhase && input.statusPhase.phase === "wave-running" ? input.statusPhase : undefined;
	return {
		kit: input.statusAfter.kitVersion,
		piDurable: loopAndLock.loop.config.engine.piDurable,
		lockedByPid: process.pid,
		ts: Date.now(),
		root: paths.root,
		phase: input.statusPhase?.phase ?? "idle",
		task: sp
			? { id: sp.task ?? "", wave: sp.wave ?? 0, status: "running", startedAt: sp.startedAt }
			: undefined,
		// Surface the StatusPhase message in status.json (e.g. "complete — 2 task(s)
		// quarantined: t3, t7") — the payload shape already declares `message`;
		// without this forward it never reached the side-car.
		message: input.statusPhase && "message" in input.statusPhase ? input.statusPhase.message : undefined,
		budget: {
			spentUsd: input.statusAfter.budgetSpentUsd,
			sessionCeilingUsd: loopAndLock.loop.config.budgets.sessionUsd,
			waveWarnUsd: loopAndLock.loop.config.budgets.waveUsdWarn,
		},
		// UI seam A.2 (additive): baselineTreeSha rides each task so an attached UI
		// can compute the live diff vs the task's baseline while a run owns the lock
		// (storage is untouchable; the side-car is the only readable truth).
		tasks: input.routerAfter.tasks.map((t) => {
			const entry: StatusPayloads["tasks"][number] = { id: t.id, status: t.status, waveCount: t.waveCount, title: t.title };
			if (t.baselineTreeSha) entry.baselineTreeSha = t.baselineTreeSha;
			return entry;
		}),
		reports: input.reports,
		alert: input.statusAfter.activeAlert,
		usageNote: input.sessionUsageUsd,
		// UI seam A.1 (additive): governor state + PRD provenance for attached UIs.
		sleepUntil: input.statusAfter.sleepUntil,
		consecutiveErrors: input.statusAfter.consecutiveErrors,
		sleepCycleCount: input.statusAfter.sleepCycleCount,
		prdPath: input.statusAfter.prdPath,
	};
}

/** One atomic commit of the three docs; mirrors + status.json follow best-effort. */
export async function commitState(loopAndLock: LoopAndLock, input: StateInput): Promise<void> {
	const harness = loopAndLock.loop.harness;
	await harness.commit(
		async (tx) => {
			if (input.router) {
				const draft = await tx.doc(RouterDoc);
				applyInput(draft, input.router);
			}
			if (input.runStatus) {
				const draft = await tx.doc(RunStatusDoc);
				applyInput(draft, input.runStatus);
			}
			if (input.rows?.length) {
				const wlDraft = await tx.doc(WaveLogDoc);
				wlDraft.rows.push(...input.rows);
			}
		},
		BACKGROUND_CONTEXT,
	);

	// Drafts are commit-scoped: read the committed values via snapshots after resolution.
	const [routerAfter, statusAfter] = await Promise.all([
		harness.snapshot(RouterDoc, BACKGROUND_CONTEXT),
		harness.snapshot(RunStatusDoc, BACKGROUND_CONTEXT),
	]);
	const wlRead = await harness.snapshot(WaveLogDoc, BACKGROUND_CONTEXT);
	await postCommit(loopAndLock, {
		routerAfter: { ...(routerAfter ?? { version: 1, phase: "empty", tasks: [] }) },
		statusAfter: { ...(statusAfter ?? defaultRunStatus()) },
		rowsAfter: wlRead?.rows ?? [],
		input,
	});
}

/** Apply data or mutator to a doc draft. */
function applyInput(
	draft: unknown,
	input: NonNullable<StateInput["router"]> | NonNullable<StateInput["runStatus"]>,
): void {
	if (typeof input === "function") (input as (d: unknown) => void)(draft);
	else Object.assign(draft as Record<string, unknown>, input);
}

async function postCommit(
	loopAndLock: LoopAndLock,
	calculated: {
		routerAfter: RouterDocValue;
		statusAfter: RunStatusDocValue;
		rowsAfter: WaveRow[];
		input: StateInput;
	},
): Promise<void> {
	const paths: ProjectPaths = loopAndLock.loop.paths;
	await syncSideCars(
		{ tasks: calculated.routerAfter.tasks, phase: calculated.routerAfter.phase, rows: calculated.rowsAfter },
		{ routerMd: paths.routerMd, waveLogJsonl: paths.waveLog },
		calculated.statusAfter.prdPath,
	);
	const sessionUsage = await loopAndLock.loop.sessionUsage();
	// Sticky wave-running (A.1 refinement, additive): wave-internal commits that
	// pass no explicit phase (budget accumulation, verifier verdict rows,
	// governor notices) must NOT demote the side-car out of the live wave — an
	// attached UI keeps a truthful elapsed timer and live-diff 200s between
	// snapshot flushes. An explicit phase at wave END always clears it.
	let statusPhase = calculated.input.statusPhase;
	if (statusPhase === undefined) {
		const previous = await readJson<StatusPayloads>(paths.status).catch(() => undefined);
		if (previous?.phase === "wave-running" && previous.task) {
			statusPhase = { phase: "wave-running", task: previous.task.id, wave: previous.task.wave, startedAt: previous.task.startedAt ?? 0 };
		}
	}
	await flushStated(
		paths,
		composeStatusPayload(loopAndLock, {
			routerAfter: calculated.routerAfter,
			statusAfter: calculated.statusAfter,
			statusPhase,
			reports: calculated.input.reports,
			sessionUsageUsd: sessionUsage.totalUsd,
		}),
	);
}

/**
 * Durable state reader/writer for the kit's three session docs
 * (RouterDoc, WaveLogDoc, RunStatusDoc) plus the side-cars that surface them:
 * router.md (human mirror), .orch/wave-log.jsonl (append-only JSONL mirror),
 * and .orch/status.json (atomic cross-process status payload).
 */
import { BACKGROUND_CONTEXT } from "./kit.ts";
import { RouterDoc, RunStatusDoc, WaveLogDoc, syncSideCars } from "./infos.ts";
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
	| { phase: "wave-running"; task?: string; wave?: number }
	| { phase: "idle"; message?: string }
	| { phase: "closed" };

const EMPTY_ROUTER: RouterDocValue = { version: 1, phase: "empty", tasks: [] };

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
	await flushStated(paths, {
		kit: calculated.statusAfter.kitVersion,
		piDurable: loopAndLock.loop.config.engine.piDurable,
		ts: Date.now(),
		root: paths.root,
		phase: calculated.input.statusPhase?.phase ?? "idle",
		task: calculated.input.statusPhase && "task" in calculated.input.statusPhase
			? { id: calculated.input.statusPhase.task ?? "", wave: calculated.input.statusPhase.wave ?? 0, status: "running" }
			: undefined,
		budget: {
			spentUsd: calculated.statusAfter.budgetSpentUsd,
			sessionCeilingUsd: loopAndLock.loop.config.budgets.sessionUsd,
			waveWarnUsd: loopAndLock.loop.config.budgets.waveUsdWarn,
		},
		tasks: calculated.routerAfter.tasks.map((t) => ({ id: t.id, status: t.status, waveCount: t.waveCount, title: t.title })),
		reports: calculated.input.reports,
		alert: calculated.statusAfter.activeAlert,
		usageNote: sessionUsage.totalUsd,
	});
}

/**
 * Durable state reader/writer for the kit's three session docs
 * (RouterDoc, WaveLogDoc, RunStatusDoc) plus the side-cars that surface them:
 * router.md (human mirror), .orch/wave-log.jsonl (append-only JSONL mirror),
 * and .orch/status.json (atomic cross-process status payload).
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "./kit.ts";
import { RouterDoc, RunStatusDoc, WaveLogDoc, syncSideCars, renderRouterMd } from "./infos.ts";
import { checkpointKey, latestFrozenCheckpoint, latestReceiptStates, receiptKey, ReceiptsDoc } from "./receipts.ts";
import type { Checkpoint, CheckpointEvent, JournalReceiptEvent, ReceiptEvent, ReceiptIdentity, ReceiptsDocValue } from "./receipts.ts";
import type { ArchivedPlanRef, PlanIdentity } from "./plans.ts";
import { KIT_VERSION } from "../config.ts";
import { readJson } from "../util/fsx.ts";
import type { LoopAndLock } from "./harness.ts";
import type { RouterDocValue, RouterTask, RunStatusDocValue, WaveRow } from "./infos.ts";
import { flushStated } from "./harness.ts";
import type { ProjectPaths, ReportRow, StatusPayloads } from "./harness.ts";
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
		router: { ...(router ?? emptyRouter()) },
		runStatus: { ...(runStatus ?? defaultRunStatus()) },
		rows: wavelog?.rows ?? [],
	};
}

/** v2 empty-router fallback for a doc that has not been written yet. */
function emptyRouter(): RouterDocValue {
	return { version: 2, phase: "empty", tasks: [], archived: [] };
}

function defaultRunStatus(): RunStatusDocValue {
	return {
		version: 2,
		budgetSpentUsd: 0,
		sleepCycleCount: 0,
		consecutiveErrors: 0,
		// Fallback identity for a doc not yet written: the CURRENT kit version
		// (package.json); a recorded kitVersion is historical and never rewritten.
		kitVersion: KIT_VERSION,
	};
}

// ---------------------------------------------------------------------------
// Plan-authorization gate (M0-P04) + exact grants (M0-P05, ADR 01)
// ---------------------------------------------------------------------------

/**
 * The grant a human approval writes (ADR 01): approval atomically records
 * exactly `{planRevision, selected, humanApprovedAt}`. `selected` is the
 * EXACT granted id list — sorted, unique, never a wildcard: absent `--tasks`
 * on the approving command stores every plan id explicitly, and a bare
 * `run` resumes exactly this list (mirror edits are never imported).
 */
export interface Grant {
	/** The reviewed plan revision this grant belongs to. */
	planRevision: string;
	/** Granted task ids, sorted unique. */
	selected: string[];
	/** Epoch ms of the human approval stamp. */
	humanApprovedAt: number;
}

/**
 * The stored grant, or undefined when the stamp is incomplete. A stamp
 * authorizes a run only when all three grant fields are present AND the
 * revision names the RouterDoc's CURRENT planRevision: pre-grant v2 stamps
 * (revision + timestamp, no selection) and migrated v1 stamps authorize
 * nothing — fail old clients closed until the UI packet carries the tuple.
 */
export function readGrant(runStatus: RunStatusDocValue): Grant | undefined {
	const { approvedPlanRevision, approvedSelected, humanApprovedAt } = runStatus;
	if (approvedPlanRevision === undefined || approvedSelected === undefined || humanApprovedAt === undefined) return undefined;
	return { planRevision: approvedPlanRevision, selected: approvedSelected, humanApprovedAt };
}

/**
 * Why a mutating run may not proceed against this state, or undefined when it
 * may. Enforced on the CLI path (the engine/automation interface; the UI
 * spawns the same CLI):
 *
 *  - A plan WITHOUT an identity is an unmigrated v1 plan. Old rows stay
 *    readable, but a mutating run NEVER executes one — not even with
 *    `--approve`. The documented v1 upgrade is: reconcile any operator edits
 *    manually, commit the intended base, `plan` again (this archives the old
 *    plan and clears stamps), review router.md, then approve.
 *  - A stamped approval authorizes a run only when it NAMES the current plan
 *    revision (`approvedPlanRevision` matching RouterDoc.identity). A
 *    timestamp alone — v1 legacy stamps included — authorizes nothing.
 *
 * This is the M0-P04 layer. The M0-P05 grant rules (revision-qualified
 * `--revision` on new grants, the selected-set triple, mirror matching and
 * resume equality) live in `grantRefusal` below, which the driver enforces
 * before any wave or model dispatch.
 */
export function planRunRefusal(state: SessionState, opts: { approve?: boolean }): string | undefined {
	const legacy = legacyPlanRefusal(state);
	if (legacy) return legacy;
	const approved =
		state.runStatus.humanApprovedAt !== undefined &&
		state.runStatus.approvedPlanRevision !== undefined &&
		state.runStatus.approvedPlanRevision === state.router.identity?.planRevision;
	// The approval check applies to real graphs; a task-less store lets the
	// driver's own "no tasks — run plan first" refusal surface unchanged.
	if (!opts.approve && !approved && state.router.tasks.length) {
		return "router doc is PLANNED but not human-approved for its current plan revision — rerun with `run --approve --revision <uuid>` after reviewing router.md (this is the plan review point)";
	}
	return undefined;
}

/** The unmigrated-legacy-plan refusal (v1 storage), shared by both gates. */
export function legacyPlanRefusal(state: SessionState): string | undefined {
	if (state.router.tasks.length && !state.router.identity) {
		return (
			"this project's plan has no plan revision (v1 storage, created before plan identity existed) — a mutating run never executes unmigrated plans: " +
			"reconcile any operator edits manually, commit the intended base, run `plan` again (it archives the old plan and clears old approvals), " +
			"review router.md, then `run --approve --revision <uuid>`"
		);
	}
	return undefined;
}

/** A run request as the driver receives it (M0-P05). */
export interface RunRequest {
	/** A NEW grant (the review point): the plan revision it approves (the
	 *  CLI's --revision) plus the optional explicit task subset. */
	approve?: { planRevision?: string; tasks?: string[] };
	/** Explicit task ids on a bare resume: must equal the stored grant. */
	tasks?: string[];
}

/**
 * The M0-P05 grant gate: why THIS run request may not proceed against this
 * state, or undefined when it may. Pure (no filesystem): the mirror check
 * for new grants is `approvalMirrorRefusal`, enforced by the approval path
 * under the host lock.
 *
 *  - A new grant (`--approve`) requires an explicit `--revision` naming the
 *    CURRENT plan revision — there is no hidden default revision, and a
 *    stale/old revision refuses with the grant untouched.
 *  - The granted subset must name planned ids, without duplicates; every
 *    selected task's dependencies must be done or inside the selection —
 *    dependencies are never auto-included (no automatic closure).
 *  - A bare resume inherits the EXACT stored grant; an explicitly supplied
 *    set must equal it. A missing/incomplete/stale stamp authorizes nothing.
 */
export function grantRefusal(state: SessionState, req: RunRequest = {}): string | undefined {
	const legacy = legacyPlanRefusal(state);
	if (legacy) return legacy;
	const identity = state.router.identity;
	if (req.approve) {
		const requested = req.approve.planRevision;
		if (!requested) {
			return "a new grant requires --revision <uuid> — the plan revision `plan` printed and the router.md mirror shows (there is no hidden default revision)";
		}
		if (requested !== identity?.planRevision) {
			return `--revision ${requested} does not name the current plan revision ${identity?.planRevision ?? "(none)"} — a grant approves exactly the reviewed revision; replan to mint a new one`;
		}
		return selectionRefusal(state, req.approve.tasks);
	}
	// Bare resume: the stored grant governs; the mirror is never consulted.
	if (!state.router.tasks.length) return undefined; // the driver's own "no tasks" refusal surfaces
	const grant = readGrant(state.runStatus);
	if (!grant || grant.planRevision !== identity?.planRevision) {
		return "router doc is not human-approved for its current plan revision — rerun with `run --approve --revision <uuid>` after reviewing router.md (this is the plan review point)";
	}
	if (req.tasks !== undefined) {
		const requested = [...req.tasks].sort();
		const equalsGrant = requested.length === grant.selected.length && requested.every((id, i) => id === grant.selected[i]);
		if (!equalsGrant) {
			return `explicit --tasks (${req.tasks.join(", ")}) does not equal the stored grant (${grant.selected.join(", ")}) — bare resume inherits the exact grant; approve a changed grant with --approve --revision to admit different work`;
		}
	}
	return undefined;
}

/**
 * New-grant subset validation: known planned ids, no duplicates, and every
 * selected task's dependencies done or inside the selection. Empty set is
 * not a subset (omit --tasks for all ids).
 */
function selectionRefusal(state: SessionState, tasks: string[] | undefined): string | undefined {
	if (tasks === undefined) return undefined; // absent --tasks on the approving run = all ids
	if (tasks.length === 0) {
		return "an empty --tasks set is not a grant — omit --tasks for every task, or name at least one task id";
	}
	const seen = new Set<string>();
	for (const id of tasks) {
		if (seen.has(id)) return `duplicate --tasks entry "${id}" — repeat --tasks once per id; duplicates refuse without broadening`;
		seen.add(id);
	}
	const ids = new Set(state.router.tasks.map((t) => t.id));
	for (const id of tasks) {
		if (!ids.has(id)) {
			return `--tasks "${id}" is not a task in the current plan — the grant selects only planned ids; dependencies are never auto-included`;
		}
	}
	const status = new Map(state.router.tasks.map((t) => [t.id, t.status] as const));
	for (const task of state.router.tasks) {
		if (!seen.has(task.id)) continue;
		for (const dep of task.dependsOn) {
			if (seen.has(dep) || status.get(dep) === "done") continue;
			return `task "${task.id}" depends on "${dep}", which is outside this grant and not done — select "${dep}" too or approve all ids; dependencies are never auto-included`;
		}
	}
	return undefined;
}

/**
 * The exact granted set a validated request resolves to: every plan id
 * (explicitly — the full list is not a wildcard), or the given subset.
 */
export function resolveGrantSelection(state: SessionState, tasks: string[] | undefined): string[] {
	if (tasks === undefined) return state.router.tasks.map((t) => t.id).sort();
	return [...tasks].sort();
}

/**
 * M0-P05: a NEW grant binds the human to what they reviewed. Under the host
 * lock, the router.md mirror must exist and match the canonical durable
 * render (renderRouterMd with identity). A missing or edited mirror means
 * the reviewed text is not the durable plan — refuse and replan to refresh;
 * mirror edits are never imported into the grant. Bare resume never calls
 * this: the stored grant governs.
 */
export async function approvalMirrorRefusal(loopAndLock: LoopAndLock, state: SessionState): Promise<string | undefined> {
	const paths: ProjectPaths = loopAndLock.loop.paths;
	const disk = await readFile(paths.routerMd, "utf8").catch(() => undefined);
	if (disk === undefined) {
		return `router.md is missing — a new grant approves the reviewed mirror, and the mirror must match the durable plan; rerun \`plan\` to refresh it`;
	}
	const canonical = renderRouterMd(
		state.router.tasks,
		state.router.phase,
		state.runStatus.prdPath,
		state.router.identity,
		state.router.archived,
	);
	if (disk !== canonical) {
		return `router.md differs from the durable plan render — a new grant binds the approval to the reviewed bytes, and edited mirror text is never plan input; rerun \`plan\` to refresh the mirror, then approve`;
	}
	return undefined;
}

export type ReceiptAttempt = {
	identity: ReceiptIdentity;
	build: (meta: { key: string; ordinal: number; opId: string; at: number }) => JournalReceiptEvent;
};

export interface StateInput {
	/** Mutate the RouterDoc draft inside the commit. Edits apply last. */
	router?: RouterDocValue | ((d: ChordDraft<RouterDocValue>) => void);
	/** Mutate the RunStatus draft inside the commit. */
	runStatus?: RunStatusDocValue | ((d: ChordDraft<RunStatusDocValue>) => void);
	/** Receipt events (M0-P11) appended to `loop.receipts` in the SAME commit as
	 *  the Router/Run mutation they authorize. An array APPENDS; a mutator gets
	 *  the draft. Authoritative observations/intents ride one harness.commit. */
	receipts?: ReceiptEvent[] | ((d: ChordDraft<ReceiptsDocValue>) => void);
	/** Journal attempts: allocate per-key ordinals and update latest pointers
	 *  inside the same harness transaction as any accompanying state changes. */
	receiptAttempts?: ReceiptAttempt[];
	/** Latest durable checkpoint snapshots for wave stages, appended with their
	 *  per-wave/stage pointer in the same harness transaction. */
	checkpoints?: Checkpoint[];
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

/**
 * Flush the status side-car WITHOUT a storage commit (visibility-only snapshot).
 * Additive UI seam A.1: e.g. the planner marks phase "planning" before its
 * conversation starts, so an attached UI sees the planning state immediately.
 */
export async function flushStatusSnapshot(loopAndLock: LoopAndLock, statusPhase: StatusPhase): Promise<void> {
	const [state, sessionUsage, receipts] = await Promise.all([
		readSessionState(loopAndLock.loop.harness),
		loopAndLock.loop.sessionUsage(),
		loopAndLock.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT),
	]);
	await flushStated(loopAndLock.loop.paths, composeStatusPayload(loopAndLock, {
		routerAfter: state.router,
		statusAfter: state.runStatus,
		statusPhase,
		sessionUsageUsd: sessionUsage.totalUsd,
		unpricedClasses: sessionUsage.unpriced,
		receiptsAfter: receipts ?? { version: 1, events: [] },
	}));
}

interface PayloadInput {
	routerAfter: RouterDocValue;
	statusAfter: RunStatusDocValue;
	statusPhase?: StatusPhase;
	reports?: ReportRow[];
	sessionUsageUsd: number;
	/** Classes whose observed spend cannot be priced (M0-P16); they pause the
	 *  next paid submission — never labeled free. */
	unpricedClasses?: string[];
	receiptsAfter: ReceiptsDocValue;
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
			...(input.unpricedClasses?.length ? { unpricedClasses: input.unpricedClasses } : {}),
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
		planRevision: input.routerAfter.identity?.planRevision,
		receiptStates: input.routerAfter.identity
			? latestReceiptStates(input.receiptsAfter, input.routerAfter.identity.planRevision)
			: undefined,
		checkpoint: input.routerAfter.identity
			? latestFrozenCheckpoint(input.receiptsAfter, input.routerAfter.identity.planRevision)
			: undefined,
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
			if (input.receipts || input.receiptAttempts?.length || input.checkpoints?.length) {
				const recDraft = await tx.doc(ReceiptsDoc);
				if (input.receipts) {
					if (typeof input.receipts === "function") input.receipts(recDraft);
					else recDraft.events.push(...input.receipts);
				}
				if (input.receiptAttempts?.length) {
					const latest = { ...(recDraft.latest ?? {}) };
					for (const attempt of input.receiptAttempts) {
						const key = receiptKey(attempt.identity);
						const recordedOrdinal = recDraft.events.reduce((max, event) =>
							"key" in event && event.key === key ? Math.max(max, event.ordinal) : max, 0);
						const ordinal = Math.max(latest[key]?.ordinal ?? 0, recordedOrdinal) + 1;
						const opId = randomUUID();
						const at = Date.now();
						const event = attempt.build({ key, ordinal, opId, at });
						if (event.key !== key || event.ordinal !== ordinal || event.opId !== opId || event.at !== at) {
							throw new Error("receipt attempt builder changed its allocated key, ordinal, operation id, or timestamp");
						}
						recDraft.events.push(event);
						latest[key] = { opId, ordinal };
					}
					recDraft.latest = latest;
				}
				if (input.checkpoints?.length) {
					const latestCheckpoints = { ...(recDraft.latestCheckpoints ?? {}) };
					for (const checkpoint of input.checkpoints) {
						const key = checkpointKey(checkpoint);
						const recordedOrdinal = recDraft.events.reduce((max, event) =>
							event.kind === "checkpoint" && checkpointKey(event.value) === key ? Math.max(max, event.ordinal) : max, 0);
						const ordinal = Math.max(latestCheckpoints[key]?.ordinal ?? 0, recordedOrdinal) + 1;
						const event: CheckpointEvent = { kind: "checkpoint", opId: randomUUID(), at: Date.now(), ordinal, value: checkpoint };
						recDraft.events.push(event);
						latestCheckpoints[key] = { opId: event.opId, ordinal };
					}
					recDraft.latestCheckpoints = latestCheckpoints;
				}
			}
		},
		BACKGROUND_CONTEXT,
	);

	// Drafts are commit-scoped: read the committed values via snapshots after resolution.
	const [routerAfter, statusAfter, receiptsAfter] = await Promise.all([
		harness.snapshot(RouterDoc, BACKGROUND_CONTEXT),
		harness.snapshot(RunStatusDoc, BACKGROUND_CONTEXT),
		harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT),
	]);
	const wlRead = await harness.snapshot(WaveLogDoc, BACKGROUND_CONTEXT);
	await postCommit(loopAndLock, {
		routerAfter: { ...(routerAfter ?? emptyRouter()) },
		statusAfter: { ...(statusAfter ?? defaultRunStatus()) },
		rowsAfter: wlRead?.rows ?? [],
		receiptsAfter: receiptsAfter ?? { version: 1, events: [] },
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
		receiptsAfter: ReceiptsDocValue;
		input: StateInput;
	},
): Promise<void> {
	const paths: ProjectPaths = loopAndLock.loop.paths;
	// The mirror renders the durable doc INCLUDING its plan identity, so the
	// router.md parity checks (gates, inspect --health) compare like with like.
	const identity: PlanIdentity | undefined = calculated.routerAfter.identity;
	const archived: readonly ArchivedPlanRef[] = calculated.routerAfter.archived ?? [];
	await syncSideCars(
		{ tasks: calculated.routerAfter.tasks, phase: calculated.routerAfter.phase, rows: calculated.rowsAfter, identity, archived },
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
			unpricedClasses: sessionUsage.unpriced,
			receiptsAfter: calculated.receiptsAfter,
		}),
	);
}

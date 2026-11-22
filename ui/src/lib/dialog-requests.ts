/**
 * Dialog request builders shared by App/ActionBar/JobList (§7.2):
 * requests are plain data; App turns a confirmed request into the exact
 * POST /api/actions body (one mutation path, one place).
 */
import type { JobsPayload, ActionBody, ActionAccepted } from "./api.ts";
import type { ActionRequest } from "./actions-model.ts";

/**
 * M0-P06 (A.8): build the Approve & run / Run selected dialog request, capturing
 * the exact grant tuple — {planRevision, selected ids} — at OPEN time. The
 * confirmed request binds to what the human saw here; nothing re-reads the live
 * selection between this moment and the confirm. Absent review identity (legacy
 * plan, sidecars read) or an empty selection throws — the run action is
 * disabled upstream; there is no fallthrough to run-all.
 */
export function describeRunRequest(input: {
	/** The CURRENT plan revision from the readout (undefined when the review identity is missing). */
	revision: string | undefined;
	/** All todo task ids at open time (Run selected narrows these; Run all takes them verbatim). */
	todoIds: readonly string[];
	/** The checked review-card ids at open time (Run selected only). */
	selection: readonly string[];
	/** Already-quarantined count, for the honest “will NOT run” note. */
	quarantinedCount: number;
	/** true = Run selected (checked subset); false = Approve & run (all todo). */
	withTasks: boolean;
}): ActionRequest {
	if (!input.revision) {
		throw new Error("run refused: no plan revision is visible — the plan has no review identity (replan to mint one)");
	}
	const selectedMode = input.withTasks && input.selection.length < input.todoIds.length;
	const ids = (selectedMode ? input.selection.filter((id) => input.todoIds.includes(id)) : input.todoIds).slice();
	if (ids.length === 0) {
		throw new Error("run refused: the selection is empty — check at least one todo task; an empty request never becomes run-all");
	}
	const n = ids.length;
	return {
		kind: selectedMode ? "run-selected" : "run-all",
		title: input.quarantinedCount > 0 ? "Approve & run — with quarantined tasks in the graph" : "Approve & run",
		body:
			`waves run ${selectedMode ? `only the selected ${n} task(s)` : `all ${n} todo task(s)`}, paying provider tokens until each passes or the budget/breakers stop it.` +
			` plan revision ${input.revision} — this approval binds to exactly that revision and these ${n} task(s);` +
			` if the plan is replanned before you confirm, the CLI refuses this request.` +
			(input.quarantinedCount > 0 ? ` ${input.quarantinedCount} already-quarantined task(s) will NOT run (there is no retry-quarantined action in the loop).` : ""),
		confirmLabel: `Approve & run (${n})`,
		revision: input.revision,
		tasks: ids,
	};
}

/**
 * A Stop request naming the target — in precedence order: the newest running
 * UI job; else, since M5-slice-3 (§7.2.1), the attached terminal-started run
 * WHEN its identity verification is ok (pid + command + the Ctrl-C/exit-130
 * promise in the dialog); else the honest unverified variant with the check's
 * plain-words reason (the server re-verifies: nothing is signalled without a
 * full identity match).
 */
export function describeStopTarget(jobs: JobsPayload): ActionRequest {
	const running = jobs.jobs
		.filter((j) => j.status === "running" && j.kind !== "handoff")
		.sort((a, b) => b.startedAt - a.startedAt);
	const target = running[0];
	if (target) {
		return {
			kind: "stop",
			title: "Stop",
			body: `sends SIGINT to job ${target.id} (${target.kind}, pid ${target.pid ?? "?"}) — it closes durable state cleanly, so a later run resumes.`,
			confirmLabel: "Stop job",
		};
	}
	const attached = jobs.attached;
	const stop = attached?.stop;
	if (stop?.ok) {
		return {
			kind: "stop",
			title: "Stop — terminal-started run (verified)",
			body:
				`verifies: pid ${stop.pid} runs this project's installed CLI (${stop.command}) from this project's directory.` +
				" sends Ctrl-C (SIGINT) once; the run stays resumable (exit 130).",
			confirmLabel: "Stop run",
			target: "attached",
			pid: stop.pid,
		};
	}
	if (attached) {
		return {
			kind: "stop",
			title: "Stop — terminal-started run",
			body:
				stop !== undefined
					? `cannot verify pid ${attached.pid} as this project's run loop: ${stop.reason} nothing will be signalled.`
					: `the run holding .orch/lock (pid ${attached.pid}) could not be verified yet (no check came back) — re-open the dialog or stop it from its terminal.`,
			confirmLabel: "Stop run",
		};
	}
	return {
		kind: "stop",
		title: "Stop",
		body: "there is no UI job and no live lock holder right now.",
		confirmLabel: "Stop job",
	};
}

/** Confirmed request → exact POST body. Unknown request kinds stay impossible.
 *
 * M0-P06 (A.8): a run approval confirms EXACTLY the tuple captured when the
 * dialog opened — the request's own revision + tasks, never the live selection
 * and never a fallthrough to all. Empty tuple or absent identity throws (App
 * surfaces the reason); bare `run` is reserved for the explicit resume path.
 */
export function actionRequestToBody(request: ActionRequest, result: { prd?: string; note?: string }): ActionBody {
	switch (request.kind) {
		case "plan":
			return { kind: "plan", ...(result.prd ? { prd: result.prd } : {}) };
		case "run-all":
		case "run-selected": {
			if (!request.revision) {
				throw new Error("run refused: the confirmed dialog carries no plan revision — reopen the review (a plan without a revision cannot be approved)");
			}
			if (!request.tasks || request.tasks.length === 0) {
				throw new Error("run refused: the confirmed selection is empty — there is no fallthrough to run-all; check at least one task");
			}
			return { kind: "run", approve: true, revision: request.revision, tasks: [...request.tasks] };
		}
		case "resume":
			return { kind: "run", resume: true };
		case "stop":
			return request.target === "attached"
				? { kind: "stop", target: "attached", pid: request.pid! }
				: { kind: "stop" };
		case "handoff":
			return { kind: "handoff", note: result.note ?? "" };
		default: {
			const _exhaustive: never = request.kind;
			throw new Error(`unreachable action request kind: ${String(_exhaustive)}`);
		}
	}
}

/**
 * The toast line for an accepted stop: UI jobs name their record; an attached
 * stop names the verified pid it signalled once (§7.2.1).
 */
export function stopAcceptedLine(accepted: ActionAccepted): string {
	if (accepted.jobId !== undefined) return `${accepted.kind} accepted — job ${accepted.jobId}`;
	if (accepted.pid !== undefined) return `${accepted.kind} accepted — SIGINT sent to pid ${accepted.pid}`;
	return `${accepted.kind} accepted`;
}

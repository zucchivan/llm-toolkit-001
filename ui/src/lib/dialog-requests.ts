/**
 * Dialog request builders shared by App/ActionBar/JobList (§7.2):
 * requests are plain data; App turns a confirmed request into the exact
 * POST /api/actions body (one mutation path, one place).
 */
import type { JobsPayload, ActionBody, ActionAccepted } from "./api.ts";
import type { ActionRequest } from "./actions-model.ts";

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

/** Confirmed request → exact POST body. Unknown request kinds stay impossible. */
export function actionRequestToBody(request: ActionRequest, result: { prd?: string; note?: string }, selection: string[]): ActionBody {
	switch (request.kind) {
		case "plan":
			return { kind: "plan", ...(result.prd ? { prd: result.prd } : {}) };
		case "run-all":
			return { kind: "run", approve: true };
		case "run-selected":
			return selection.length
				? { kind: "run", approve: true, tasks: [...selection] }
				: { kind: "run", approve: true };
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

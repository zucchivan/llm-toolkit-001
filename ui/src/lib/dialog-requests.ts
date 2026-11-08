/**
 * Dialog request builders shared by App/ActionBar/JobList (§7.2):
 * requests are plain data; App turns a confirmed request into the exact
 * POST /api/actions body (one mutation path, one place).
 */
import type { ReadoutSnapshot, JobsPayload, ActionBody } from "./api.ts";
import type { ActionRequest } from "./actions-model.ts";

/** A Stop request naming the target (or the honest nothing-running variant). */
export function describeStopTarget(snapshot: ReadoutSnapshot, jobs: JobsPayload): ActionRequest {
	const running = jobs.jobs
		.filter((j) => j.status === "running" && j.kind !== "handoff")
		.sort((a, b) => b.startedAt - a.startedAt);
	const target = running[0];
	return {
		kind: "stop",
		title: "Stop",
		body: target
			? `sends SIGINT to job ${target.id} (${target.kind}, pid ${target.pid ?? "?"}) — it closes durable state cleanly, so a later run resumes.`
			: jobs.attached
				? `the run holding .orch/lock (pid ${jobs.attached.pid}) was NOT launched by this UI — stop it from its terminal; safe attached-stop is deferred until there is a verifiable process identity.`
				: "there is no UI job and no live lock holder right now.",
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
			return { kind: "stop" };
		case "handoff":
			return { kind: "handoff", note: result.note ?? "" };
		default: {
			const _exhaustive: never = request.kind;
			throw new Error(`unreachable action request kind: ${String(_exhaustive)}`);
		}
	}
}

/**
 * Durable task definitions the kit registers in the harness registry
 * (leaf module: imports kit.ts only, so harness.ts can install it at open
 * without import cycles through state/waves).
 */
import { defineTask } from "./kit.ts";
import type { Task } from "./kit.ts";

export type SleepTaskState = { phase: "waiting" } | { phase: "done" };
export interface SleepTaskResult {
	wokeAt: number;
	reason: string;
}
export interface SleepTaskInput {
	until: number;
	reason: string;
}

/** Governor's rate-limit sleep: a durable `sleepUntil` across process restarts. */
export const GovernorSleep: Task<SleepTaskInput, SleepTaskState, SleepTaskResult, object> = defineTask<
	SleepTaskInput,
	SleepTaskState,
	SleepTaskResult,
	object
>({
	name: "kit.sleep",
	version: 1,
	initial: () => ({ phase: "waiting" }),
	phases: {
		waiting: (task, runtime, context) => runtime.sleepUntil(task.input.until, { phase: "done" }, context),
		done: async (task, runtime, context) => {
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: { wokeAt: runtime.now(), reason: task.input.reason } } }),
				context,
			);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

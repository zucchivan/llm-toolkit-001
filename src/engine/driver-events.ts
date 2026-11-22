/** Progress events the driver emits; CLI prints, views persist. */
export type ProgressEvent =
	| { kind: "wave-start"; taskId: string; wave: number; message: string }
	| { kind: "gate-result"; taskId: string; wave: number; passed: boolean; message: string }
	| { kind: "verifier-verdict"; taskId: string; wave: number; verdict: string; message: string }
	| { kind: "task-done"; taskId: string; wave: number; message: string }
	| { kind: "task-quarantined"; taskId: string; wave: number; message: string }
	| { kind: "sleeping"; taskId: string; wave: number; message: string }
	| { kind: "budget-stop"; message: string }
	| { kind: "blocked"; message: string; blockedIds?: string[] }
	// Arrived at a drained queue that still has quarantined tasks — not a plain
	// success; `quarantined` names the task ids that ended in quarantine.
	| { kind: "quarantine-stop"; quarantined: string[]; message: string }
	// M0-P05: the granted subset is fulfilled while the plan still has work
	// outside the grant — selection success, never whole-plan completion.
	| { kind: "selection-complete"; selected: string[]; remainingPlanIds: string[]; message: string }
	| { kind: "complete"; message: string }
	| { kind: "info"; message: string };

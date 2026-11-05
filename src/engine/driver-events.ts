/** Progress events the driver emits; CLI prints, views persist. */
export type ProgressEvent =
	| { kind: "wave-start"; taskId: string; wave: number; message: string }
	| { kind: "gate-result"; taskId: string; wave: number; passed: boolean; message: string }
	| { kind: "verifier-verdict"; taskId: string; wave: number; verdict: string; message: string }
	| { kind: "task-done"; taskId: string; wave: number; message: string }
	| { kind: "task-quarantined"; taskId: string; wave: number; message: string }
	| { kind: "sleeping"; taskId: string; wave: number; message: string }
	| { kind: "budget-stop"; message: string }
	| { kind: "blocked"; message: string }
	| { kind: "complete"; message: string }
	| { kind: "info"; message: string };

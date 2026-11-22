/**
 * The ActionDialog request type lives in a plain .ts module (importable by
 * tsc/Svelte alike): App owns the dialog; ActionBar/JobList produce requests.
 */
export interface ActionRequest {
	kind: "plan" | "run-all" | "run-selected" | "stop" | "resume" | "handoff";
	title: string;
	/** Stated effect; plain words. */
	body: string;
	confirmLabel: string;
	/** plan: editable PRD path (prefilled from config). */
	prd?: string;
	/** handoff note (typed in the dialog). */
	note?: string;
	/** stop target "attached" (M5-slice-3, §7.2.1): the verified pid the POST confirms. */
	target?: "job" | "attached";
	pid?: number;
	/**
	 * run-all/run-selected (M0-P06, A.8): the reviewed plan revision, captured
	 * WHEN the dialog opens. The confirmation binds to exactly this identity —
	 * a replan behind the open dialog leaves the request stale on purpose (the
	 * CLI refuses it under the lock); the live readout is never re-consulted.
	 */
	revision?: string;
	/**
	 * run-all/run-selected (M0-P06, A.8): the exact task ids the dialog
	 * displayed, captured at open time. Empty is refused — there is no
	 * fallthrough to run-all, and `--tasks` is always sent explicitly so the
	 * granted set is the reviewed set, never "whatever is todo now".
	 */
	tasks?: string[];
}

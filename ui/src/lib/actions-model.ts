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
}

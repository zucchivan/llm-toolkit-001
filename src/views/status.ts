/**
 * status view: pretty terminal panel from .orch/status.json (lock held by
 * another process) or directly from storage when WE hold the lock.
 * status --follow polls/watches the side-cars for a live view of `run`.
 */
import { ansi as b } from "../theme.ts";
import type { StatusPayloads } from "../engine/harness.ts";
import { receiptLabelsLine } from "../engine/inspector.ts";

export function renderStatusPanel(payload: StatusPayloads): string {
	if (!payload) return "no status side-car yet (.orch/status.json)";
	const lines: string[] = [];
	lines.push(b.bold(`project: ${payload.root}`));
	lines.push(
		`kit ${payload.kit} · pi-durable ${payload.piDurable} · pid ${payload.lockedByPid ?? "—"} · phase ${payload.phase}`,
	);
	const budgetLine = `budget: $${payload.budget.spentUsd.toFixed(2)} spent of $${payload.budget.sessionCeilingUsd} session (${payload.budget.waveWarnUsd} wave warn)`;
	lines.push(payload.budget.spentUsd >= payload.budget.sessionCeilingUsd ? b.yellow(budgetLine) : budgetLine);
	// M0-P16: the spend figure is a RECORDED estimate — distinguish it from an
	// in-flight bill guarantee on every render, and name the resume action at
	// the stop.
	lines.push(b.dim("recorded spend is an estimate, not a provider bill cap — one admitted in-flight request can overrun"));
	if (payload.budget.unpricedClasses?.length) {
		lines.push(b.yellow(`unpriceable observed spend: ${payload.budget.unpricedClasses.join("; ")} — paid submissions are paused until the roles are priced`));
	}
	if (payload.budget.spentUsd >= payload.budget.sessionCeilingUsd) {
		lines.push(b.yellow("ceiling reached — paid submissions paused; raise budgets.sessionUsd in .orch/config.toml and rerun to resume"));
	}
	lines.push("");
	for (const task of payload.tasks) {
		const glyph = task.status === "done" ? "[x]" : task.status === "quarantined" ? "[!]" : task.status === "in_progress" ? "[~]" : "[ ]";
		lines.push(`${glyph} ${task.id.padEnd(24)} w${task.waveCount} ${b.dim(task.title)}`);
	}
	// P15: observed receipts, never derived from status — the four labels a
	// quarantined row alone does NOT say "discarded", and an approval alone
	// does NOT say "published".
	if (payload.receiptStates) {
		lines.push("", `receipts (${payload.receiptStates.taskId} w${payload.receiptStates.wave}): ${receiptLabelsLine(payload.receiptStates)}`);
	} else if (payload.phase === "wave-running") {
		lines.push("", b.dim("receipts: no receipt yet — before the first checkpoint of this wave"));
	}
	if (payload.checkpoint) {
		const cp = payload.checkpoint;
		lines.push(b.dim(`frozen checkpoint: wave ${cp.wave} · ${cp.baseTree.slice(0, 12)}… → ${cp.candidateTree.slice(0, 12)}… · asOf ${new Date(cp.asOf).toISOString()}`));
	}
	if (payload.alert) lines.push("", b.yellow(`alert: ${payload.alert}`));
	if (payload.message) lines.push("", b.cyan(`STATUS: ${payload.message}`));
	if (payload.reports?.length) {
		lines.push("", b.dim("recent reports:"));
		for (const r of payload.reports.slice(-4)) lines.push(b.dim(`  - ${r.kind}${r.reason ? ` (${r.reason})` : ""}`));
	}
	lines.push("");
	return lines.join("\n");
}

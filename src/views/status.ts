/**
 * status view: pretty terminal panel from .orch/status.json (lock held by
 * another process) or directly from storage when WE hold the lock.
 * status --follow polls/watches the side-cars for a live view of `run`.
 */
import { ansi as b } from "../theme.ts";
import type { StatusPayloads } from "../engine/harness.ts";

export function renderStatusPanel(payload: StatusPayloads): string {
	if (!payload) return "no status side-car yet (.orch/status.json)";
	const lines: string[] = [];
	lines.push(b.bold(`project: ${payload.root}`));
	lines.push(
		`kit ${payload.kit} · pi-durable ${payload.piDurable} · pid ${payload.lockedByPid ?? "—"} · phase ${payload.phase}`,
	);
	const budgetLine = `budget: $${payload.budget.spentUsd.toFixed(2)} spent of $${payload.budget.sessionCeilingUsd} session (${payload.budget.waveWarnUsd} wave warn)`;
	lines.push(payload.budget.spentUsd >= payload.budget.sessionCeilingUsd ? b.yellow(budgetLine) : budgetLine);
	lines.push("");
	for (const task of payload.tasks) {
		const glyph = task.status === "done" ? "[x]" : task.status === "quarantined" ? "[!]" : task.status === "in_progress" ? "[~]" : "[ ]";
		lines.push(`${glyph} ${task.id.padEnd(24)} w${task.waveCount} ${b.dim(task.title)}`);
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

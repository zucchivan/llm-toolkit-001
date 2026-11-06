/**
 * inspect view: renders one `KitReadout` (the visibility seam's whole payload)
 * as a terminal panel. Storage-mode sections render when present; degraded
 * side-car mode notes what storage would add. Pure formatting — no I/O.
 */
import { ansi as b } from "../theme.ts";
import type { KitReadout, InspectSectionName } from "../engine/inspector.ts";
import { INSPECT_SECTIONS } from "../engine/inspector.ts";

export interface InspectRenderOptions {
	/** Positional section filter; empty/absent renders every section. */
	sections?: readonly string[];
	/** Print the health section expanded and the rest compacted. */
	healthOnly?: boolean;
}

const usd = (n: number): string => `$${n.toFixed(n >= 100 ? 0 : 2)}`;
const ms = (n: number): string => (n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

const SEVERITY_GLYPH: Record<string, (t: string) => string> = {
	info: (t) => b.dim(t),
	warn: (t) => b.yellow(t),
	error: (t) => b.red(t),
};

export function renderInspectPanel(r: KitReadout, opts: InspectRenderOptions = {}): string {
	const wanted = (opts.sections ?? []).filter((s): s is InspectSectionName =>
		(INSPECT_SECTIONS as readonly string[]).includes(s),
	);
	const show = (name: InspectSectionName) => wanted.length === 0 || wanted.includes(name);
	const lines: string[] = [];

	lines.push(b.bold(`project: ${r.identity.root}`));
	lines.push(
		`inspect${r.degraded ? " (degraded — side-cars only)" : ""} · kit ${r.identity.kit} · pi-durable ${r.identity.piDurable}` +
			` · ledger pid ${r.identity.lockedByPid ?? "—"} · phase ${r.phase} · ${new Date(r.at).toISOString()}`,
	);
	if (r.degraded && r.degradedReason) lines.push(b.dim(r.degradedReason));
	if (r.current) lines.push(`current: ${r.current.task} wave ${r.current.wave}`);

	if (show("tasks") && !opts.healthOnly) {
		lines.push("", b.dim(`tasks (${r.tasks.length})`));
		for (const task of r.tasks) {
			const glyph = task.status === "done" ? "[x]" : task.status === "quarantined" ? "[!]" : task.status === "in_progress" ? "[~]" : "[ ]";
			const deps = task.dependsOn.length ? ` ← ${task.dependsOn.join(",")}` : "";
			const paths = task.targetPaths.length ? ` (${task.targetPaths.join(", ")})` : "";
			lines.push(`${glyph} ${task.id.padEnd(24)} w${task.waveCount} ${deps}${paths} ${b.dim(task.title)}`);
		}
		if (r.tasks.length === 0) lines.push(b.dim("(no tasks — run `plan` first)"));
	}

	if (show("usage") && !opts.healthOnly) {
		const u = r.usage;
		const ceiling = u.ceilingUsd > 0 ? ` of ${usd(u.ceilingUsd)} ceiling` : "";
		const hit = u.sessionUsd >= u.ceilingUsd && u.ceilingUsd > 0;
		lines.push("", b.dim("usage"), hit ? b.yellow(`  ${usd(u.sessionUsd)} spent${ceiling} — AT CEILING`) : `  ${usd(u.sessionUsd)} spent${ceiling}`);
		lines.push(`  ${u.wavesExecuted} wave(s) · ~${usd(u.spendRateUsdPerWave)}/wave · ${tokensText(u.tokens)} · source: ${u.source}`);
		for (const [key, model] of Object.entries(u.byModel)) {
			lines.push(`  ${key.padEnd(40)} ${usd(model.usd)}${b.dim(` (in ${fmtTokens(model.usage.input)}, out ${fmtTokens(model.usage.output)})`)}`);
		}
		for (const [task, t] of Object.entries(u.byTask).slice(0, 12)) {
			lines.push(`  ${task.padEnd(24)} ${usd(t.usd)}${t.waves ? b.dim(` (${t.waves} wave(s))`) : ""}`);
		}
	}

	if (show("conversations")) {
		lines.push("", b.dim("conversations"));
		const convs = r.storage?.conversations;
		if (!convs) lines.push(b.dim("  (storage-bound: skipped while the lock is elsewhere)"));
		else {
			for (const conv of convs) {
				const who = conv.role === "none" ? b.dim(`conv-${conv.id}`) : `${conv.role}${conv.task ? `:${conv.task}` : ""}`;
				const kinds = Object.entries(conv.byKind)
					.map(([kind, count]) => `${kind.replace("pi.", "")}:${count}`)
					.join(" ");
				lines.push(
					`  #${conv.id} ${who.padEnd(26)} ${conv.entries} entries${conv.entriesTruncated ? "+" : ""}${conv.resets ? ` · ${conv.resets} reset(s)` : ""}` +
						` · ${usd(conv.usage.usd)} · ${kinds}`,
				);
			}
			if (convs.length === 0) lines.push(b.dim("(no durable conversations yet)"));
		}
	}

	if (show("timeline") && !opts.healthOnly) {
		lines.push("", b.dim("timeline"));
		if (r.timeline.length === 0) lines.push(b.dim("(no waves yet)"));
		for (const span of r.timeline) {
			lines.push(
				`  ${new Date(span.startedMs).toISOString().slice(11, 19)} ${span.task.padEnd(24)} w${span.wave}` +
					` · ${ms(span.durationMs)} · ${span.outcome}`,
			);
		}
	}

	if (show("artifacts") && !opts.healthOnly) {
		lines.push("", b.dim(`artifacts (${r.artifacts.length})`));
		for (const artifact of r.artifacts.slice(0, 10)) {
			lines.push(`  ${artifact.kind.padEnd(11)} ${artifact.name} ${b.dim(`${artifact.bytes}b`)}`);
		}
		if (r.artifacts.length > 10) lines.push(b.dim(`  … ${r.artifacts.length - 10} more`));
	}

	if (show("health")) {
		const problems = r.health.filter((check) => !check.ok);
		if (!opts.healthOnly) {
			lines.push("", b.dim("health"));
			if (problems.length === 0) lines.push(`  ${b.green("ok")} — ${r.health.length} check(s) passed (detail: inspect --health)`);
			else for (const problem of problems) lines.push(`  ${severityStyle(problem.severity)(`${problem.severity} ${problem.id}: ${problem.detail}`)}`);
		} else {
			lines.push("", b.dim(`health (${r.health.length} checks, ${problems.length} with findings)`));
			for (const check of r.health) {
				const mark = check.ok ? (check.severity === "warn" ? "!" : "·") : "✗";
				lines.push(`  ${mark} ${check.id.padEnd(16)} ${check.ok ? b.dim(check.detail) : severityStyle(check.severity)(check.detail)}`);
			}
		}
	}

	lines.push("");
	return lines.join("\n");
}

function severityStyle(severity: string): (text: string) => string {
	return SEVERITY_GLYPH[severity] ?? ((text: string) => text);
}

function tokensText(total: number): string {
	return `${fmtTokens(total)} tok`;
}

function fmtTokens(n: number): string {
	if (!Number.isFinite(n)) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(Math.round(n));
}

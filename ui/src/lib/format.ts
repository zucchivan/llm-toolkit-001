/** Formatting + status vocabulary helpers shared by the M0 components. */

export function usd(n: number): string {
	if (!Number.isFinite(n)) return "$0.00";
	return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

/** 12500 → "3m45s" */
export function msDuration(ms: number): string {
	if (ms < 0) ms = 0;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** Wall-clock HH:MM:SS for log rows. */
export function clockTime(ts: number): string {
	if (!Number.isFinite(ts)) return "--:--:--";
	return new Date(ts).toISOString().slice(11, 19);
}

/** Fresh enough for a "last updated" badge. */
export function relativeAge(ms: number): string {
	return ms < 1_000 ? "just now" : `${msDuration(ms)} ago`;
}

export type TaskStatus = "todo" | "in_progress" | "done" | "quarantined";

export const STATUS_GLYPH: Record<string, { glyph: string; label: string }> = {
	todo: { glyph: "○", label: "todo" },
	in_progress: { glyph: "◐", label: "in progress" },
	done: { glyph: "●", label: "done" },
	quarantined: { glyph: "✗", label: "quarantined" },
};

export type HealthLevel = "ok" | "warn" | "error" | "unknown";

/** Roll a readout's health checks up to one dot level (errors first). */
export function healthLevel(readout: { health: { ok: boolean; severity: string }[] } | undefined): HealthLevel {
	if (!readout || !Array.isArray(readout.health)) return "unknown";
	const has = (sev: string): boolean => readout.health.some((check) => !check.ok && check.severity === sev);
	if (has("error")) return "error";
	if (has("warn")) return "warn";
	return "ok";
}

/** Human phase words for the pill (the raw vocab stays visible as tooltip). */
export function phaseLabel(phase: string): string {
	switch (phase) {
		case "empty": return "no plan";
		case "planning": return "planning";
		case "planned": return "planned — review";
		case "running": return "running";
		case "complete": return "complete";
		case "idle": return "idle";
		case "wave-running": return "running";
		default: return phase;
	}
}

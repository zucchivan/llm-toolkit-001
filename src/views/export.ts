/**
 * export: per-project HTML + JSON report, written into .orch/artifacts/.
 * Consumes KitReadout (the visibility seam) instead of re-reading state —
 * one readout, every view. Renderers are pure formatting; no state writes.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../util/fsx.ts";
import type { ProjectPaths } from "../engine/harness.ts";
import type { KitReadout } from "../engine/inspector.ts";

export interface ExportInput {
	readout: KitReadout;
}

export interface ExportPaths {
	jsonFile: string;
	htmlFile: string;
}

export async function writeExports(paths: ProjectPaths, input: ExportInput): Promise<ExportPaths> {
	await mkdir(paths.artifacts, { recursive: true });
	const jsonFile = join(paths.artifacts, "report.json");
	const htmlFile = join(paths.artifacts, "report.html");
	const payload = structuredReport(input);
	await atomicWrite(jsonFile, JSON.stringify(payload, null, 2) + "\n");
	await atomicWrite(htmlFile, renderHtml(payload));
	return { jsonFile, htmlFile };
}

export function structuredReport(input: ExportInput) {
	// report.json = the readout verbatim (plain JSON) + its generation stamp.
	return { generatedAt: new Date().toISOString(), ...input.readout };
}

function renderHtml(report: ReturnType<typeof structuredReport>): string {
	const usage = report.usage as KitReadout["usage"];
	const rows = (report.tasks ?? [])
		.map((t) => `<tr><td>${escapeHtml(String(t.id))}</td><td>${escapeHtml(String(t.status))}</td><td>${t.waveCount}</td><td>${escapeHtml(String(t.title))}</td></tr>`)
		.join("\n");
	const logRows = (report.rows ?? [])
		.slice(-120)
		.map((r) => `<tr><td>${new Date(r.ts).toISOString()}</td><td>${escapeHtml(String(r.kind))}</td><td>${escapeHtml(String(r.task))}${r.wave !== undefined ? `/w${r.wave}` : ""}</td><td>${escapeHtml(String(r.verb))}</td><td>${escapeHtml(String(r.detail ?? ""))}</td></tr>`)
		.join("\n");
	const spans = (report.timeline ?? [])
		.map((s) => `<tr><td>${escapeHtml(String(s.task))}</td><td>w${s.wave}</td><td>${new Date(s.startedMs).toISOString()}</td><td>${(s.durationMs / 1000).toFixed(1)}s</td><td>${escapeHtml(String(s.outcome))}</td></tr>`)
		.join("\n");
	const health = (report.health ?? [])
		.map((check) => `<tr class="${check.ok ? "ok" : String(check.severity)}"><td>${escapeHtml(String(check.id))}</td><td>${check.ok ? "·" : "✗"}</td><td>${escapeHtml(String(check.detail))}</td></tr>`)
		.join("\n");
	const spend = Number(usage?.sessionUsd ?? 0);
	const ceiling = Number(usage?.ceilingUsd ?? 0);
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>export — agent loop report</title><style>
body{font:14px/1.45 system-ui,sans-serif;margin:2rem auto;max-width:960px;color:#222}
h1{font-size:18px}h2{font-size:15px;margin-top:1.6rem}
table{border-collapse:collapse;width:100%;margin:.6rem 0}
td,th{border:1px solid #ddd;padding:4px 8px;text-align:left}
.meta{color:#777}
tr.ok td{color:inherit}
tr.warn td{background:#fff7e0}
tr.error td{background:#ffe0e0}
</style></head><body>
<h1>implementation loop — export</h1>
<p class="meta">generated ${escapeHtml(report.generatedAt)} · kit ${escapeHtml(String(report.identity?.kit ?? "?"))} · pi-durable ${escapeHtml(String(report.identity?.piDurable ?? "?"))} · phase ${escapeHtml(String(report.phase ?? "?"))}${report.degraded ? " · DEGRADED (side-cars only)" : ""} · budget $${spend.toFixed(2)}${ceiling > 0 ? ` of $${ceiling.toFixed(2)}` : ""} · ${(usage?.wavesExecuted ?? 0)} wave(s)</p>
<h2>tasks</h2>
<table><tr><th>task</th><th>status</th><th>waves</th><th>title</th></tr>${rows}</table>
<h2>wave timeline</h2>
<table><tr><th>task</th><th>wave</th><th>started</th><th>duration</th><th>outcome</th></tr>${spans}</table>
<h2>usage by model</h2>
<table><tr><th>provider/model</th><th>USD</th></tr>${Object.entries(usage?.byModel ?? {}).map(([key, model]) => `<tr><td>${escapeHtml(key)}</td><td>$${Number(model.usd).toFixed(4)}</td></tr>`).join("\n")}</table>
<h2>wave log (tail)</h2>
<table><tr><th>ts</th><th>kind</th><th>task/wave</th><th>verb</th><th>detail</th></tr>${logRows}</table>
<h2>health checks</h2>
<table><tr><th>check</th><th>state</th><th>detail</th></tr>${health}</table>
</body></html>`;
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

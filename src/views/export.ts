/**
 * export: per-project HTML + JSON report from the durable storage, written into
 * .orch/artifacts/. Storage may be opened only under the project lock; brief
 * reads from wave-log.jsonl when locked.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../util/fsx.ts";
import { readSessionState } from "../engine/state.ts";
import type { SessionState } from "../engine/state.ts";
import type { StatusPayloads } from "../engine/harness.ts";
import type { ProjectPaths } from "../engine/harness.ts";

export interface ExportInput {
	state: SessionState | null;
	statusPayload: StatusPayloads | null;
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
	return {
		generatedAt: new Date().toISOString(),
		status: input.statusPayload,
		router: input.state?.router,
		runStatus: input.state?.runStatus,
		waveLog: input.state?.rows ?? [],
	};
}


function renderHtml(report: ReturnType<typeof structuredReport>): string {
	const rows = (report.router?.tasks ?? [])
		.map((t) => `<tr><td>${escapeHtml(t.id)}</td><td>${t.status}</td><td>${t.waveCount}</td><td>${escapeHtml(t.title)}</td></tr>`)
		.join("\n");
	const logRows = report.waveLog
		.slice(-120)
		.map((r) => `<tr><td>${new Date(r.ts).toISOString()}</td><td>${r.kind}</td><td>${escapeHtml(r.task)}${r.wave !== undefined ? `/w${r.wave}` : ""}</td><td>${escapeHtml(r.verb)}</td><td>${escapeHtml(r.detail ?? "")}</td></tr>`)
		.join("\n");
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>export — agent loop report</title><style>
body{font:14px/1.45 system-ui,sans-serif;margin:2rem auto;max-width:900px;color:#222}
h1{font-size:18px}table{border-collapse:collapse;width:100%;margin:1rem 0}
td,th{border:1px solid #ddd;padding:4px 8px;text-align:left}
.meta{color:#777}
</style></head><body>
<h1>implementation loop — export</h1>
<p class="meta">generated ${escapeHtml(report.generatedAt)} · router phase ${escapeHtml(String(report.router?.phase ?? "?"))} · budget $${(report.runStatus?.budgetSpentUsd ?? 0).toFixed(2)}</p>
<h2>router doc</h2>
<table><tr><th>task</th><th>status</th><th>waves</th><th>title</th></tr>${rows}</table>
<h2>wave log (tail)</h2>
<table><tr><th>ts</th><th>kind</th><th>task/wave</th><th>verb</th><th>detail</th></tr>${logRows}</table>
</body></html>`;
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}


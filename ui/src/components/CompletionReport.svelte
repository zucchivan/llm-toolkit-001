<script lang="ts">
	/**
	 * Completion report (§8.6): summary — tasks done/quarantined, waves, total
	 * spend vs ceiling, wall-clock span, delivery rows; Run again only when todo
	 * tasks remain. Per-task diff access lands with M2 (diff refs).
	 */
	import type { ReadoutSnapshot, JobsPayload } from "../lib/api.ts";
	import { usd, msDuration, relativeAge } from "../lib/format.ts";
	import type { JobRecord } from "../../server/jobs.ts";

	let { snapshot, jobs, now, onExport, onOpenDiff }: {
		snapshot: ReadoutSnapshot;
		jobs: JobsPayload;
		now: number;
		/** the export button lives here so the report stays monolithic */
		onExport: () => void;
		/** per-task diff access (§8.6) — done/quarantined rows get a button */
		onOpenDiff: (task: string) => void;
	} = $props();

	const readout = $derived(snapshot.readout);
	const done = $derived(readout.tasks.filter((t) => t.status === "done"));
	const quarantined = $derived(readout.tasks.filter((t) => t.status === "quarantined"));
	const todo = $derived(readout.tasks.filter((t) => t.status === "todo"));
	const waves = $derived(readout.timeline.length);
	const firstTs = $derived(readout.rows[0]?.ts);
	const lastTs = $derived(readout.rows.at(-1)?.ts);
	const span = $derived(firstTs !== undefined && lastTs !== undefined ? msDuration(Math.max(0, lastTs - firstTs)) : "—");
	const deliveryRows = $derived(readout.rows.filter((r) => r.kind === "delivery").slice(-4));
	const endedRun = $derived(
		jobs.jobs
			.filter((j) => j.kind === "run" && j.status !== "running")
			.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))[0] as JobRecord | undefined,
	);
	const exportable = $derived(readout.artifacts.some((a) => a.name.startsWith("report.")));
</script>

<section class="panel">
	<div class="panel-header">
		<span>completion report</span>
		<span class="badge ph-complete">
			{#if quarantined.length}stopped short — {quarantined.length} quarantined{:else}complete{/if}
		</span>
		{#if endedRun && endedRun.endedAt}
			<span class="muted" style="font-size:11px">run ended {relativeAge(Math.max(0, now - endedRun.endedAt))} ago (exit {endedRun.exitCode ?? "?"})</span>
		{/if}
	</div>

	<div class="report-grid">
		<div class="stat"><div class="muted">tasks done</div><div class="big mono">{done.length}</div></div>
		<div class="stat"><div class="muted">quarantined</div><div class="big mono {quarantined.length ? 'bad-text' : ''}">{quarantined.length}</div></div>
		<div class="stat"><div class="muted">waves</div><div class="big mono">{waves}</div></div>
		<div class="stat"><div class="muted">spend</div><div class="big mono">{usd(readout.usage.sessionUsd)} <span class="muted" style="font-size:12px">/ {usd(readout.usage.ceilingUsd)}</span></div></div>
		<div class="stat"><div class="muted">wall clock</div><div class="big mono">{span}</div></div>
		<div class="stat"><div class="muted">delivery</div><div class="big mono" style="font-size:15px">{deliveryRows.length ? `${deliveryRows.length} row(s)` : "none"}</div></div>
	</div>

	{#if deliveryRows.length}
		<pre class="joblog mono" style="max-height:120px">{deliveryRows.map((r) => `${r.verb} — ${r.detail ?? ""}`).join("\n")}</pre>
	{/if}

	<!-- §8.6 per-task diff access: terminal rows carry their diffs; todo rows stay silent -->
	<table class="grid" aria-label="terminal tasks — status, id, title, waves, spend, diff" style="margin-top:6px">
		<thead>
			<tr>
				<th scope="col" style="width:110px">status</th>
				<th scope="col" style="width:170px">id</th>
				<th scope="col">title</th>
				<th scope="col" style="width:56px">waves</th>
				<th scope="col" style="width:70px">spend</th>
				<th scope="col" style="width:96px">diff</th>
			</tr>
		</thead>
		<tbody>
			{#each [...quarantined, ...done] as task (task.id)}
				<tr>
					<td class="st-{task.status}">
						{task.status === "done" ? "✓ done" : "⨯ quarantined"}
					</td>
					<td class="mono">{task.id}</td>
					<td>{task.title}</td>
					<td class="mono">{task.waveCount}</td>
					<td class="mono muted" title="per-task spend (usage joins in storage mode)">{usd(readout.usage.byTask[task.id]?.usd ?? 0)}</td>
					<td class="mono">
						{#if task.diff}
							<button class="btn tiny" onclick={() => onOpenDiff(task.id)} title={task.status === "quarantined" ? "quarantine patch + stats (tree rolled back)" : `cumulative since baseline, ${task.waveCount} wave(s)`}>
								{task.status === "quarantined" ? "patch (rolled back)" : "diff"}
							</button>
						{:else}
							<span class="muted">—</span>
						{/if}
					</td>
				</tr>
			{:else}
				<tr><td colspan="6" class="muted" style="padding:12px">no terminal tasks yet</td></tr>
			{/each}
		</tbody>
	</table>

	<div style="display:flex; gap:10px; align-items:center; padding:12px">
		<button class="btn" onclick={onExport} title="write .orch/artifacts/report.json + report.html">Export report</button>
		{#if exportable}<span class="muted" style="font-size:11.5px">report.json / report.html exist in .orch/artifacts</span>{/if}
		{#if todo.length}
			<span class="muted" style="font-size:11.5px">· {todo.length} todo task(s) remain — Approve &amp; run picks up exactly where it stopped</span>
		{/if}
	</div>
</section>

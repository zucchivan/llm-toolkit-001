<script lang="ts">
	/**
	 * JobsList (§9): UI-launched jobs + the attached terminal-started run, with
	 * reattach/stale states and the log tail on demand. Stop goes through the
	 * ActionBar's dialog; this list is the memory of what this UI has done.
	 */
	import type { JobsPayload } from "../lib/api.ts";
	import type { JobRecord } from "../../server/jobs.ts";
	import { fetchJobLog } from "../lib/api.ts";
	import { relativeAge } from "../lib/format.ts";

	let { jobs, now, onStop, latestDiffTask, onOpenDiff }: {
		jobs: JobsPayload;
		now: number;
		onStop: () => void;
		/** newest diff-bearing artifact's task id (from the readout); undefined when none */
		latestDiffTask?: string;
		onOpenDiff: (task: string) => void;
	} = $props();

	let expanded = $state<string | undefined>(undefined);
	let logs = $state<Record<string, string[]>>({});

	const records = $derived(jobs.jobs.slice(0, 10)); /* newest ten; history stays on disk */

	async function toggle(id: string): Promise<void> {
		expanded = expanded === id ? undefined : id;
		if (expanded !== id) return;
		if (logs[id]) return;
		try {
			const res = await fetchJobLog(id, 40);
			logs = { ...logs, [id]: res.lines };
		} catch (err) {
			logs = { ...logs, [id]: [`(log fetch failed: ${(err as Error).message})`] };
		}
	}

	function chipFor(job: JobRecord): { text: string; cls: string; title: string } {
		switch (job.status) {
			case "running":
				return { text: "running", cls: "chip-running", title: `pid ${job.pid ?? "?"} · started ${new Date(job.startedAt).toISOString()}` };
			case "stale":
				return { text: "stale", cls: "chip-stale", title: "process gone without an exit record — the run died with its server; durable state resumes on the next run" };
			case "exited":
				return { text: `exit ${job.exitCode ?? "?"}`, cls: (job.exitCode ?? 1) === 0 ? "chip-ok" : (job.exitCode === 42 ? "chip-sleep" : "chip-warn"), title: `exit code ${job.exitCode}` };
			case "failed":
				return { text: `failed (${job.exitCode ?? "?"})`, cls: "chip-bad", title: `exit code ${job.exitCode} — see the log` };
			default:
				return { text: job.status, cls: "", title: "" };
		}
	}

	const verbLabel: Record<string, string> = {
		plan: "Plan",
		run: "Run",
		verify: "Verify",
		export: "Export",
		handoff: "Handoff",
	};
</script>

<section class="panel">
	<div class="panel-header">
		<span>jobs</span>
		<span class="muted">{jobs.jobs.length} record(s) in .orch/ui/jobs</span>
	</div>
	<div style="padding:4px 0">
			{#if latestDiffTask}
				<div class="jobrow" class:job-cur={false}>
					<span title="the newest persisted task diff in .orch/artifacts">diffs</span>
					<button class="btn tiny" onclick={() => onOpenDiff(latestDiffTask)} title={`open the diff drawer for task ${latestDiffTask} (the freshest done/quarantined diff)`}>
						latest diff · {latestDiffTask}
					</button>
				</div>
			{/if}
			{#if jobs.attached}
				{@const stopCheck = jobs.attached.stop}
				<div class="jobrow">
					<span class="badge attached" title={`a run holds .orch/lock (pid ${jobs.attached.pid}) but this UI did not launch it${stopCheck?.ok ? " — its identity verifies (§7.2.1); Stop sends one Ctrl-C (SIGINT), exit 130, resumable" : " — its identity must verify (§7.2.1) before Stop is offered"}`}>attached · not launched here</span>
				<span class="mono">{verbLabel["run"] ?? ""} (terminal)</span>
				<span class="mono muted">pid {jobs.attached.pid}</span>
				<span class="muted">{jobs.attached.phase}</span>
				{#if stopCheck?.ok}
					<span style="margin-left:auto; display:flex; gap:6px">
						<button class="btn tiny stop" onclick={onStop} title={`verified — sends Ctrl-C (SIGINT) once: ${stopCheck.command}; the run stays resumable (exit 130)`}>stop (verified)</button>
					</span>
				{:else}
					<span class="muted" style="margin-left:auto" title={stopCheck?.reason ?? "its identity is not verified yet (the check is read-only) — stop it from its terminal"}>⨯ stop unavailable{stopCheck?.ok === false ? " (not verified)" : " (checking identity)"}</span>
				{/if}
			</div>
		{/if}
		{#each records as job (job.id)}
			{@const chip = chipFor(job)}
			<div class="jobrow" class:job-cur={job.status === "running"}>
				<span class="chip {chip.cls}" title={chip.title ?? (job.tail ? `\n${job.tail.join("\n")}` : "")}>{chip.text}</span>
				<span class="mono">{verbLabel[job.kind] ?? job.kind}</span>
				<span class="mono muted" style="font-size:11px">{job.id}</span>
				<span class="muted" style="font-size:11px">{relativeAge(Math.max(0, now - job.startedAt))}</span>
				{#if job.tail?.length}
					<span class="muted jobreason" title={job.tail.join("\n")}>{job.tail[0]!.slice(0, 80)}</span>
				{/if}
				<span style="margin-left:auto; display:flex; gap:6px">
					<button class="btn tiny" onclick={() => toggle(job.id)}>{expanded === job.id ? "hide log" : "log"}</button>
					{#if job.status === "running" && job.kind !== "handoff"}
						<button class="btn tiny stop" onclick={onStop}>stop</button>
					{/if}
				</span>
			</div>
			{#if expanded === job.id && logs[job.id]}
				<pre class="joblog mono" style="max-height:240px">{(logs[job.id] ?? []).join("\n")}</pre>
			{/if}
		{:else}
			<div class="muted" style="padding:10px 12px">no jobs yet — Plan / Run / Verify / Export each leave a record here (kept last 50 · 14 days)</div>
		{/each}
	</div>
</section>

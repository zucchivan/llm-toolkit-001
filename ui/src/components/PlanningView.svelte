<script lang="ts">
	/**
	 * Planning state (§8.2): live "still working" + elapsed (from the plan job's
	 * startedAt; attach case shows an unknown-plan note). Log tail loads once on
	 * job exit — no browser polling loop (§13).
	 */
	import type { JobRecord } from "../../server/jobs.ts";
	import { fetchJobLog } from "../lib/api.ts";
	import { msDuration } from "../lib/format.ts";

	let { job, now, attachedElsewhere = false }: {
		job: JobRecord | undefined;
		now: number;
		/** terminal-started plan: no job record to time. */
		attachedElsewhere?: boolean;
	} = $props();

	let lines = $state<string[] | undefined>(undefined);
	let lastLogJobId = $state<string | undefined>(undefined);

	$effect(() => {
		const ended = job && (job.status === "exited" || job.status === "failed" || job.status === "stale");
		if (!ended || job.id === lastLogJobId) return;
		lastLogJobId = job.id;
		void fetchJobLog(job.id, 40)
			.then((r) => (lines = r.lines))
			.catch(() => (lines = ["(log fetch failed)"]));
	});

	const title = $derived(!attachedElsewhere && job ? `${job.kind} job ${job.id}` : "the planner is working");
	const elapsedLabel = $derived(!attachedElsewhere && job ? msDuration(Math.max(0, now - job.startedAt)) : "?");
</script>

<section class="panel planning">
	<div class="panel-header"><span>planning</span><span class="badge ph-planning">in progress</span></div>
	<div style="padding:24px 16px; display:flex; gap:14px; align-items:center">
		<span class="pulse" aria-hidden="true"></span>
		<div>
			<div style="font-size:14px">{title}</div>
			<div class="muted" style="margin-top:2px">
				{attachedElsewhere
					? "a run you did not launch holds the lock (planning flush arrived from .orch/status.json)"
					: `elapsed ${elapsedLabel} · the planner writes the plan, then stops for review here`}
			</div>
		</div>
	</div>
	{#if lines}
		<pre class="joblog mono" style="max-height:220px">{lines.join("\n")}</pre>
	{/if}
</section>

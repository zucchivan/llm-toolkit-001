<script lang="ts">
	import type { ReadoutSnapshot } from "../lib/api.ts";
	import { msDuration, phaseLabel, relativeAge, healthLevel } from "../lib/format.ts";
	import { healthAlertText } from "../lib/view.ts";
	import type { JobRecord } from "../../server/jobs.ts";
	import BudgetBar from "./BudgetBar.svelte";
	import NotifyToggle from "./NotifyToggle.svelte";

	let { snapshot, now, connected, sleepTitle = undefined, activeJob = undefined, attachedPid = undefined, healthOpen = false, onToggleHealth }: {
		snapshot: ReadoutSnapshot;
		now: number;
		connected: boolean;
		/** sleep banner text (until countdown) when a provider-reset sleep is armed. */
		sleepTitle?: string;
		/** newest running non-handoff job (pill shows what the UI itself is doing). */
		activeJob?: JobRecord | undefined;
		/** A terminal-started run's holder pid; absent when the run is our own job. */
		attachedPid?: number | undefined;
		/** Whether the health panel below is open (the dot toggles it, §7.1). */
		healthOpen?: boolean;
		onToggleHealth: () => void;
	} = $props();

	const readout = $derived(snapshot.readout);
	const phaseClass = $derived(`ph-${readout.phase.replace(/[^a-z-]/g, "")}`);
	const live = $derived(readout.live);
	const liveMs = $derived(live ? Math.max(0, now - live.startedAt) : 0);
	const level = $derived(healthLevel(readout));
	const age = $derived(Math.max(0, now - snapshot.at));
	const failing = $derived(readout.health.filter((c) => !c.ok));
	const failingTitle = $derived(failing.length ? failing.map((c) => `${c.severity}: ${c.detail}`).join("\n") : "all checks pass");
	const alertText = $derived(healthAlertText(readout.health));
	const quarantined = $derived(readout.tasks.filter((t) => t.status === "quarantined"));
</script>

<header style="padding:14px 0 10px">
	<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
		<strong style="font-size:14px">llm-toolkit-001 · ui</strong>
		<span class="badge {phaseClass}" title={`status.json phase: ${readout.phase}`}>{phaseLabel(readout.phase)}</span>

		<span class="badge mode-{snapshot.mode}" title={snapshot.mode === "storage" ? "full readout: the lock was free" : "degraded: the engine owns .orch/lock — side-cars only"}>
			{snapshot.mode === "storage" ? "storage" : "sidecars (degraded)"}
		</span>

		{#if activeJob}
			<span class="badge chip-running" title={`job ${activeJob.id} — CLI ${activeJob.kind}`}>
				{activeJob.kind} · pid {activeJob.pid ?? "…"}
			</span>
		{/if}

		{#if attachedPid !== undefined && attachedPid !== activeJob?.pid}
			<span class="badge attached" title={`a run holds .orch/lock (pid ${attachedPid}) but this UI did not launch it`}>attached · pid {attachedPid}</span>
		{/if}

		<span
			class="badge"
			title={connected ? "SSE stream connected" : "SSE stream disconnected — retrying"}
			style={connected ? "" : "color:var(--warn)"}
		>SSE {connected ? "live" : "down"}</span>
	</div>

	<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px">
		<span style="color:var(--muted)" class="mono">{readout.identity.root}</span>
		<span class="muted">kit {readout.identity.kit} · pi-durable {readout.identity.piDurable} · seam {readout.seam}</span>

		{#if live}
			<span class="badge" title={`wave started ${new Date(live.startedAt).toISOString()}`}>
				▶ {live.task} #w{live.wave} · <span style="font-family:var(--font-mono)">{msDuration(liveMs)}</span>
			</span>
		{/if}

		<span class="badge" title={readout.degraded ? "degraded read: conversation detail + per-task usage joins are skipped" : `usage source: ${readout.usage.source}`}>
			waves {readout.usage.wavesExecuted} · {readout.usage.source === "storage" ? "storage joins" : "side-car estimates"}
		</span>

		<button
			class="dot-btn"
			onclick={onToggleHealth}
			aria-expanded={healthOpen}
			aria-label="toggle the health panel — errors and warnings first"
			title={`${failingTitle} — click to open/close the health panel (#/health)`}
		>
			<span class="dot {level}"></span>
		</button>
		<span class="muted alert-text" style="font-size:11.5px" title={failingTitle}>{alertText ?? "health ok"}</span>
		<span class="muted" style="font-size:11.5px" title="readout at {new Date(snapshot.at).toISOString()}">updated {relativeAge(age)}</span>

		<!-- §18 (ui 0.10.0): the opt-in browser-notification toggle — see NotifyToggle. -->
		<NotifyToggle />
	</div>

	<BudgetBar usage={readout.usage} />

	{#if sleepTitle}
		<div class="banner ph-sleeping" style="margin-top:8px" title="exit 42 — the durable sleep task resumes on the next run">
			<strong>⏾ sleeping</strong> {sleepTitle}
		</div>
	{/if}

	{#if readout.degraded && readout.degradedReason}
		<div class="banner">
			<strong>degraded read:</strong> {readout.degradedReason} — conversation detail and per-task usage joins are hidden; the live strip and event tail stay truthful (last updated badge above).
		</div>
	{/if}

	{#if quarantined.length > 0 && !readout.live}
		<!-- §8.4: the rollback fact where the operator cannot miss it; the drawer carries cause + patch + baseline. Note the router phase can stay "running" after an exited run — the live wave is the freshness signal. -->
		<div class="banner error">
			<strong>quarantined:</strong> {quarantined.length} task(s) exhausted their waves and the tree was rolled back to each baseline — evidence in their diff drawers ({quarantined.map((t) => t.id).join(", ")}); dependent tasks are blocked-by-dependency until a re-plan.
		</div>
	{/if}

	{#if readout.health.some((c) => !c.ok && c.severity === "error")}
		<!-- a health error (e.g. pin mismatch) is a real alert banner, not just a dot (§7.1) -->
		<div class="banner error">
			<strong>health:</strong> {alertText}
		</div>
	{/if}
</header>

<script lang="ts">
	/**
	 * HealthPanel (§7.1/§9): collapsible, always-available panel over the
	 * readout's health checks — failing checks (errors then warnings) first,
	 * skipped-in-degraded checks labeled, every row glyph + severity + detail.
	 * The header's health dot toggles it; `#/health` deep-links it (App owns
	 * `open` + the hash).
	 */
	import { orderedHealthChecks } from "../lib/view.ts";
	import type { HealthCheck } from "../../../src/engine/inspector.ts";

	let { health, open = false, onToggleHealth }: { health: HealthCheck[] | undefined; open?: boolean; onToggleHealth: () => void } = $props();

	const items = $derived(orderedHealthChecks(health));
	const failing = $derived(items.filter((i) => !i.check.ok));
	const skipping = $derived(items.filter((i) => i.check.ok && i.skip));
</script>

<section class="panel healthpanel">
	<button
		class="panel-header healthpanel-toggle"
		type="button"
		onclick={onToggleHealth}
		aria-expanded={open}
		aria-controls="health-rows"
		title="health checks (inspect --health semantics) — errors and warnings first"
	>
		<span>{open ? "▾" : "▸"} health · {health?.length ?? 0} check(s)</span>
		<span class="muted">{failing.length > 0 ? `${failing.length} failing` : skipping.length > 0 ? `${skipping.length} skipped · rest pass` : "all pass"}</span>
	</button>
	{#if open}
		<div id="health-rows" style="padding:4px 0; max-height:420px; overflow:auto">
			{#each items as item (item.check.id + "|" + String(item.check.ok))}
				<div class="status-mono healthrow">
					<span class="dot {item.check.ok ? (item.check.severity === "warn" ? "warn" : "ok") : "error"}" aria-hidden="true"></span>
					<span class="mono" style="flex:0 0 128px; color:var(--accent)">{item.check.id}</span>
					<span class="healthchip healthchip-{item.check.ok ? (item.skip ? "skip" : "ok") : item.check.severity}">{item.skip ? "skipped" : item.check.ok ? (item.check.severity === "warn" ? "warning" : "pass") : item.check.severity}</span>
					<span class="mono" style="flex:1; white-space:pre-wrap">{item.check.detail}</span>
				</div>
			{:else}
				<div class="muted status-mono" style="padding:10px 12px">no health checks in this readout yet</div>
			{/each}
		</div>
	{/if}
</section>

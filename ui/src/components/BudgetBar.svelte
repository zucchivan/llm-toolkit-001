<script lang="ts">
	/**
	 * BudgetBar (§9): read-only spend bar — session spent vs ceiling, the
	 * wave-warn threshold + spend-rate line, and the per-model breakdown coming
	 * straight from the readout's usage (no new endpoints; §5 no editing).
	 */
	import { usd } from "../lib/format.ts";
	import { budgetBarData } from "../lib/view.ts";
	import type { KitUsage } from "../../../src/engine/inspector.ts";

	let { usage }: { usage: KitUsage } = $props();

	const bar = $derived(budgetBarData(usage));
</script>

<div class="budgetbar">
	<div
		class="budgetbar-track"
		role="progressbar"
		aria-label={`budget: ${usd(usage.sessionUsd)} spent of ${usd(usage.ceilingUsd)} session ceiling`}
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={Math.round(bar.spentPct)}
		title={`session spend ${usd(usage.sessionUsd)} of ${usd(usage.ceilingUsd)} ceiling`}
	>
		<div class="budgetbar-fill {bar.over ? 'budgetbar-over' : ''}" style={`width:${bar.spentPct}%`}></div>
	</div>
	<div class="budgetbar-line muted">
		<span class="mono" title="session spend so far (usage source: {usage.source})">
			{bar.over ? "⚠ " : ""}{usd(usage.sessionUsd)} <span class="muted">/ {usd(usage.ceilingUsd)} ceiling</span>
		</span>
		<span class="mono" title="the governor warns a wave whose spend exceeds this; the rate averages a wave's spend so far">
			wave-warn {usd(usage.warnUsdPerWave)} · rate {usd(usage.spendRateUsdPerWave)}/wave
		</span>
	</div>
	{#if bar.models.length > 0}
		<div class="budgetbar-models">
			{#each bar.models as m (m.model)}
				<div class="budgetbar-model" title={`${m.model} spent ${usd(m.usd)} (${Math.round(m.share * 100)}% of the session spend)`}>
					<span class="mono">{m.model}</span>
					<span class="budgetbar-model-track" aria-hidden="true"><span style={`width:${Math.max(2, Math.round(m.share * 100))}%`}></span></span>
					<span class="mono muted">{usd(m.usd)}</span>
				</div>
			{/each}
		</div>
	{/if}
</div>

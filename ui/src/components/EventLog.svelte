<script lang="ts">
	/**
	 * EventLog (§7.1): wave-log tail — newest last, filter by task/kind/text,
	 * pause (freezes the visible tail; held-back rows counted), autoscroll.
	 * The filter input registers itself so the global "/" shortcut can focus it
	 * (lib/shortcuts.ts).
	 */
	import type { WaveRow } from "../../../src/engine/infos.ts";
	import { clockTime } from "../lib/format.ts";
	import { filterWaveRows } from "../lib/view.ts";
	import { registerEventFilter } from "../lib/shortcuts.ts";

	let { rows }: { rows: WaveRow[] } = $props();

	const MAX_VISIBLE = 300;
	let paused = $state(false);
	let frozen = $state<WaveRow[]>([]);
	let query = $state("");

	/** Pause freezes the visible tail (captures the current rows); new rows are
	    held back while paused and appear when the tail resumes. */
	function setPaused(next: boolean): void {
		paused = next;
		if (paused) frozen = [...rows];
	}

	const filtered = $derived(filterWaveRows(paused ? frozen : rows, query));
	const heldBack = $derived(paused ? Math.max(0, rows.length - frozen.length) : 0);
	const visible = $derived.by(() => (filtered.length > MAX_VISIBLE ? filtered.slice(-MAX_VISIBLE) : filtered));

	// Event log tail: newest last, auto-scrolled on update (§11.3 style).
	let container: HTMLDivElement | undefined = $state(undefined);
	let stick = $state(true);
	const onScroll = (): void => {
		if (!container) return;
		stick = container.scrollHeight - container.scrollTop - container.clientHeight < 24;
	};
	$effect(() => {
		void visible.length;
		if (container && stick) container.scrollTop = container.scrollHeight;
	});

	// "/" focus support: hand the filter input to the global shortcut registry.
	let filterInput: HTMLInputElement | undefined = $state(undefined);
	$effect(() => {
		if (!filterInput) return;
		return registerEventFilter(filterInput);
	});

	const taskId = (row: WaveRow): string =>
		row.wave !== undefined ? `${row.task} #w${row.wave}` : row.task;

	const rowLabel = (row: WaveRow): string => {
		if (row.kind === "wave") {
			if (row.verb === "start") return "▸ wave start";
			if (row.verb === "end") return `▸ wave end — ${row.detail ?? ""}`;
		}
		const bits = [row.kind, row.verb];
		if (row.detail) bits.push(row.detail);
		if (row.reason) bits.push(`(${row.reason})`);
		return bits.filter(Boolean).join(" — ");
	};
</script>

<section class="panel eventlog">
	<div class="panel-header">
		<span>event log · wave-log.jsonl tail</span>
		<span class="muted">{filtered.length} row(s){filtered.length > MAX_VISIBLE ? ` · last ${MAX_VISIBLE} shown` : ""}{paused ? ` · paused${heldBack > 0 ? ` (+${heldBack} held back)` : ""}` : ""}</span>
	</div>
	<div style="display:flex; gap:8px; align-items:center; padding:6px 12px; border-bottom:1px solid var(--border)">
		<input
			bind:this={filterInput}
			class="input input-sm mono"
			type="text"
			placeholder="filter — task, kind, text · press / to focus"
			aria-label="filter event log by task, kind, or text"
			aria-describedby="event-filter-hint"
			spellcheck="false"
			bind:value={query}
		/>
		<span id="event-filter-hint" class="muted" style="font-size:10.5px">/ to focus</span>
		<button class="btn tiny" onclick={() => setPaused(!paused)} aria-pressed={paused} title={paused ? "resume: apply new rows (held-back rows appear)" : "pause: freeze the tail; new rows are held back"}>
			{paused ? "resume" : "pause"}
		</button>
		{#if query || paused}
			<button class="btn tiny" onclick={() => { query = ""; setPaused(false); }} title="clear the filter and resume">reset</button>
		{/if}
	</div>
	<div bind:this={container} onscroll={onScroll} role="log" aria-label="wave log tail" aria-live={paused ? "off" : "polite"}
		style="overflow:auto; max-height:480px; padding:4px 0;"
	>
		{#each visible as row, i (i)}
			<div class="status-mono" style="display:flex; gap:10px; padding:2px 12px;">
				<span class="mono muted" style="flex:0 0 66px">{clockTime(row.ts)}</span>
				<span class="mono" style="flex:0 0 190px; color: var(--accent)">{taskId(row)}</span>
				<span class="mono" style="white-space:pre-wrap">{rowLabel(row)}</span>
			</div>
		{:else}
			<div class="muted status-mono" style="padding:10px 12px">
				{#if paused}
					tail frozen — new rows are held back; resume applies them
				{:else if query}
					no rows match “{query}” — clear the filter to see the full tail
				{:else}
					no wave-log rows yet — the paper trail appears with the first plan/run
				{/if}
			</div>
		{/each}
	</div>
</section>

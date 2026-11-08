<script lang="ts">
	/**
	 * ConversationDrawer (§7.5 + §18 fast-follow, M4-a): the read-only view of
	 * one conversation — the stage-1 summary (role, task + targetPaths, entry
	 * counts + byKind, resets, compactions, tool rounds, truncation note,
	 * USD + tokens) PLUS the stage-2 transcript excerpt (Appendix A.5): a
	 * bounded, kind-labeled entry list (tool results collapsed; the 2,000-entry
	 * window + per-entry 4 KiB cap say so when they bite). It fetches its own
	 * excerpt like DiffViewer does; App owns the drawer shell (Esc, close, hash).
	 */
	import { usd, clockTime } from "../lib/format.ts";
	import { fetchConversationEntries } from "../lib/api.ts";
	import { excerptErrorState, entryKindLabel, type ExcerptState } from "../lib/view.ts";
	import type { ConvSummary } from "../../../src/engine/inspector.ts";

	let { conv }: { conv: ConvSummary } = $props();

	let excerpt = $state<ExcerptState>({ kind: "loading" });
	/** Tool-result bodies start collapsed; the operator expands the ones that matter. */
	let expanded = $state<Record<number, boolean>>({});

	async function load(): Promise<void> {
		excerpt = { kind: "loading" };
		try {
			const payload = await fetchConversationEntries(conv.id);
			excerpt = { kind: "ready", entries: payload.entries, truncated: payload.truncated };
		} catch (err) {
			excerpt = excerptErrorState((err as Error).message);
		}
	}

	// (Re)load whenever the drawer's conversation changes (App keys the mount).
	$effect(() => {
		void conv.id;
		void load();
	});

	function toggle(id: number): void {
		expanded = { ...expanded, [id]: !expanded[id] };
	}
</script>

<div class="convdetail">
	<div class="diffmeta">
		<span class="chip chip-role-{conv.role}">{conv.role}</span>
		<span class="mono muted">conversation #{conv.id}</span>
		{#if conv.task}
			<span class="mono">task <strong>{conv.task}</strong></span>
		{:else}
			<span class="mono muted">{conv.role === "planner" ? "the planning conversation" : conv.role === "verifier" ? "a verification conversation" : "not tied to a task"}</span>
		{/if}
		<span class="mono" style="margin-left:auto">{usd(conv.usage.usd)} · {conv.usage.totalTokens.toLocaleString("en-US")} tokens</span>
	</div>

	{#if conv.entriesTruncated}
		<div class="banner">
			<strong>counts are a floor, not exact.</strong> the entry scan hit its page cap
			(≥{conv.entries} entries); the truth is at least this, maybe more.
		</div>
	{/if}

	<div class="report-grid" style="padding:0">
		<div class="stat"><div class="muted">entries</div><div class="big mono">{conv.entriesTruncated ? "≥" : ""}{conv.entries}</div></div>
		<div class="stat"><div class="muted">tool rounds</div><div class="big mono">{conv.toolRounds}</div></div>
		<div class="stat"><div class="muted">resets</div><div class="big mono">{conv.resets}</div></div>
		<div class="stat"><div class="muted">compactions</div><div class="big mono">{conv.compactions}</div></div>
	</div>

	{#if Object.keys(conv.byKind).length > 0}
		<div>
			<div class="muted" style="font-size:11px; letter-spacing:0.4px; text-transform:uppercase; margin-bottom:4px">entries by kind</div>
			{#each Object.entries(conv.byKind).sort(([a], [b]) => a.localeCompare(b)) as [kind, n] (kind)}
				<div class="diffrow status-mono">
					<span class="mono" style="flex:0 0 200px">{kind}</span>
					<span class="mono muted">{n}</span>
				</div>
			{/each}
		</div>
	{/if}

	{#if conv.targetPaths && conv.targetPaths.length > 0}
		<div>
			<div class="muted" style="font-size:11px; letter-spacing:0.4px; text-transform:uppercase; margin-bottom:4px">target paths</div>
			{#each conv.targetPaths as path (path)}
				<div class="mono status-mono">{path}</div>
			{/each}
		</div>
	{/if}

	<div>
		<div class="muted" style="font-size:11px; letter-spacing:0.4px; text-transform:uppercase; margin-bottom:4px">
			transcript excerpt <span class="mono" style="text-transform:none">(bounded, read-only — Appendix A.5)</span>
		</div>
		{#if excerpt.kind === "loading"}
			<div class="muted status-mono">reading the transcript excerpt…</div>
		{:else if excerpt.kind === "lock-busy"}
			<div class="banner" data-testid="excerpt-lock-busy">
				<strong>conversation detail returns when the lock is free — a run is live.</strong>
				the excerpt fills itself in once the storage snapshot is back; nothing to press, no reload needed.
			</div>
		{:else if excerpt.kind === "error"}
			<div class="banner">
				<strong>the transcript excerpt didn't load.</strong>
				<span class="mono">{excerpt.message}</span>
			</div>
		{:else}
			{#if excerpt.truncated}
				<div class="banner" data-testid="excerpt-truncated">
					<strong>bounded excerpt.</strong> the transcript is longer than the 2,000-entry cap —
					older entries were cut from this window. the cap is the contract in v1 (no pagination);
					per-entry text is capped at 4 KiB too.
				</div>
			{/if}
			{#if excerpt.entries.length === 0}
				<div class="muted status-mono">no entries in this conversation yet.</div>
			{:else}
				<div class="conventries">
					{#each excerpt.entries as entry (entry.id)}
						<div class="conventry">
							<div class="conventry-head mono">
								<span class="chip conv-kind">{entryKindLabel(entry)}</span>
								{#if entry.ts !== undefined}<span class="muted">{clockTime(entry.ts)}</span>{/if}
								{#if entry.stopReason}<span class="muted">stop: {entry.stopReason}</span>{/if}
								{#if entry.textCapped}<span class="muted" title="the entry text or a tool input hit the per-entry cap and was cut">cut at cap</span>{/if}
							</div>
							{#if entry.toolCalls}
								{#each entry.toolCalls as call, i (`${entry.id}-${i}`)}
									<div class="conv-tool mono"><span class="muted">⚙</span> {call.name} <span class="muted conv-tool-input">{call.input}</span></div>
								{/each}
							{/if}
							{#if entry.kind === "pi.tool-result"}
								<div>
									<button class="btn tiny" onclick={() => toggle(entry.id)}>
										{expanded[entry.id] ? "hide result" : `show result${entry.isError ? " ⚠" : ""}`}
									</button>
									{#if expanded[entry.id] && entry.text}
										<pre class="convtext mono">{entry.text}</pre>
									{/if}
								</div>
							{:else if entry.text}
								<div class="convtext mono">{entry.text}</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</div>

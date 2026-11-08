<script lang="ts">
	/**
	 * ConversationPanel (§7.5, M4-a stage 1): the conversation list from
	 * `readout.storage.conversations` — role, task, entry counts (+ byKind),
	 * resets, compactions, tool rounds, truncation chip, per-conversation USD
	 * + tokens. Grouped: planner → per-task implementer groups → verifier →
	 * other. Storage-mode only: without `storage` the panel shows the kind
	 * empty state ("a run is live") and waits for the SSE re-snapshot — no
	 * spinner, no extra requests. Row click opens the read-only drawer (App
	 * owns the drawer + the task-table highlight).
	 */
	import { conversationGroups } from "../lib/view.ts";
	import { usd } from "../lib/format.ts";
	import type { ConvSummary } from "../../../src/engine/inspector.ts";

	let { conversations, taskOrder, hasStorage, open = false, onToggle, onOpen }: {
		conversations: ConvSummary[] | undefined;
		/** Task-table order, so per-task groups follow the plan. */
		taskOrder: string[];
		/** Storage mode present? Without it the list is a kind empty state. */
		hasStorage: boolean;
		open?: boolean;
		onToggle: () => void;
		onOpen: (id: number) => void;
	} = $props();

	const groups = $derived(conversationGroups(conversations, taskOrder));
	const totalUsd = $derived((conversations ?? []).reduce((n, c) => n + c.usage.usd, 0));

	/** Compact byKind rendering: "msg×8 tool×3 …" (kind names trimmed of their "pi." prefix). */
	function kindSummary(byKind: Record<string, number>): string {
		return Object.entries(byKind)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([kind, n]) => `${kind.replace(/^pi\./, "")}×${n}`)
			.join(" ");
	}
</script>

<section class="panel">
	<button
		class="panel-header healthpanel-toggle"
		type="button"
		onclick={onToggle}
		aria-expanded={open}
		aria-controls="conversation-rows"
		title="conversations (§7.5 — summaries + bounded transcript excerpts)"
	>
		<span>{open ? "▾" : "▸"} conversations · {conversations?.length ?? 0}</span>
		<span class="muted">{hasStorage ? (conversations && conversations.length > 0 ? `${usd(totalUsd)} total` : "none yet") : "needs the lock"}</span>
	</button>
	{#if open}
		<div id="conversation-rows" style="padding:4px 0 6px; max-height:420px; overflow:auto">
			{#if !hasStorage}
				<div class="muted status-mono" style="padding:10px 12px" data-testid="conv-empty-lock">
					conversation detail returns when the lock is free — a run is live. nothing extra to press; the panel fills itself in on the next storage snapshot.
				</div>
			{:else if groups.length === 0}
				<div class="muted status-mono" style="padding:10px 12px">no conversations yet — they appear once a plan or a wave runs.</div>
			{:else}
				{#each groups as group (group.key)}
					<div class="convgroup mono" aria-hidden="true">{group.key === "planner" ? "planner" : group.key === "verifier" ? "verifier" : group.key === "other" ? "other" : `task · ${group.key}`}</div>
					{#each group.rows as conv (conv.id)}
						<button
							class="convrow"
							type="button"
							onclick={() => onOpen(conv.id)}
							aria-label={`conversation ${conv.id} — ${conv.role}${conv.task ? ` for ${conv.task}` : ""}, ${conv.entries} entries`}
						>
							<span class="chip chip-role-{conv.role}">{conv.role}</span>
							<span class="mono">#{conv.id}</span>
							{#if !conv.task}<span class="mono muted">{conv.role === "planner" ? "plan" : conv.role === "verifier" ? "verify" : "—"}</span>{/if}
							<span class="mono conv-entries" title={kindSummary(conv.byKind) || "no entries scanned"}>
								{conv.entriesTruncated ? "≥" : ""}{conv.entries} entries
								{#if kindSummary(conv.byKind)}<span class="muted"> · {kindSummary(conv.byKind)}</span>{/if}
							</span>
							{#if conv.entriesTruncated}<span class="healthchip healthchip-skip" title="the entry scan hit its page cap — counts are a floor, not exact">truncated</span>{/if}
							<span class="mono muted">{conv.toolRounds} tool rounds</span>
							<span class="mono muted">{conv.resets}↺ {conv.compactions}⤵</span>
							<span class="mono" style="margin-left:auto">{usd(conv.usage.usd)} · {conv.usage.totalTokens.toLocaleString("en-US")} tok</span>
						</button>
					{/each}
				{/each}
			{/if}
		</div>
	{/if}
</section>

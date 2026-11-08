<script lang="ts">
	/**
	 * ActionDialog (§7.2/§9): confirmations that state the effect — plan replace,
	 * approve & run (with the count + quarantined badge), run-selected, stop,
	 * resume, handoff (note textarea), plan (editable PRD path prefill).
	 * No silent run: every run/dangerous action passes through here.
	 */
	import type { ActionRequest } from "../lib/actions-model.ts";

	let { request, onConfirm, onCancel }: {
		request: ActionRequest;
		onConfirm: (result: { prd?: string; note?: string }) => void;
		onCancel: () => void;
	} = $props();

	let prd = $state("");
	let note = $state("");
	let sending = $state(false);
	// Seed from the request ONCE per request object. Re-deriving on every run
	// would make the effect's own writes (user typing) a dependency and reset
	// the fields mid-edit — the M3 component test caught exactly that.
	let seededFrom: ActionRequest | undefined;
	$effect(() => {
		if (seededFrom === request) return;
		seededFrom = request;
		prd = request.prd ?? "";
		note = request.note ?? "";
	});

	function submit(): void {
		if (sending) return;
		sending = true;
		onConfirm({ prd: prd.trim() || undefined, note });
	}

	function onKeydown(ev: KeyboardEvent): void {
		if (ev.key === "Escape") onCancel();
	}

	let card: HTMLDivElement | undefined = $state(undefined);
	$effect(() => {
		card?.querySelector<HTMLButtonElement>("button.positive")?.focus();
	});
</script>

<svelte:window onkeydown={onKeydown} />

<div class="dialog-backdrop" onmousedown={(ev) => { if (ev.target === ev.currentTarget) onCancel(); }} role="presentation">
	<div class="dialog card" bind:this={card} role="dialog" aria-modal="true" aria-label={request.title}>
		<div class="dialog-title">{request.title}</div>
		<div class="dialog-body">{request.body}</div>
		{#if request.kind === "plan"}
			<label style="display:block; margin-top:8px">
				<span class="muted" style="font-size:11.5px">PRD path</span>
				<input class="input mono" bind:value={prd} placeholder="docs/prd.md" spellcheck="false" />
			</label>
		{/if}
		{#if request.kind === "handoff"}
			<label style="display:block; margin-top:8px">
				<span class="muted" style="font-size:11.5px">note for the next wave</span>
				<textarea class="input mono" bind:value={note} rows="3" placeholder="…context the next wave should keep in mind"></textarea>
			</label>
		{/if}
		<div class="dialog-actions">
			<button class="btn" onclick={onCancel} disabled={sending}>cancel</button>
			<button class="btn positive" onclick={submit} disabled={sending}>
				{sending ? "sending…" : request.confirmLabel}
			</button>
		</div>
	</div>
</div>

<script lang="ts">
	/**
	 * Shortcut sheet (§10): the "?" sheet listing every keyboard binding.
	 * Deliberately short — no single-key destructive shortcuts exist; Esc, "/"
	 * and "?" are read-only or close-only.
	 */
	let { onclose }: { onclose: () => void } = $props();

	const keys: { key: string; text: string }[] = [
		{ key: "Esc", text: "close the shortcut sheet, dialog, or drawer" },
		{ key: "/", text: "focus the event-log filter" },
		{ key: "?", text: "open this shortcut sheet" },
		{ key: "Tab", text: "move through the action bar, dialogs, tables, and the drawer" },
	];

	function onKeydown(ev: KeyboardEvent): void {
		if (ev.key === "Escape") onclose();
	}

	let card: HTMLDivElement | undefined = $state(undefined);
	$effect(() => {
		// Focus lands inside the sheet so Tab keeps cycling here.
		card?.querySelector<HTMLButtonElement>("button.sheet-close")?.focus();
	});
</script>

<svelte:window onkeydown={onKeydown} />

<div
	class="dialog-backdrop"
	onmousedown={(ev) => { if (ev.target === ev.currentTarget) onclose(); }}
	role="presentation"
>
	<div class="dialog card sheet" bind:this={card} role="dialog" aria-modal="true" aria-label="keyboard shortcuts">
		<div class="dialog-title">keyboard shortcuts</div>
		<div class="dialog-body">
			<table class="grid sheet-table">
				<tbody>
					{#each keys as k (k.key)}
						<tr>
							<td style="width:70px"><kbd class="mono kbd">{k.key}</kbd></td>
							<td>{k.text}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="muted" style="font-size:11.5px; margin:10px 0 0">
				There are no single-key destructive shortcuts — every action with an effect still goes through its confirmation dialog.
			</p>
		</div>
		<div class="dialog-actions">
			<button class="btn sheet-close" onclick={onclose}>close</button>
		</div>
	</div>
</div>

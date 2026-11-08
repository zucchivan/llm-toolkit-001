<script lang="ts">
	/**
	 * Toast stack (§7.1): in-page notifications for failures; the count of LIVE
	 * toasts also drives the tab-title badge in App. Auto-expire; manual dismiss.
	 */
	export interface ToastMessage {
		id: string;
		severity: "error" | "warn" | "info";
		text: string;
	}

	let { toasts, onDismiss }: { toasts: ToastMessage[]; onDismiss: (id: string) => void } = $props();
</script>

<div class="toasts" role="status" aria-live="polite">
	{#each toasts as t (t.id)}
		<div class="toast toast-{t.severity}">
			<span>{t.severity === "error" ? "✘" : t.severity === "warn" ? "▲" : "·"}</span>
			<span style="flex:1">{t.text}</span>
			<button class="btn tiny" onclick={() => onDismiss(t.id)} aria-label="dismiss">×</button>
		</div>
	{/each}
</div>

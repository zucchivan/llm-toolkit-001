<script lang="ts">
	/**
	 * Browser-notification opt-in toggle (§18, ui 0.10.0) for the header strip.
	 * `off` → click asks the browser (the only moment a permission prompt can
	 * appear — never on load); `on` → click turns the UI's own preference off;
	 * `blocked`/`unsupported` render disabled with the reason in the title.
	 */
	import { notifyState, requestNotify, setNotifyPref, type NotifyState } from "../lib/notify.ts";

	let state = $state<NotifyState>(notifyState());

	const labels: Record<NotifyState, string> = {
		unsupported: "unavailable",
		off: "off",
		on: "on",
		blocked: "blocked",
	};
	const titles: Record<NotifyState, string> = {
		unsupported: "this browser/context has no Notification API — toasts + tab-title badge stay the always-on alert channel",
		off: "browser notifications are off — click to opt in: new failures notify you while this tab is hidden (asks the browser's permission once)",
		on: "browser notifications are on — new failures notify you while this tab is hidden; click to turn off",
		blocked: "the browser blocked notifications for this origin — re-enable them in the browser's site settings, or keep toasts + tab-title badge",
	};

	async function toggle(): Promise<void> {
		if (state === "on") {
			setNotifyPref(false);
		} else if (state === "off") {
			await requestNotify();
		}
		state = notifyState();
	}
</script>

<button
	class="btn tiny"
	class:positive={state === "on"}
	disabled={state === "unsupported" || state === "blocked"}
	onclick={() => void toggle()}
	aria-pressed={state === "on"}
	aria-label={`browser notifications: ${labels[state]}`}
	title={titles[state]}
>notify: {labels[state]}</button>

/**
 * Browser notifications (§18, shipped ui 0.10.0): an OS notification for NEW
 * failure rows while the tab is hidden. Strictly additive over the §7.1
 * alert surface — the in-page toasts + tab-title badge stay the always-on
 * channel; this is a user-enabled extra behind two gates: the UI's own
 * localStorage preference (default off) and the browser's Notification
 * permission (never requested before the user clicks the toggle on).
 * Permission + preference are read at dispatch time, so a mid-session revoke
 * or toggle is honored without a reload. No kit change; no new deps.
 */

const STORAGE_KEY = "kit-ui-notify";

export type NotifyState = "unsupported" | "off" | "on" | "blocked";

function ctor(): typeof Notification | undefined {
	return typeof Notification === "undefined" ? undefined : Notification;
}

/** The toggle's display state, independent of tab visibility. */
export function notifyState(): NotifyState {
	const c = ctor();
	if (!c) return "unsupported";
	if (c.permission === "denied") return "blocked";
	return notifyPrefEnabled() ? "on" : "off";
}

export function notifyPrefEnabled(): boolean {
	try {
		return globalThis.localStorage?.getItem(STORAGE_KEY) === "on";
	} catch {
		return false;
	}
}

export function setNotifyPref(on: boolean): void {
	try {
		globalThis.localStorage?.setItem(STORAGE_KEY, on ? "on" : "off");
	} catch {
		// e.g. a storage-disabled context: the dispatch gates simply read off.
	}
}

/**
 * Ask the browser for the permission. Resolves to the resulting toggle state
 * ("dismissed" when the prompt was ignored); the preference is only set when
 * the grant is real — a "dismissed" or "denied" ask never turns the pref on.
 */
export async function requestNotify(): Promise<NotifyState | "dismissed"> {
	const c = ctor();
	if (!c) return "unsupported";
	const permission = await c.requestPermission();
	if (permission === "granted") {
		setNotifyPref(true);
		return "on";
	}
	if (permission === "denied") return "blocked";
	return "dismissed";
}

/** All gates for a dispatch: supported, permitted, opted in, and the user is not looking at the tab. */
export function shouldNotify(): boolean {
	const c = ctor();
	return c !== undefined && c.permission === "granted" && notifyPrefEnabled() && globalThis.document?.hidden === true;
}

/**
 * Fire one OS notification for a failure row. Returns whether it fired so
 * callers/tests can see the gate result; throws nothing (a rejected
 * Notification construction is swallowed — alerting must never break the
 * page).
 */
export function notifyFailure(text: string): boolean {
	if (!shouldNotify()) return false;
	try {
		new Notification("llm-toolkit-001 · run needs attention", {
			body: text.length > 240 ? `${text.slice(0, 237)}…` : text,
			tag: "kit-ui-failure",
		});
		return true;
	} catch {
		return false;
	}
}

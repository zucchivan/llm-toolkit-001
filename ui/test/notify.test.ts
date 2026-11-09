// @vitest-environment jsdom
/**
 * Browser-notification lib (§18, ui 0.10.0): the two-gate model — the UI's
 * localStorage preference (default off) AND the browser's Notification
 * permission AND a hidden tab. The permission prompt fires only from an
 * explicit request; a dismissed/denied ask never turns the preference on.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { notifyState, notifyPrefEnabled, setNotifyPref, requestNotify, shouldNotify, notifyFailure } from "../src/lib/notify.ts";

class FakeNotification {
	static permission: NotificationPermission = "default";
	static instances: FakeNotification[] = [];
	static requestPermission = vi.fn(async (): Promise<NotificationPermission> => FakeNotification.permission);
	title: string;
	options: NotificationOptions | undefined;
	constructor(title: string, options?: NotificationOptions) {
		this.title = title;
		this.options = options;
		FakeNotification.instances.push(this);
	}
}

function installNotification(permission: NotificationPermission = "default"): void {
	FakeNotification.permission = permission;
	FakeNotification.instances = [];
	FakeNotification.requestPermission.mockClear();
	vi.stubGlobal("Notification", FakeNotification);
}

function setHidden(hidden: boolean): void {
	Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
}

beforeEach(() => {
	localStorage.clear();
	setHidden(false);
	installNotification();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("notify support + state", () => {
	it("reports unsupported when the context has no Notification API", () => {
		vi.stubGlobal("Notification", undefined);
		expect(notifyState()).toBe("unsupported");
		expect(shouldNotify()).toBe(false);
		expect(notifyFailure("boom")).toBe(false);
	});

	it("is off by default even with the API present (opt-in, never automatic)", () => {
		expect(notifyState()).toBe("off");
		setHidden(true);
		expect(shouldNotify()).toBe(false);
		expect(notifyFailure("boom")).toBe(false);
		expect(FakeNotification.instances).toHaveLength(0);
	});

	it("reports blocked when the browser denied permission, regardless of the pref", () => {
		FakeNotification.permission = "denied";
		setNotifyPref(true);
		expect(notifyState()).toBe("blocked");
		setHidden(true);
		expect(shouldNotify()).toBe(false);
	});

	it("pref persists in localStorage and reads back (round trip)", () => {
		expect(notifyPrefEnabled()).toBe(false);
		setNotifyPref(true);
		expect(localStorage.getItem("kit-ui-notify")).toBe("on");
		expect(notifyPrefEnabled()).toBe(true);
		setNotifyPref(false);
		expect(localStorage.getItem("kit-ui-notify")).toBe("off");
		expect(notifyPrefEnabled()).toBe(false);
	});
});

describe("requestNotify — the only moment a prompt can appear", () => {
	it("granted: turns the pref on and reports on", async () => {
		FakeNotification.permission = "granted";
		await expect(requestNotify()).resolves.toBe("on");
		expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
		expect(notifyPrefEnabled()).toBe(true);
		expect(notifyState()).toBe("on");
	});

	it("denied: reports blocked and never turns the pref on", async () => {
		FakeNotification.permission = "denied";
		await expect(requestNotify()).resolves.toBe("blocked");
		expect(notifyPrefEnabled()).toBe(false);
	});

	it("dismissed (prompt ignored): reports dismissed and never turns the pref on", async () => {
		FakeNotification.permission = "default";
		await expect(requestNotify()).resolves.toBe("dismissed");
		expect(notifyPrefEnabled()).toBe(false);
		expect(notifyState()).toBe("off");
	});

	it("unsupported: resolves without asking", async () => {
		vi.stubGlobal("Notification", undefined);
		await expect(requestNotify()).resolves.toBe("unsupported");
		expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
	});
});

describe("dispatch gates — permission + pref + hidden tab, all three", () => {
	it("fires only when every gate is open", () => {
		FakeNotification.permission = "granted";
		setNotifyPref(true);
		setHidden(true);
		expect(shouldNotify()).toBe(true);
		expect(notifyFailure("wave 3 budget exhausted")).toBe(true);
		expect(FakeNotification.instances).toHaveLength(1);
		const note = FakeNotification.instances[0]!;
		expect(note.title).toContain("llm-toolkit-001");
		expect(note.options?.body).toBe("wave 3 budget exhausted");
	});

	it("refuses while the tab is visible — no noise at an open dashboard", () => {
		FakeNotification.permission = "granted";
		setNotifyPref(true);
		setHidden(false);
		expect(notifyFailure("boom")).toBe(false);
		expect(FakeNotification.instances).toHaveLength(0);
	});

	it("refuses when the permission is only default (prompt never auto-shown)", () => {
		setNotifyPref(true);
		setHidden(true);
		expect(notifyFailure("boom")).toBe(false);
	});

	it("refuses when the pref is off even with permission granted", () => {
		FakeNotification.permission = "granted";
		setHidden(true);
		expect(notifyFailure("boom")).toBe(false);
	});

	it("long failure text is capped so the OS card stays readable", () => {
		FakeNotification.permission = "granted";
		setNotifyPref(true);
		setHidden(true);
		const long = "x".repeat(500);
		expect(notifyFailure(long)).toBe(true);
		const body = FakeNotification.instances[0]!.options?.body;
		expect(typeof body).toBe("string");
		expect((body as string).length).toBeLessThan(250);
		expect((body as string).endsWith("…")).toBe(true);
	});

	it("a throwing Notification constructor is swallowed, not propagated", () => {
		FakeNotification.permission = "granted";
		setNotifyPref(true);
		setHidden(true);
		vi.stubGlobal("Notification", class {
			static permission = "granted";
			constructor() { throw new Error("os notifications unavailable"); }
		});
		expect(notifyFailure("boom")).toBe(false);
	});
});

// @vitest-environment jsdom
/**
 * NotifyToggle component tests (§18, ui 0.10.0): the header opt-in toggle.
 * off → click asks the browser (the only prompt path); on → click turns the
 * UI pref off; blocked/unsupported render disabled with the reason.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import NotifyToggle from "../src/components/NotifyToggle.svelte";

class FakeNotification {
	static permission: NotificationPermission = "default";
	static requestPermission = vi.fn(async (): Promise<NotificationPermission> => FakeNotification.permission);
	constructor(public title: string, public options?: NotificationOptions) {}
}

function installNotification(permission: NotificationPermission = "default"): void {
	FakeNotification.permission = permission;
	FakeNotification.requestPermission.mockClear();
	vi.stubGlobal("Notification", FakeNotification);
}

beforeEach(() => {
	localStorage.clear();
	installNotification();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("NotifyToggle", () => {
	it("renders disabled 'unavailable' when the context has no Notification API", () => {
		vi.stubGlobal("Notification", undefined);
		render(NotifyToggle);
		const btn = screen.getByRole("button", { name: "browser notifications: unavailable" });
		expect(btn).toBeTruthy();
		expect((btn as HTMLButtonElement).disabled).toBe(true);
		expect(btn.textContent).toContain("unavailable");
	});

	it("renders an enabled 'off' toggle by default", () => {
		render(NotifyToggle);
		const btn = screen.getByRole("button", { name: "browser notifications: off" });
		expect((btn as HTMLButtonElement).disabled).toBe(false);
		expect(btn.getAttribute("aria-pressed")).toBe("false");
	});

	it("clicking off asks the browser once and flips to on when granted", async () => {
		render(NotifyToggle);
		const btn = screen.getByRole("button", { name: "browser notifications: off" });
		FakeNotification.permission = "granted";
		await fireEvent.click(btn);
		expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
		expect(localStorage.getItem("kit-ui-notify")).toBe("on");
		expect(screen.getByRole("button", { name: "browser notifications: on" }).getAttribute("aria-pressed")).toBe("true");
	});

	it("a dismissed prompt leaves the toggle off and the pref untouched", async () => {
		render(NotifyToggle);
		const btn = screen.getByRole("button", { name: "browser notifications: off" });
		await fireEvent.click(btn); // permission stays "default"
		expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
		expect(localStorage.getItem("kit-ui-notify")).toBeNull();
		expect(screen.getByRole("button", { name: "browser notifications: off" })).toBeTruthy();
	});

	it("clicking on turns the UI pref off without another browser prompt", async () => {
		localStorage.setItem("kit-ui-notify", "on");
		installNotification("granted");
		render(NotifyToggle);
		const btn = screen.getByRole("button", { name: "browser notifications: on" });
		await fireEvent.click(btn);
		expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
		expect(localStorage.getItem("kit-ui-notify")).toBe("off");
		expect(screen.getByRole("button", { name: "browser notifications: off" })).toBeTruthy();
	});

	it("renders disabled 'blocked' when the browser denied permission", () => {
		installNotification("denied");
		render(NotifyToggle);
		const btn = screen.getByRole("button", { name: "browser notifications: blocked" });
		expect((btn as HTMLButtonElement).disabled).toBe(true);
	});

	it("seeds from a persisted pref: granted + pref on renders on without any prompt", () => {
		localStorage.setItem("kit-ui-notify", "on");
		installNotification("granted");
		render(NotifyToggle);
		expect(screen.getByRole("button", { name: "browser notifications: on" }).getAttribute("aria-pressed")).toBe("true");
		expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
	});
});

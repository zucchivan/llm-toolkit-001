// @vitest-environment jsdom
/**
 * ShortcutSheet component tests (M3): lists the §10 bindings, Esc closes,
 * the close button closes. No destructive shortcuts listed.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import ShortcutSheet from "../src/components/ShortcutSheet.svelte";

afterEach(() => cleanup());

describe("ShortcutSheet", () => {
	it("lists Esc, /, ? and the no-destructive-shortcuts promise", () => {
		render(ShortcutSheet, { onclose: () => {} });
		expect(screen.getByRole("dialog", { name: "keyboard shortcuts" })).toBeTruthy();
		expect(screen.getByText("Esc")).toBeTruthy();
		expect(screen.getByText("/")).toBeTruthy();
		expect(screen.getByText("?")).toBeTruthy();
		expect(screen.getByText(/no single-key destructive shortcuts/i)).toBeTruthy();
	});

	it("Escape on the window closes the sheet", async () => {
		const onclose = vi.fn();
		render(ShortcutSheet, { onclose });
		await fireEvent(window, new KeyboardEvent("keydown", { key: "Escape" }));
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it("the close button closes the sheet", async () => {
		const onclose = vi.fn();
		render(ShortcutSheet, { onclose });
		await fireEvent.click(screen.getByRole("button", { name: "close" }));
		expect(onclose).toHaveBeenCalledTimes(1);
	});
});

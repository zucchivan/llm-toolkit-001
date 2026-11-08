// @vitest-environment jsdom
/**
 * Toasts component tests (M3 F): failure rendering + manual dismissal; the tab
 * badge count is derived in App and covered there by the pure-count policy.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import Toasts from "../src/components/Toasts.svelte";

/** Structural copy of the component's exported ToastMessage (a .svelte
    export is not visible to tsc's dts view; runtime type is the same). */
interface ToastMessage {
	id: string;
	severity: "error" | "warn" | "info";
	text: string;
}

afterEach(() => cleanup());

function toast(id: string, severity: ToastMessage["severity"], text: string): ToastMessage {
	return { id, severity, text };
}

describe("Toasts", () => {
	it("renders each severity's glyph + text", () => {
		render(Toasts, {
			toasts: [toast("a", "error", "gate failed — t #w2: lint"), toast("b", "warn", "provider reset — sleep armed"), toast("c", "info", "run accepted — job j1")],
			onDismiss: () => {},
		});
		expect(screen.getByText("gate failed — t #w2: lint")).toBeTruthy();
		expect(screen.getByText("provider reset — sleep armed")).toBeTruthy();
		expect(screen.getByText("run accepted — job j1")).toBeTruthy();
	});

	it("the dismiss button removes exactly its toast (onDismiss called with the id)", async () => {
		const onDismiss = vi.fn();
		render(Toasts, { toasts: [toast("a", "error", "gate failed"), toast("b", "warn", "sleep armed")], onDismiss });
		const buttons = screen.getAllByRole("button", { name: "dismiss" });
		await fireEvent.click(buttons[0]!);
		expect(onDismiss).toHaveBeenCalledWith("a");
	});

	it("empty stack renders nothing clickable", () => {
		render(Toasts, { toasts: [], onDismiss: () => {} });
		expect(screen.queryByRole("button")).toBeNull();
	});
});

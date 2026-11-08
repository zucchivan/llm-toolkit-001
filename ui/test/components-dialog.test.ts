// @vitest-environment jsdom
/**
 * ActionDialog component tests (M3 keyboard pass): Escape cancels, confirm
 * submits the edited field values, aria semantics hold.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import ActionDialog from "../src/components/ActionDialog.svelte";
import type { ActionRequest } from "../src/lib/actions-model.ts";

afterEach(() => cleanup());

describe("ActionDialog keyboard behavior (§10)", () => {
	it("Escape cancels (closes) the dialog", async () => {
		const onCancel = vi.fn();
		const request: ActionRequest = { kind: "run-all", title: "Approve & run", body: "waves run 3 todo task(s)", confirmLabel: "Approve & run (3)" };
		render(ActionDialog, { request, onConfirm: () => {}, onCancel });
		await fireEvent(window, new KeyboardEvent("keydown", { key: "Escape" }));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("confirm without fields submits nothing extra; cancel button cancels", async () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		const request: ActionRequest = { kind: "run-all", title: "Approve & run", body: "waves run 2 todo task(s)", confirmLabel: "Approve & run (2)" };
		render(ActionDialog, { request, onConfirm, onCancel });
		await fireEvent.click(screen.getByRole("button", { name: "Approve & run (2)" }));
		expect(onConfirm).toHaveBeenCalledWith({ note: "", prd: undefined });
		await fireEvent.click(screen.getByRole("button", { name: "cancel" }));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("handoff: the note textarea reaches the confirm result; aria-label carries the title", async () => {
		const onConfirm = vi.fn();
		const request: ActionRequest = { kind: "handoff", title: "Handoff note", body: "queues a note", confirmLabel: "Queue note", note: "" };
		const { container } = render(ActionDialog, { request, onConfirm, onCancel: () => {} });
		expect(screen.getByRole("dialog", { name: "Handoff note" })).toBeTruthy();
		const note = container.querySelector("textarea")!;
		await fireEvent.input(note, { target: { value: "watch the gate" } });
		await fireEvent.click(screen.getByRole("button", { name: "Queue note" }));
		expect(onConfirm).toHaveBeenCalledWith({ note: "watch the gate" });
	});
});

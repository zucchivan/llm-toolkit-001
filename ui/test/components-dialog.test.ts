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

describe("model-readiness row (§7.2 friendliness)", () => {
	const MODELS = [
		{ name: "planner" as const, provider: "anthropic", modelId: "claude-sonnet-4-5" },
		{ name: "implementer" as const, provider: "anthropic", modelId: "claude-sonnet-4-5" },
		{ name: "verifier" as const, provider: "openrouter", modelId: "openai/gpt-5-nano" },
	];
	const runRequest: ActionRequest = { kind: "run-all", title: "Approve & run", body: "waves run 2 todo task(s)", confirmLabel: "Approve & run (2)" };

	it("configured models render as chips and leave the positive action enabled", async () => {
		render(ActionDialog, { request: runRequest, models: MODELS, onConfirm: () => {}, onCancel: () => {} });
		const row = screen.getByTestId("dialog-models");
		const chips = (row.textContent ?? "").replace(/\s+/g, " ");
		expect(chips).toContain("planner · anthropic · claude-sonnet-4-5");
		expect(chips).toContain("implementer · anthropic · claude-sonnet-4-5");
		expect(chips).toContain("verifier · openrouter · openai/gpt-5-nano");
		const positive = screen.getByRole("button", { name: "Approve & run (2)" }) as HTMLButtonElement;
		expect(positive.disabled).toBe(false);
		expect(screen.queryByTestId("dialog-model-warning")).toBeNull();
	});

	it("a needed role without provider/modelId: warning with the TOML block, positive action disabled", async () => {
		// plan needs only the planner: drop it and the warning lands
		const missingPlanner = MODELS.filter((m) => m.name !== "planner");
		const planRequest: ActionRequest = { kind: "plan", title: "Plan", body: "replaces the plan", confirmLabel: "Write the plan" };
		render(ActionDialog, { request: { ...planRequest }, models: missingPlanner, onConfirm: () => {}, onCancel: () => {} });
		expect(screen.getByTestId("dialog-model-warning").textContent).toContain("roles.planner has no model configured");
		expect(screen.getByTestId("dialog-model-warning").textContent).toContain("[roles.planner]");
		expect(screen.getByTestId("dialog-model-warning").textContent).toContain('provider = "openrouter"');
		expect(screen.getByTestId("dialog-model-warning").textContent).toContain(".orch/config.toml");
		const planPositive = screen.getByRole("button", { name: "Write the plan" }) as HTMLButtonElement;
		expect(planPositive.disabled).toBe(true);
		cleanup();

		// run needs implementer + verifier: drop both and BOTH roles name the warning
		const noRunners = MODELS.filter((m) => m.name !== "implementer" && m.name !== "verifier");
		render(ActionDialog, { request: runRequest, models: noRunners, onConfirm: () => {}, onCancel: () => {} });
		const warn = screen.getByTestId("dialog-model-warning").textContent ?? "";
		expect(warn).toContain("roles.implementer, roles.verifier");
		expect(warn).toContain("[roles.implementer]");
		expect(warn).toContain("[roles.verifier]");
		const positive = screen.getByRole("button", { name: "Approve & run (2)" }) as HTMLButtonElement;
		expect(positive.disabled).toBe(true);
	});

	it("a mid-session config break: the reason shows and the action stays off", async () => {
		render(ActionDialog, { request: runRequest, configError: "config.toml is not valid TOML: oops", onConfirm: () => {}, onCancel: () => {} });
		const warn = screen.getByTestId("dialog-model-warning");
		expect(warn.textContent).toContain("config can't be read");
		const positive = screen.getByRole("button", { name: "Approve & run (2)" }) as HTMLButtonElement;
		expect(positive.disabled).toBe(true);
	});

	it("stop/handoff dialogs show no models row at all", async () => {
		const { container } = render(ActionDialog, {
			request: { kind: "stop", title: "Stop", body: "sends SIGINT", confirmLabel: "Stop job" },
			models: MODELS,
			onConfirm: () => {},
			onCancel: () => {},
		});
		expect(container.querySelector('[data-testid="dialog-models"]')).toBeNull();
	});

	it("unknown models (no snapshot yet) stay permissive — the server preflight is the backstop", async () => {
		render(ActionDialog, { request: runRequest, onConfirm: () => {}, onCancel: () => {} });
		expect(screen.queryByTestId("dialog-models")).toBeNull();
		const positive = screen.getByRole("button", { name: "Approve & run (2)" }) as HTMLButtonElement;
		expect(positive.disabled).toBe(false);
	});
});

// @vitest-environment jsdom
/**
 * EventLog component tests (M3): the filter narrows the tail, pause freezes it
 * (held-back rows counted), "/" registration focuses the filter input.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import EventLog from "../src/components/EventLog.svelte";
import { resetEventFilterRegistration, focusEventFilter } from "../src/lib/shortcuts.ts";
import type { WaveRow } from "../../src/engine/infos.ts";

afterEach(() => {
	cleanup();
	resetEventFilterRegistration();
});

function row(over: Partial<WaveRow> & Pick<WaveRow, "task" | "kind" | "verb">): WaveRow {
	return { ts: 1, ...over } as WaveRow;
}

const rows: WaveRow[] = [
	row({ task: "t1", kind: "wave", wave: 1, verb: "start" }),
	row({ task: "t1", kind: "gate", wave: 1, verb: "fail", detail: "lint:false" }),
	row({ task: "t2", kind: "verdict", wave: 2, verb: "reject:1", detail: "missing criterion" }),
];

const visibleRows = (root: HTMLElement): HTMLElement[] => Array.from(root.querySelectorAll(".eventlog [role=log] .status-mono"));

describe("EventLog filter + pause", () => {
	it("renders all rows; the filter narrows to matching ones with an empty-state when nothing matches", async () => {
		const { container, rerender } = render(EventLog, { props: { rows } });
		expect(visibleRows(container)).toHaveLength(3);

		const filter = screen.getByRole("textbox", { name: /filter event log/i }) as HTMLInputElement;
		await fireEvent.input(filter, { target: { value: "gate" } });
		expect(visibleRows(container)).toHaveLength(1);
		expect(container.textContent).toContain("lint:false");

		// rerender keeps the query (state persists in the component)
		await rerender({ rows });
		expect(visibleRows(container)).toHaveLength(1);

		const filter2 = screen.getByRole("textbox", { name: /filter event log/i }) as HTMLInputElement;
		await fireEvent.input(filter2, { target: { value: "no-such-token" } });
		expect(container.textContent!).toContain("no rows match");
	});

	it("pause freezes the visible tail and counts held-back rows; reset resumes", async () => {
		const { container, rerender } = render(EventLog, { props: { rows } });

		await fireEvent.click(screen.getByRole("button", { name: "pause" }));
		const pausedCount = visibleRows(container).length;
		expect(pausedCount).toBe(3);
		// the toggle flips to resume with aria-pressed=true (§a11y)
		expect(screen.getByRole("button", { name: "resume" }).getAttribute("aria-pressed")).toBe("true");

		// new rows arrive while paused → DOM unchanged, header counts the backlog
		await rerender({ rows: [...rows, row({ task: "t2", kind: "task", verb: "done" })] });
		const frozenRows = visibleRows(container);
		expect(frozenRows).toHaveLength(pausedCount);
		expect(container.textContent).toContain("1 held back");

		await fireEvent.click(screen.getByRole("button", { name: "reset" }));
		expect(visibleRows(container)).toHaveLength(4);
		expect(screen.getByRole("button", { name: "pause" }).getAttribute("aria-pressed")).toBe("false");
	});

	it("registers its filter input so the global '/' shortcut can focus it; unregistering on unmount", async () => {
		const { unmount } = render(EventLog, { props: { rows } });
		const filter = screen.getByRole("textbox", { name: /filter event log/i }) as HTMLInputElement;
		expect(focusEventFilter()).toBe(true);
		expect(document.activeElement).toBe(filter);
		await unmount();
		expect(focusEventFilter()).toBe(false);
	});
});

// @vitest-environment jsdom
/**
 * EventLog component tests (M3 + M4-c): the filter narrows the tail, pause
 * freezes it (held-back rows counted), "/" registration focuses the filter
 * input; over §13's 2,000-row DOM window the cut is explicit (the notice
 * names newest-N-of-M and that the readout carries the full tail).
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

const visibleRows = (root: HTMLElement): HTMLElement[] => Array.from(root.querySelectorAll(".eventlog [role=log] .status-mono:not(.truncated-notice)"));
const notice = (root: HTMLElement): HTMLElement | null => root.querySelector(".eventlog [role=log] .truncated-notice");

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

	it("over §13's window: the DOM keeps the newest 2,000 rows and the cut is announced explicitly", () => {
		const many = Array.from({ length: 2_005 }, (_, i) => row({ task: `t${i}`, kind: "wave", verb: "start", ts: i }));
		const { container } = render(EventLog, { props: { rows: many } });
		const domRows = visibleRows(container);
		expect(domRows).toHaveLength(2_000);
		// the window keeps the NEWEST rows: the first visible row is t5 (t0–t4 cut)
		expect(domRows[0]!.textContent).toContain("t5");
		expect(domRows.at(-1)!.textContent).toContain("t2004");
		// the explicit notice: newest-N-of-M, the hidden count, and the honest
		// server-side truth (the readout carries the full tail — no server cap)
		expect(container.textContent).toContain("truncated — showing newest 2,000 of 2,005");
		expect(notice(container)?.textContent).toContain("5 earlier row(s) sit above this window");
		expect(notice(container)?.textContent).toContain("no server-side cap");
		// at/under the window there is no notice at all (2,000 exactly = not truncated)
		const small = render(EventLog, { props: { rows: many.slice(-2_000) } });
		expect(notice(small.container)).toBeNull();
		expect(small.container.textContent).not.toContain("truncated");
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

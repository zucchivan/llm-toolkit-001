// @vitest-environment jsdom
/**
 * TaskTable component test (§15.1, M3 sort + M4-c row filter): plan order is
 * the stable default; the toggle sorts failing-first by status; the filter
 * toolbar (text + status chip) narrows rows with a counted header and a kind
 * no-match state.
 */
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/svelte";
import TaskTable from "../src/components/TaskTable.svelte";
import type { KitTaskView } from "../../src/engine/inspector.ts";

afterEach(() => cleanup());

function task(id: string, status: KitTaskView["status"], deps: string[] = []): KitTaskView {
	return { id, title: id, status, waveCount: 1, dependsOn: deps, targetPaths: ["src/"], priority: 1, feedback: 0 } as KitTaskView;
}

/** The plan order deliberately interleaves statuses. */
const tasks: KitTaskView[] = [task("a-done", "done", []), task("b-q", "quarantined", []), task("c-live", "in_progress", []), task("d-todo", "todo", [])];

const rowIds = (root: HTMLElement): string[] => Array.from(root.querySelectorAll("table tbody tr td:nth-child(2)")).map((td) => (td as HTMLElement).textContent ?? "");

const headerCount = (root: HTMLElement): string =>
	(root.querySelector(".panel-header span") as HTMLElement).textContent ?? "";

const emptyCell = (root: HTMLElement): string =>
	(root.querySelector("table tbody tr td") as HTMLElement).textContent ?? "";

describe("TaskTable row filter (M4-c)", () => {
	it("text filter narrows rows; the header counts shown of total", async () => {
		const { container } = render(TaskTable, { props: { tasks, phase: "running", onOpenDiff: () => {} } });
		expect(headerCount(container)).toBe("tasks (4)");
		const filter = screen.getByRole("textbox", { name: /filter tasks by id, title, or dependency/i });
		await fireEvent.input(filter, { target: { value: "todo" } });
		expect(rowIds(container)).toEqual(["d-todo"]);
		expect(headerCount(container)).toBe("tasks (1 of 4)");
		// the reset button appears only while a filter is active
		await fireEvent.click(screen.getByRole("button", { name: "reset" }));
		expect(rowIds(container)).toEqual(["a-done", "b-q", "c-live", "d-todo"]);
		expect(headerCount(container)).toBe("tasks (4)");
	});

	it("status chip narrows to one status; combined with text", async () => {
		const { container } = render(TaskTable, { props: { tasks, phase: "running", onOpenDiff: () => {} } });
		const select = screen.getByRole("combobox", { name: /filter tasks by status/i });
		await fireEvent.change(select, { target: { value: "quarantined" } });
		expect(rowIds(container)).toEqual(["b-q"]);
		expect(headerCount(container)).toBe("tasks (1 of 4)");

		const filter = screen.getByRole("textbox", { name: /filter tasks by id, title, or dependency/i });
		await fireEvent.input(filter, { target: { value: "b-q" } });
		expect(rowIds(container)).toEqual(["b-q"]);
		await fireEvent.input(filter, { target: { value: "a-done" } });
		expect(rowIds(container)).toEqual([]);
		expect(emptyCell(container)).toContain("no tasks match status “quarantined” “a-done”");
	});

	it("filter composes with the sort toggle (failing-first within the filtered set)", async () => {
		const { container } = render(TaskTable, { props: { tasks, phase: "running", onOpenDiff: () => {} } });
		const select = screen.getByRole("combobox", { name: /filter tasks by status/i });
		await fireEvent.change(select, { target: { value: "all" } });
		// text filter to the two "list" tasks, then failing-first by status
		await fireEvent.input(screen.getByRole("textbox", { name: /filter tasks by id, title, or dependency/i }), { target: { value: "-" } });
		await fireEvent.click(screen.getByRole("button", { name: "sort tasks by failing-first status" }));
		expect(rowIds(container)).toEqual(["b-q", "c-live", "d-todo", "a-done"]);
		const select2 = screen.getByRole("combobox", { name: /filter tasks by status/i });
		await fireEvent.change(select2, { target: { value: "todo" } });
		expect(rowIds(container)).toEqual(["d-todo"]);
	});

	it("no match renders the kind empty state naming both active constraints", async () => {
		const { container } = render(TaskTable, { props: { tasks, phase: "running", onOpenDiff: () => {} } });
		await fireEvent.input(screen.getByRole("textbox", { name: /filter tasks by id, title, or dependency/i }), { target: { value: "zzz" } });
		expect(emptyCell(container)).toContain("no tasks match “zzz”");
		expect(emptyCell(container)).toContain("clear the filter to see all 4");
		// tasks.length === 0 keeps the original setup wording (empty plan)
		const empty = render(TaskTable, { props: { tasks: [], phase: "empty", onOpenDiff: () => {} } });
		expect(within(empty.container).getByText(/no tasks — write the PRD/)).toBeTruthy();
	});
});

describe("TaskTable sort toggle", () => {
	it("defaults to the plan order (stable rows)", () => {
		const { container } = render(TaskTable, { props: { tasks, phase: "running", onOpenDiff: () => {} } });
		expect(rowIds(container)).toEqual(["a-done", "b-q", "c-live", "d-todo"]);
	});

	it("the toggle orders failing-first (quarantined → in_progress → todo → done), stable within a status", async () => {
		const { container } = render(TaskTable, { props: { tasks, phase: "running", onOpenDiff: () => {} } });
		await fireEvent.click(screen.getByRole("button", { name: "sort tasks by failing-first status" }));
		expect(rowIds(container)).toEqual(["b-q", "c-live", "d-todo", "a-done"]);
		await fireEvent.click(screen.getByRole("button", { name: "sort tasks by plan order" }));
		expect(rowIds(container)).toEqual(["a-done", "b-q", "c-live", "d-todo"]);
	});

	it("plan order stays untouched when the run mutates a status in place", async () => {
		const mixed = [task("x-todo", "todo"), task("y-done", "done")];
		const mutated = [task("x-todo", "done"), task("y-todo", "todo")];
		const { container, rerender } = render(TaskTable, { props: { tasks: mixed, phase: "running", onOpenDiff: () => {} } });
		await rerender({ tasks: mutated, phase: "running" });
		expect(rowIds(container)).toEqual(["x-todo", "y-todo"]);
	});
});

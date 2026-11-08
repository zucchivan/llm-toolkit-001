// @vitest-environment jsdom
/**
 * TaskTable component test (§15.1 task-table sorting/filtering, M3 hardening):
 * plan order is the stable default; the toggle sorts failing-first by status.
 * (Row FILTERING is a documented deferral — see ui/README "What M3 adds".)
 */
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import TaskTable from "../src/components/TaskTable.svelte";
import type { KitTaskView } from "../../src/engine/inspector.ts";

afterEach(() => cleanup());

function task(id: string, status: KitTaskView["status"], deps: string[] = []): KitTaskView {
	return { id, title: id, status, waveCount: 1, dependsOn: deps, targetPaths: ["src/"], priority: 1, feedback: 0 } as KitTaskView;
}

/** The plan order deliberately interleaves statuses. */
const tasks: KitTaskView[] = [task("a-done", "done", []), task("b-q", "quarantined", []), task("c-live", "in_progress", []), task("d-todo", "todo", [])];

const rowIds = (root: HTMLElement): string[] => Array.from(root.querySelectorAll("table tbody tr td:nth-child(2)")).map((td) => (td as HTMLElement).textContent ?? "");

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

// @vitest-environment jsdom
/**
 * Conversation visibility components (§7.5, M4-a stage 1 + stage 2): the list
 * panel (grouping, kind empty state in side-cars mode, row → drawer callback),
 * the read-only drawer (summary fields + targetPaths + truncation note PLUS
 * the A.5 transcript excerpt: kind-labeled rows, collapsed tool results,
 * truncated/lock-busy/error states), and the task-table highlight that links
 * a conversation to its task row.
 */
import { describe, expect, it, afterEach, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import ConversationPanel from "../src/components/ConversationPanel.svelte";
import ConversationDrawer from "../src/components/ConversationDrawer.svelte";
import TaskTable from "../src/components/TaskTable.svelte";
import type { ConvSummary, ConvEntryView } from "../../src/engine/inspector.ts";
import type { KitTaskView } from "../../src/engine/inspector.ts";

afterEach(() => cleanup());

/** The A.5 excerpt the drawer's fetch resolves to (until a test overrides it). */
const excerptEntries: ConvEntryView[] = [
	{ id: 1, kind: "pi.user", role: "user", ts: 1_700_000_000_000, text: "implement src/list.ts per the spec." },
	{ id: 2, kind: "pi.assistant", role: "assistant", ts: 1_700_000_000_500, stopReason: "toolUse", text: "writing the file now", toolCalls: [{ name: "write", input: '{"path":"src/list.ts"}' }] },
	{ id: 3, kind: "pi.tool-result", role: "toolResult", ts: 1_700_000_001_000, text: "wrote src/list.ts (24 lines)", isError: false },
	{ id: 4, kind: "pi.assistant", role: "assistant", ts: 1_700_000_001_500, stopReason: "stop", text: "STATUS: COMPLETE" },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	// The drawer owns its excerpt fetch (DiffViewer pattern); jsdom has no server,
	// so every mount below rides this stub. resolveExcerpt lets a test answer a
	// payload, the lock-busy sentence, or a failure instead.
	fetchMock = vi.fn().mockResolvedValue({
		ok: true,
		json: async () => ({ at: 1, conversation: 2, entries: excerptEntries, truncated: false }),
	});
	vi.stubGlobal("fetch", fetchMock);
});

function resolveExcerpt(over: { entries?: ConvEntryView[]; truncated?: boolean }): void {
	fetchMock.mockResolvedValue({
		ok: true,
		json: async () => ({ at: 1, conversation: 2, entries: over.entries ?? excerptEntries, truncated: over.truncated ?? false }),
	});
}

function rejectExcerpt(message: string): void {
	fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: message }) });
}

function conv(over: Partial<ConvSummary> & Pick<ConvSummary, "id" | "role">): ConvSummary {
	return {
		entries: 0,
		resets: 0,
		compactions: 0,
		toolRounds: 0,
		byKind: {},
		entriesTruncated: false,
		usage: { usd: 0, totalTokens: 0 },
		...over,
	};
}

const sample: ConvSummary[] = [
	conv({ id: 1, role: "planner", entries: 30, byKind: { "pi.message": 28, "pi.reset": 2 }, resets: 2, usage: { usd: 0.11, totalTokens: 9000 } }),
	conv({ id: 2, role: "implementer", task: "list-parse", targetPaths: ["src/list.ts", "src/list.test.ts"], entries: 40, byKind: { "pi.message": 30, "pi.tool-result": 10 }, toolRounds: 10, usage: { usd: 0.42, totalTokens: 21000 } }),
	conv({ id: 3, role: "implementer", task: "list-parse", entries: 25, compactions: 1, entriesTruncated: true, byKind: { "pi.message": 20, "pi.tool-result": 5 }, toolRounds: 5, usage: { usd: 0.2, totalTokens: 12000 } }),
	conv({ id: 4, role: "verifier", entries: 6, usage: { usd: 0.02, totalTokens: 3000 } }),
];

describe("ConversationPanel (§7.5 list)", () => {
	it("groups in order (planner → task → verifier) and renders summary fields per row", () => {
		const { container } = render(ConversationPanel, {
			props: { conversations: sample, taskOrder: ["list-parse"], hasStorage: true, open: true, onToggle: () => {}, onOpen: () => {} },
		});
		const groups = Array.from(container.querySelectorAll(".convgroup")).map((el) => el.textContent);
		expect(groups).toEqual(["planner", "task · list-parse", "verifier"]);
		// both implementer conversations under one task group, ids ascending
		expect(screen.getByRole("button", { name: /conversation 2 — implementer for list-parse, 40 entries/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /conversation 3 — implementer for list-parse, 25 entries/ })).toBeTruthy();
		// spend + tokens render
		expect(screen.getByRole("button", { name: /conversation 2/ }).textContent).toContain("$0.42");
		expect(screen.getByRole("button", { name: /conversation 2/ }).textContent).toContain("21,000 tok");
		// byKind is present (compact form, prefixed kind names trimmed of pi.)
		expect(screen.getByRole("button", { name: /conversation 2/ }).textContent).toContain("tool-result×10");
	});

	it("a truncated entry scan shows the truncated chip with a floor count", () => {
		render(ConversationPanel, { props: { conversations: sample, taskOrder: [], hasStorage: true, open: true, onToggle: () => {}, onOpen: () => {} } });
		const row = screen.getByRole("button", { name: /conversation 3/ });
		expect(row.textContent).toContain("≥25 entries");
		expect(row.textContent).toContain("truncated");
	});

	it("row click opens the drawer via onOpen with the conversation id", async () => {
		const onOpen = vi.fn();
		render(ConversationPanel, { props: { conversations: sample, taskOrder: [], hasStorage: true, open: true, onToggle: () => {}, onOpen } });
		await fireEvent.click(screen.getByRole("button", { name: /conversation 4 — verifier/ }));
		expect(onOpen).toHaveBeenCalledWith(4);
	});

	it("without storage: the kind empty state, no rows, no spinner", () => {
		render(ConversationPanel, { props: { conversations: undefined, taskOrder: [], hasStorage: false, open: true, onToggle: () => {}, onOpen: () => {} } });
		expect(screen.getByTestId("conv-empty-lock").textContent).toMatch(/conversation detail returns when the lock is free — a run is live/);
		expect(screen.queryByRole("button", { name: /conversation \d/ })).toBeNull();
	});

	it("storage mode with no conversations yet: a plain empty state", () => {
		render(ConversationPanel, { props: { conversations: [], taskOrder: [], hasStorage: true, open: true, onToggle: () => {}, onOpen: () => {} } });
		expect(screen.getByText(/no conversations yet/)).toBeTruthy();
	});

	it("the header toggle reports the count and total spend", () => {
		render(ConversationPanel, { props: { conversations: sample, taskOrder: [], hasStorage: true, open: true, onToggle: () => {}, onOpen: () => {} } });
		const toggle = screen.getByRole("button", { name: /conversations · 4/ });
		expect(toggle.textContent).toContain("$0.75 total");
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
	});
});

describe("ConversationDrawer (§7.5 summary view)", () => {
	it("renders role, id, task, counters, byKind, spend, and targetPaths", async () => {
		render(ConversationDrawer, { props: { conv: sample[1]! } });
		expect(screen.getByText("implementer")).toBeTruthy();
		expect(screen.getByText(/conversation #2/)).toBeTruthy();
		expect(screen.getByText("list-parse")).toBeTruthy();
		expect(screen.getByText("40")).toBeTruthy();
		// "10" shows up twice: the tool-rounds stat and the byKind row — both are wanted
		expect(screen.getAllByText("10").length).toBeGreaterThanOrEqual(2);
		expect(screen.getByText(/\$0\.42/)).toBeTruthy();
		expect(screen.getByText(/21,000 tokens/)).toBeTruthy();
		// byKind rows + target paths
		expect(screen.getByText("pi.tool-result")).toBeTruthy();
		expect(screen.getByText("src/list.ts")).toBeTruthy();
		expect(screen.getByText("src/list.test.ts")).toBeTruthy();
		// the excerpt was asked for (A.5 fetch) and resolved to the entry rows
		expect(fetchMock).toHaveBeenCalledWith("/api/conversations/2/entries");
		expect(await screen.findByText("implement src/list.ts per the spec.")).toBeTruthy();
	});

	it("a truncated conversation explains the floor, not exact", () => {
		render(ConversationDrawer, { props: { conv: sample[2]! } });
		expect(screen.getByText(/counts are a floor, not exact/)).toBeTruthy();
		expect(screen.getByText("≥25")).toBeTruthy();
	});

	it("a task-less conversation says what it is instead of a blank task", async () => {
		render(ConversationDrawer, { props: { conv: sample[0]! } });
		expect(screen.getByText("the planning conversation")).toBeTruthy();
		await screen.findByText(/STATUS: COMPLETE/);
	});
});

describe("ConversationDrawer transcript excerpt (A.5, stage 2)", () => {
	it("kind-labeled rows with timestamps; tool calls named; tool results start collapsed", async () => {
		render(ConversationDrawer, { props: { conv: sample[1]! } });
		// kind labels (pi. trimmed; tool calls named; stop reason shown)
		expect(await screen.findByText("user")).toBeTruthy();
		expect(screen.getByText("assistant · write")).toBeTruthy();
		expect(screen.getByText("stop: toolUse")).toBeTruthy();
		expect(screen.getByText("stop: stop")).toBeTruthy();
		// the tool call renders name + JSON input
		expect(screen.getByText("⚙")).toBeTruthy();
		expect(screen.getByText('{"path":"src/list.ts"}')).toBeTruthy();
		// the assistant's text renders, the tool result body does NOT (collapsed)
		expect(screen.getByText("writing the file now")).toBeTruthy();
		expect(screen.queryByText("wrote src/list.ts (24 lines)")).toBeNull();
		expect(screen.getByRole("button", { name: /show result/ })).toBeTruthy();
		// expanding reveals the result body
		await fireEvent.click(screen.getByRole("button", { name: /show result/ }));
		expect(screen.getByText("wrote src/list.ts (24 lines)")).toBeTruthy();
		expect(screen.getByRole("button", { name: /hide result/ })).toBeTruthy();
	});

	it("a window cut at the cap says so — bounded excerpt, no pagination", async () => {
		resolveExcerpt({ entries: excerptEntries, truncated: true });
		render(ConversationDrawer, { props: { conv: sample[1]! } });
		expect((await screen.findByTestId("excerpt-truncated")).textContent).toMatch(/2,000-entry cap/);
		expect(screen.getByTestId("excerpt-truncated").textContent).toMatch(/no pagination/);
	});

	it("an empty excerpt says so instead of faking rows", async () => {
		resolveExcerpt({ entries: [] });
		render(ConversationDrawer, { props: { conv: sample[1]! } });
		expect(await screen.findByText(/no entries in this conversation yet/)).toBeTruthy();
	});

	it("lock-busy answers with the established empty state (a run owns the lock)", async () => {
		rejectExcerpt("conversation detail returns when the lock is free — a run is live");
		render(ConversationDrawer, { props: { conv: sample[1]! } });
		const banner = await screen.findByTestId("excerpt-lock-busy");
		expect(banner.textContent).toMatch(/conversation detail returns when the lock is free — a run is live/);
	});

	it("other failures quote the server's message in kind words", async () => {
		rejectExcerpt("no conversation #2 in this project");
		render(ConversationDrawer, { props: { conv: sample[1]! } });
		expect(await screen.findByText(/the transcript excerpt didn't load/)).toBeTruthy();
		expect(screen.getByText("no conversation #2 in this project")).toBeTruthy();
	});
});

describe("TaskTable conversation highlight", () => {
	function task(id: string, status: KitTaskView["status"]): KitTaskView {
		return { id, title: id, status, waveCount: 1, dependsOn: [], targetPaths: ["src/"], priority: 1, feedback: 0 } as KitTaskView;
	}
	const tasks = [task("list-parse", "done"), task("render-rows", "todo")];

	it("the linked task row carries the highlight class; others do not", () => {
		const { container } = render(TaskTable, { props: { tasks, phase: "running", onOpenDiff: () => {}, highlight: "list-parse" } });
		const rows = Array.from(container.querySelectorAll("tbody tr"));
		expect(rows[0]!.classList.contains("row-link")).toBe(true);
		expect(rows[1]!.classList.contains("row-link")).toBe(false);
	});

	it("no highlight prop → no row-link classes (diff/live highlighting untouched)", () => {
		const { container } = render(TaskTable, { props: { tasks, phase: "running", onOpenDiff: () => {} } });
		expect(container.querySelectorAll(".row-link")).toHaveLength(0);
	});
});

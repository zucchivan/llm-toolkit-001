// @vitest-environment jsdom
/**
 * ProjectSources component tests (M5-a): the read-only config + PRD viewers —
 * fetch-on-open only (closed = zero requests), ready rendering (chips, paths,
 * raw text, read-only note + refetch), the kind states (missing prd, parse
 * error with raw text still shown, truncate cap, fetch error), and the refetch
 * trigger. The panel fetches via the global fetch (stubbed).
 */
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/svelte";
import ProjectSources from "../src/components/ProjectSources.svelte";
import type { ProjectSourcesPayload } from "../../ui/server/sources.ts";

afterEach(() => cleanup());

function sourcesPayload(over: Partial<ProjectSourcesPayload> = {}): ProjectSourcesPayload {
	return {
		at: 1,
		config: { path: ".orch/config.toml", exists: true, bytes: 120, text: "[roles.planner]\nprovider = \"faux\"\nmodelId = \"kit-planner\"\n" },
		prd: { path: "docs/prd.md", exists: true, bytes: 40, text: "# demo prd\none task.\n" },
		prompt: { path: "PROMPT.md", exists: true, bytes: 10, text: "# PROMPT.md\nrules of the loop.\n" },
		recipes: { path: "evals/recipes.toml", exists: true, bytes: 30, text: "# [lint]\n# cmd = \"npm run lint\"\n" },
		...over,
	};
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => sourcesPayload() });
	vi.stubGlobal("fetch", fetchMock);
});

function openPanel(configError?: string): void {
	render(ProjectSources, { props: { open: true, configError, onToggle: () => {} } });
}

describe("ProjectSources (M5-a viewers)", () => {
	it("closed panel: zero fetches (fetch on open + refetch only — no polling loops)", () => {
		render(ProjectSources, { props: { open: false, onToggle: () => {} } });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(screen.getByText(/sources · config \+ prd \+ prompt \+ recipes/)).toBeTruthy();
	});

	it("open + ready: config and prd raw text, chips, paths, byte counts, and the read-only note; re-open refetches (fresh reads, not polling)", async () => {
		const { unmount } = render(ProjectSources, { props: { open: true, onToggle: () => {} } });
		await waitFor(() => expect(screen.getByTestId("sources-config-text")).toBeTruthy());
		expect(fetchMock).toHaveBeenCalledWith("/api/project/sources");
		// reopen → a fresh fetch (it is a static file view; the refetch button stays)
		unmount();
		fetchMock.mockClear();
		openPanel();
		await waitFor(() => expect(screen.getByTestId("sources-config-text")).toBeTruthy());
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith("/api/project/sources");
		expect(screen.getByTestId("sources-config-text").textContent).toContain('[roles.planner]');
		expect(screen.getByTestId("sources-prd-text").textContent).toContain("# demo prd");
		expect(screen.getByTestId("sources-prompt-text").textContent).toContain("rules of the loop");
		expect(screen.getByTestId("sources-recipes-text").textContent).toContain("npm run lint");
		expect(screen.getByText(".orch/config.toml")).toBeTruthy();
		expect(screen.getByText("docs/prd.md")).toBeTruthy();
		expect(screen.getByText("PROMPT.md")).toBeTruthy();
		expect(screen.getByText("evals/recipes.toml")).toBeTruthy();
		expect(screen.getByText("120 bytes")).toBeTruthy();
		expect(screen.getByText("40 bytes")).toBeTruthy();
		expect(screen.getByText("10 bytes")).toBeTruthy();
		expect(screen.getByText("30 bytes")).toBeTruthy();
		// verdict chips: one per file, all ok — and the header says so
		const chips = screen.getAllByText("ok");
		expect(chips.length).toBeGreaterThanOrEqual(4);
		expect(screen.getByText("ok · all four")).toBeTruthy();
		// the no-mutation promise is on the panel, not just in the PRD
		expect(screen.getByText(/the ui never writes these files/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "refetch" })).toBeTruthy();
	});

	it("missing prd: amber missing chip + the kind sentence with the path", async () => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => sourcesPayload({ prd: { path: "docs/prd.md", exists: false, bytes: 0 } }) });
		vi.stubGlobal("fetch", fetchMock);
		openPanel();
		await waitFor(() => expect(screen.getByTestId("sources-prd-missing")).toBeTruthy());
		expect(screen.getByTestId("sources-prd-missing").textContent).toContain("docs/prd.md");
		expect(screen.getByTestId("sources-prd-missing").textContent).toContain("write it");
		expect(screen.queryByTestId("sources-prd-text")).toBeNull();
	});

	it("parse error: red chip + verdict banner + raw text still shown (showing the text is how you fix it)", async () => {
		const payload = sourcesPayload();
		payload.config = { ...payload.config, parseError: "config.toml is not valid TOML: unexpected 'x' at line 2" };
		fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
		vi.stubGlobal("fetch", fetchMock);
		openPanel();
		await waitFor(() => expect(screen.getByTestId("sources-config-parse-error")).toBeTruthy());
		expect(screen.getByTestId("sources-config-parse-error").textContent).toContain("not valid TOML");
		expect(screen.getByTestId("sources-config-text").textContent).toContain("[roles.planner]");
	});

	it("missing PROMPT.md (M5-b): amber 'absent' chip + the kind sentence (waves still run without it) — header surfaces it", async () => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => sourcesPayload({ prompt: { path: "PROMPT.md", exists: false, bytes: 0 } }) });
		vi.stubGlobal("fetch", fetchMock);
		openPanel();
		await waitFor(() => expect(screen.getByTestId("sources-prompt-missing")).toBeTruthy());
		expect(screen.getByTestId("sources-prompt-missing").textContent).toContain("PROMPT.md");
		expect(screen.getByTestId("sources-prompt-missing").textContent).toContain("every wave");
		expect(screen.getByTestId("sources-prompt-missing").textContent).toContain("llm-toolkit-001 init");
		// absences announce in the header too (worst fact wins: chip + header)
		expect(screen.getAllByText("absent").length).toBeGreaterThanOrEqual(2);
		expect(screen.queryByTestId("sources-prompt-text")).toBeNull();
	});

	it("recipes absent (M5-b): a DEFINED state — green 'ok · absent' chip + the empty-gates sentence; header stays ok", async () => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => sourcesPayload({ recipes: { path: "evals/recipes.toml", exists: false, bytes: 0 } }) });
		vi.stubGlobal("fetch", fetchMock);
		openPanel();
		await waitFor(() => expect(screen.getByTestId("sources-recipes-missing")).toBeTruthy());
		expect(screen.getByTestId("sources-recipes-missing").textContent).toContain("evals/recipes.toml");
		expect(screen.getByTestId("sources-recipes-missing").textContent).toContain("scope check only");
		// green, not amber: the chip label says ok · absent, and the header counts all four as ok
		expect(screen.getAllByText("ok · absent").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("ok · all four")).toBeTruthy();
		expect(screen.queryByTestId("sources-recipes-text")).toBeNull();
	});

	it("broken recipes (M5-b): the gate loader's verdict, red chip, raw text still served; header shows parse error", async () => {
		const payload = sourcesPayload();
		payload.recipes = { ...payload.recipes, parseError: "evals/recipes.toml is unreadable/invalid: recipes.toml: [broken-gate] needs cmd = \"…\"" };
		fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
		vi.stubGlobal("fetch", fetchMock);
		openPanel();
		await waitFor(() => expect(screen.getByTestId("sources-recipes-parse-error")).toBeTruthy());
		expect(screen.getByTestId("sources-recipes-parse-error").textContent).toContain("needs cmd");
		expect(screen.getByTestId("sources-recipes-parse-error").textContent).toContain("gate step");
		expect(screen.getByTestId("sources-recipes-text").textContent).toContain("npm run lint");
	});

	it("truncation: capped chips + per-file cap notice; the byte count stays the file's truth", async () => {
		const payload = sourcesPayload({
			prd: { path: "docs/prd.md", exists: true, bytes: 6 * 1024 * 1024, text: "first 5 MiB…", truncated: true },
		});
		fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
		vi.stubGlobal("fetch", fetchMock);
		openPanel();
		await waitFor(() => expect(screen.getByTestId("sources-prd-truncated")).toBeTruthy());
		expect(screen.getByTestId("sources-prd-truncated").textContent).toContain("capped");
		expect(screen.getByText("6,291,456 bytes")).toBeTruthy();
		// the label rides both the prd chip and the header note
		expect(screen.getAllByText("ok · capped").length).toBe(2);
	});

	it("fetch failure: a kind error banner, not silence; refetch retries", async () => {
		fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: "server hiccup" }) });
		vi.stubGlobal("fetch", fetchMock);
		openPanel();
		await waitFor(() => expect(screen.getByText("the sources didn't load.")).toBeTruthy());
		expect(screen.getByText("server hiccup")).toBeTruthy();

		// refetch → another fetch; success replaces the banner
		fetchMock.mockResolvedValue({ ok: true, json: async () => sourcesPayload() });
		fireEvent.click(screen.getByRole("button", { name: "refetch" }));
		await waitFor(() => expect(screen.getByTestId("sources-prd-text")).toBeTruthy());
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("snapshot's configError colors the header before any fetch lands (closed panel, no request)", () => {
		render(ProjectSources, { props: { open: false, configError: "config.toml is not valid TOML: boom", onToggle: () => {} } });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(screen.getByText("parse error")).toBeTruthy();
	});
});

describe("view.ts sourceChip (pure)", () => {
	it("worst fact wins: parse error > capped > binary > missing > ok", async () => {
		const { sourceChip } = await import("../src/lib/view.ts");
		expect(sourceChip({ exists: true }, "bad toml").kind).toBe("parse-error");
		expect(sourceChip({ exists: true, truncated: true }).label).toBe("ok · capped");
		expect(sourceChip({ exists: true, binary: true }).label).toBe("binary");
		expect(sourceChip({ exists: true, truncated: true, binary: true }).kind).toBe("capped");
		expect(sourceChip({ exists: false }).label).toBe("missing");
		expect(sourceChip({ exists: true }).label).toBe("ok");
	});

	it("M5-b chips: prompt absence is a WARN (absent), recipes absence is DEFINED (ok · absent), recipes parse error wins", async () => {
		const { promptChip, recipesChip } = await import("../src/lib/view.ts");
		expect(promptChip({ exists: false, binary: true }).label).toBe("absent");
		expect(promptChip({ exists: true }).label).toBe("ok");
		expect(promptChip({ exists: true, truncated: true }).label).toBe("ok · capped");
		expect(recipesChip({ exists: false, binary: true }).kind).toBe("ok");
		expect(recipesChip({ exists: false }).label).toBe("ok · absent");
		expect(recipesChip({ exists: true }, "unreadable").kind).toBe("parse-error");
		expect(recipesChip({ exists: true }).label).toBe("ok");
	});

	it("M5-b header summary: severity beats position — a red recipes verdict outranks an amber prompt absence", async () => {
		const { worstSourceChip, sourceChip, promptChip, recipesChip } = await import("../src/lib/view.ts");
		expect(worstSourceChip([])).toBeUndefined();
		expect(worstSourceChip([sourceChip({ exists: true }), recipesChip({ exists: false })])?.label).toBe("ok");
		const ranked = worstSourceChip([sourceChip({ exists: true }), promptChip({ exists: false }), recipesChip({ exists: true }, "bad")]);
		expect(ranked?.kind).toBe("parse-error");
		const amber = worstSourceChip([sourceChip({ exists: true }), promptChip({ exists: false }), recipesChip({ exists: false })]);
		expect(amber?.label).toBe("absent");
	});
});

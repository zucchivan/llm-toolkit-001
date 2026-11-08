// @vitest-environment jsdom
/**
 * HealthPanel component tests (M3 F decision: @testing-library/svelte mounts
 * the real component; state logic stays in the pure derivations covered by
 * view.test.ts). Order, skip labeling, collapse behavior, toggle callback.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import HealthPanel from "../src/components/HealthPanel.svelte";
import type { HealthCheck } from "../../src/engine/inspector.ts";

const hc = (id: string, ok: boolean, severity: HealthCheck["severity"], detail = `detail of ${id}`): HealthCheck => ({ id, ok, severity, detail });

const sample: HealthCheck[] = [
	hc("prd", true, "info", "PRD present at docs/prd.md (sha drift check needs the lock)"),
	hc("pin", false, "error", "installed pi-durable 0.1 != tested pin"),
	hc("patches", true, "info", "nothing quarantined"),
	hc("alert", false, "warn", "active alert: rate limit"),
	hc("mirrors", true, "info", "skipped: mirror parity needs the lock"),
];

afterEach(() => cleanup());

describe("HealthPanel", () => {
	it("collapsed by default: the toggle announces aria-expanded=false and shows the failing count", () => {
		render(HealthPanel, { health: sample, open: false, onToggleHealth: () => {} });
		const toggle = screen.getByRole("button", { name: /health/i });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(toggle.textContent).toContain("2 failing");
		// rows are behind the collapse
		expect(screen.queryByText("nothing quarantined")).toBeNull();
	});

	it("open: failing checks (error then warn) render before passing ones, skipped checks carry the label", () => {
		render(HealthPanel, { health: sample, open: true, onToggleHealth: () => {} });
		const rows = screen.getAllByText(/detail of |needs the lock|nothing quarantined|installed pi-durable|active alert/);
		const ids = rows.map((r) => r.closest(".healthrow")?.querySelector(".mono")?.textContent ?? "");
		expect(ids[0]).toContain("pin");
		expect(ids[1]).toContain("alert");
		// skipped-in-degraded chips are labeled (§7.1)
		expect(screen.getAllByText("skipped").length).toBe(2);
	});

	it("toggle click fires onToggleHealth (the header dot and the panel share it)", async () => {
		const onToggleHealth = vi.fn();
		render(HealthPanel, { health: sample, open: false, onToggleHealth });
		await fireEvent.click(screen.getByRole("button", { name: /health/i }));
		expect(onToggleHealth).toHaveBeenCalledTimes(1);
	});

	it("empty health list renders the empty state, not a crash", () => {
		render(HealthPanel, { health: [], open: true, onToggleHealth: () => {} });
		expect(screen.getByText(/no health checks/i)).toBeTruthy();
	});
});

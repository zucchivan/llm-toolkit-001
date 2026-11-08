// @vitest-environment jsdom
/**
 * BudgetBar component tests (M3 §9): spent/ceiling bar + wave-warn/rate line +
 * per-model breakdown, read-only, straight from the readout's usage.
 */
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/svelte";
import BudgetBar from "../src/components/BudgetBar.svelte";
import type { KitUsage } from "../../src/engine/inspector.ts";

afterEach(() => cleanup());

function usage(over: Partial<KitUsage>): KitUsage {
	return {
		sessionUsd: 3,
		tokens: 100,
		ceilingUsd: 4,
		warnUsdPerWave: 0.5,
		wavesExecuted: 2,
		spendRateUsdPerWave: 0.25,
		byModel: {},
		byTask: {},
		source: "storage",
		...over,
	} as KitUsage;
}

describe("BudgetBar", () => {
	it("shows spent/ceiling, the spend rate and wave-warn", () => {
		const { container } = render(BudgetBar, { usage: usage({}) });
		expect(container.textContent).toContain("$3.00");
		expect(container.textContent).toContain("$4.00 ceiling");
		expect(container.textContent).toContain("wave-warn $0.50");
		expect(container.textContent).toContain("rate $0.25/wave");
		const bar = container.querySelector<HTMLElement>(".budgetbar-fill")!;
		expect(bar.style.width).toBe("75%");
	});

	it("over the ceiling the bar turns red and shows ⚠", () => {
		const { container } = render(BudgetBar, { usage: usage({ sessionUsd: 5 }) });
		expect(container.querySelector(".budgetbar-fill.budgetbar-over")).toBeTruthy();
		expect(container.textContent!.includes("⚠")).toBe(true);
	});

	it("lists the per-model breakdown sorted by spend desc; zero spend hides it", () => {
		const { container } = render(BudgetBar, { usage: usage({
			byModel: { "m-b": { usage: {} as never, usd: 1 }, "m-a": { usage: {} as never, usd: 2 } },
		}) });
		const models = Array.from(container.querySelectorAll(".budgetbar-model > .mono:first-child"));
		expect(models.map((el) => el.textContent)).toEqual(["m-a", "m-b"]);

		const empty = render(BudgetBar, { usage: usage({ byModel: {}, sessionUsd: 0 }) });
		expect(empty.container.querySelector(".budgetbar-models")).toBeNull();
		// the read-only progressbar survives with its a11y name + zero value
		const track = empty.container.querySelector('[role="progressbar"][aria-label^="budget"]');
		expect(track).toBeTruthy();
		expect(track!.getAttribute("aria-valuenow")).toBe("0");
	});

	it("no ceiling → the bar stays empty, not 0%", () => {
		const { container } = render(BudgetBar, { usage: usage({ ceilingUsd: 0, sessionUsd: 2 }) });
		expect(container.querySelector<HTMLElement>(".budgetbar-fill")!.style.width).toBe("0%");
	});
});

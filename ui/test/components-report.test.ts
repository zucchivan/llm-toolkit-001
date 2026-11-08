// @vitest-environment jsdom
/**
 * CompletionReport component tests (§8.6): the M4-b delivery section —
 * mode + outcome rows straight from the readout's A.6 delivery section,
 * READ-ONLY. There is deliberately no toggle button: per §5 delivery stays
 * a config + CLI decision (--deliver on run is the pr mode's per-run
 * requirement, not a safe toggle), and config editors stay deferred to M5.
 */
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/svelte";
import CompletionReport from "../src/components/CompletionReport.svelte";
import type { ReadoutSnapshot, JobsPayload } from "../src/lib/api.ts";
import type { KitReadout } from "../../src/engine/inspector.ts";

afterEach(() => cleanup());

function readout(over: Partial<KitReadout> = {}): ReadoutSnapshot {
	return {
		readout: {
			at: 1,
			seam: 1,
			degraded: false,
			identity: { kit: "k", piDurable: "1", root: "/r", at: 1 },
			phase: "complete",
			tasks: [],
			rows: [],
			usage: { sessionUsd: 0, tokens: 0, ceilingUsd: 0, warnUsdPerWave: 0, wavesExecuted: 0, spendRateUsdPerWave: 0, byModel: {}, byTask: {}, source: "storage" },
			timeline: [],
			artifacts: [],
			health: [],
			...over,
		},
		mode: "storage",
		at: 1,
	} as ReadoutSnapshot;
}

const jobs = { jobs: [], attached: undefined } as unknown as JobsPayload;

describe("CompletionReport — delivery section (A.6, read-only)", () => {
	it("shows the configured mode + row count and lists the outcome rows verbatim", () => {
		render(CompletionReport, {
			snapshot: readout({
				tasks: [
					{ id: "t1", title: "one", status: "done", waveCount: 1, dependsOn: [], targetPaths: [], priority: 1, feedback: 0 },
				] as KitReadout["tasks"],
				// delivery rows are echoed into the readout's delivery section, not re-filtered client-side
				rows: [
					{ ts: 1_730_000_000_000, kind: "delivery", task: "t1", wave: 1, verb: "commit-failed", detail: "git commit failed (nothing to commit?)" },
					{ ts: 1_730_000_100_000, kind: "delivery", task: "t1", wave: 1, verb: "delivered", detail: "committed: demo: t1 (wave 1)" },
				],
				delivery: {
					mode: "commit",
					rows: [
						{ ts: 1_730_000_000_000, task: "t1", wave: 1, verb: "commit-failed", detail: "git commit failed (nothing to commit?)" },
						{ ts: 1_730_000_100_000, task: "t1", wave: 1, verb: "delivered", detail: "committed: demo: t1 (wave 1)" },
					],
				},
			}),
			jobs,
			now: 1_730_000_200_000,
			onExport: () => {},
			onOpenDiff: () => {},
		});
		expect(screen.getByText("commit · 2 row(s)")).toBeTruthy();
		expect(document.body.textContent).toContain("delivered — committed: demo: t1 (wave 1)");
		expect(document.body.textContent).toContain("commit-failed — git commit failed (nothing to commit?)");
	});

	it("mode none with no rows states 'none'; the delivery stat stays read-only (no button, kind title)", () => {
		render(CompletionReport, {
			snapshot: readout({ delivery: { mode: "none", rows: [] } }),
			jobs,
			now: 1_730_000_200_000,
			onExport: () => {},
			onOpenDiff: () => {},
		});
		expect(screen.getByText("none")).toBeTruthy();
		expect(document.body.textContent).not.toContain("no delivery rows yet");
		const stat = screen.getByText("none").closest(".stat")!;
		expect(stat.querySelector("button")).toBeNull();
		expect(stat.querySelector(".big")!.getAttribute("title")).toContain("config + CLI decision");
	});

	it("non-none mode with no rows yet gets the kind 'no delivery rows yet' note", () => {
		render(CompletionReport, {
			snapshot: readout({ delivery: { mode: "commit", rows: [] } }),
			jobs,
			now: 1_730_000_200_000,
			onExport: () => {},
			onOpenDiff: () => {},
		});
		expect(screen.getByText("commit")).toBeTruthy();
		expect(document.body.textContent).toContain("no delivery rows yet");
		expect(document.body.textContent).toContain("config mode is commit");
	});

	it("an unreadable config in side-car mode: rows-only stat says the mode is unknown", () => {
		render(CompletionReport, {
			snapshot: readout({
				degraded: true,
				delivery: { rows: [{ ts: 1_730_000_100_000, task: "t1", verb: "delivered", detail: "committed: demo: t1 (wave 1)" }] },
			}),
			jobs,
			now: 1_730_000_200_000,
			onExport: () => {},
			onOpenDiff: () => {},
		});
		expect(screen.getByText("1 delivery row(s) — mode unknown")).toBeTruthy();
	});
});

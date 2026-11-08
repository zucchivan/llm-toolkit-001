/** Client formatting helpers (pure; runs under node). */
import { describe, expect, it } from "vitest";
import { clockTime, healthLevel, msDuration, phaseLabel, relativeAge, STATUS_GLYPH, usd } from "../src/lib/format.ts";

describe("format helpers", () => {
	it("usd", () => {
		expect(usd(0)).toBe("$0.00");
		expect(usd(1.005)).toBe("$1.00"); // toFixed semantics (1.005 sits below the tie in binary)
		expect(usd(123.4)).toBe("$123");
		expect(usd(Number.NaN)).toBe("$0.00");
	});

	it("msDuration", () => {
		expect(msDuration(0)).toBe("0s");
		expect(msDuration(9_500)).toBe("9s");
		expect(msDuration(65_000)).toBe("1m05s");
		expect(msDuration(3_700_000)).toBe("1h01m");
		expect(msDuration(-5)).toBe("0s");
	});

	it("clockTime renders HH:MM:SS", () => {
		expect(clockTime(Date.UTC(2026, 0, 1, 9, 5, 3))).toBe("09:05:03");
		expect(clockTime(Number.NaN)).toBe("--:--:--");
	});

	it("relativeAge", () => {
		expect(relativeAge(200)).toBe("just now");
		expect(relativeAge(61_000)).toBe("1m01s ago");
	});

	it("STATUS_GLYPH covers all task statuses with glyph + label", () => {
		for (const status of ["todo", "in_progress", "done", "quarantined"] as const) {
			expect(STATUS_GLYPH[status]?.glyph).toBeTruthy();
			expect(STATUS_GLYPH[status]?.label).toBeTruthy();
		}
	});

	it("healthLevel: errors first, then warn, else ok", () => {
		expect(healthLevel(undefined)).toBe("unknown");
		expect(healthLevel({ health: [{ ok: true, severity: "info" }, { ok: true, severity: "error" }] })).toBe("ok");
		expect(healthLevel({ health: [{ ok: false, severity: "warn" }] })).toBe("warn");
		expect(healthLevel({ health: [{ ok: false, severity: "warn" }, { ok: false, severity: "error" }] })).toBe("error");
	});

	it("phaseLabel maps the kit phase vocabulary", () => {
		expect(phaseLabel("empty")).toBe("no plan");
		expect(phaseLabel("wave-running")).toBe("running");
		expect(phaseLabel("weird")).toBe("weird");
	});
});

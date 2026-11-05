/**
 * Test fixtures (§7): faux provider (scripted model outputs), configurable
 * MemoryStorage-or-SQLite storage, injectable fake clock, and a tiny demo
 * project scaffold helper that walks the REAL init template set.
 */
import { createModels } from "@earendil-works/pi-ai/models";
import type { Models } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxProviderHandle, FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { SetTimer } from "./kit-types.ts";

/** Fresh FakeClock per use (setTimer wiring must match one harness at a time). */
export function fakeClockFor() {
	return new FakeClock();
}
export { FakeClock as FakeClockClass };

export { MemoryStorage };
export type { FauxProviderHandle, Models, SetTimer };
export { fauxAssistantMessage, fauxText, fauxToolCall };

// ---------------------------------------------------------------------------
// Faux models (scripted)
// ---------------------------------------------------------------------------

export const FAUX_PROVIDER = "faux";
export const FAUX_MODELS = { planner: "kit-planner", impl: "kit-impl", verifier: "kit-verifier" } as const;

export function buildFauxModels(responses: FauxResponseStep[]): { models: Models; faux: FauxProviderHandle } {
	const faux = fauxProvider({
		models: [
			{ id: FAUX_MODELS.planner, name: "Kit Planner", cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } },
			{ id: FAUX_MODELS.impl, name: "Kit Impl", cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } },
			{ id: FAUX_MODELS.verifier, name: "Kit Verifier", cost: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 } },
		],
	});
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, faux };
}

/** Config rates for budget-math tests (faux has no provider-computed cost). */
export const FAUX_RATES = {
	[FAUX_MODELS.planner]: 2,
	[FAUX_MODELS.impl]: 8,
	builder: 0,
	verifier: 4,
};

// ---------------------------------------------------------------------------
// Fake clock: injectable now/setTimer matching pi-durable's expectations
// ---------------------------------------------------------------------------

export class FakeClock {
	private current = 1_700_000_000_000;
	private timers: { when: number; fn: () => void; id: number; armed: boolean }[] = [];
	private nextId = 1;

	now = (): number => this.current;

	setTimer: SetTimer = (fn: () => void, ms: number) => {
		const id = this.nextId++;
		const timer = { id, fn, when: this.current + Math.max(0, ms), armed: true };
		this.timers.push(timer);
		const cancel = () => {
			timer.armed = false;
		};
		this.timers = this.timers.filter((t) => t.armed);
		return cancel;
	};

	/** Advance; fires due timers in order, allowing new timers inside callbacks. */
	advance(ms: number): void {
		const target = this.current + ms;
		this.current = Math.min(target, ...this.timers.filter((t) => t.when > this.current).map((t) => t.when).concat(target));
		this.fireDue();
	}

	private fireDue(): void {
		for (;;) {
			const due = this.timers.filter((t) => t.armed && t.when <= this.current).sort((a, b) => a.when - b.when)[0];
			if (!due) return;
			due.armed = false;
			due.fn();
		}
	}

	setAbsolute(when: number): void {
		this.current = Math.max(this.current, when);
		this.fireDue();
	}
}

// ---------------------------------------------------------------------------
// Demo project fixture: real template files in a tmp dir (Vitest tmpdir)
// ---------------------------------------------------------------------------

export { prepareDemoProject } from "./demo-project.ts";

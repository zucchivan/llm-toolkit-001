/** Budget math: pi-ai `Usage` totals in USD with config-rate fallbacks. */

export interface CostRates {
	/** USD cost per 1M input tokens; absent: catalog cost only. */
	costPerMillionInput?: number;
	/** USD cost per 1M output tokens; absent: catalog cost only. */
	costPerMillionOutput?: number;
}

export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

/**
 * USD estimate for one usage record:
 * 1. provider-reported / catalog `cost.total` when truthy;
 * 2. else config rates applied to input (+cacheRead) and output tokens, scaled to 1M;
 * 3. else 0 — and the governor treats unknown spend as "unknown, warn-only".
 */
export function usageUsd(usage: UsageLike, rates: CostRates | undefined): number {
	if (usage.cost && usage.cost.total > 0) return usage.cost.total;
	if (rates && (rates.costPerMillionInput || rates.costPerMillionOutput)) {
		const payInput = (usage.input + usage.cacheRead + usage.cacheWrite / 1) || usage.input;
		const rateIn = rates.costPerMillionInput ?? 0;
		const rateOut = rates.costPerMillionOutput ?? 0;
		return (payInput / 1_000_000) * rateIn + (usage.output / 1_000_000) * rateOut;
	}
	return 0;
}

/** True when the cost figure for this usage is provider/catalog reported, not derived. */
export function costIsReported(usage: UsageLike): boolean {
	return Boolean(usage.cost && usage.cost.total > 0);
}

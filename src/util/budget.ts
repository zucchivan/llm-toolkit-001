/** Budget math: pi-ai `Usage` totals in USD with config-rate and catalog fallbacks. */

export interface CostRates {
	/** USD cost per 1M input tokens; absent: catalog cost only. */
	costPerMillionInput?: number;
	/** USD cost per 1M output tokens; absent: catalog cost only. */
	costPerMillionOutput?: number;
	/** USD cost per 1M cache-read tokens; absent: an observed cache-read delta is unpriceable. */
	costPerMillionCacheRead?: number;
	/** USD cost per 1M cache-write tokens; absent: an observed cache-write delta is unpriceable. */
	costPerMillionCacheWrite?: number;
}

/** Provider-catalog rates for one model class (USD per 1M tokens), from the Models registry. */
export interface CatalogClassRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
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
 * The pricing decision for one usage record. `unknown` is a FIRST-CLASS
 * result: an observed spend that cannot be priced is never silently labeled
 * free — the budget admission refuses the next paid submission with this
 * reason instead.
 */
export type UsagePricing =
	| { kind: "priced"; usd: number }
	| { kind: "unknown"; reason: string };

export interface PriceContext {
	/** `provider/modelId` split for the faux simulated-zero exemption. */
	providerId?: string;
	/** Config rates when the class names a configured role (`roles.*.costPerMillion*`). */
	configRates?: CostRates;
	/** Catalog rates when the class is listed in the Models registry; an ALL-ZERO
	 *  catalog means "no price data" and does NOT count as a price. */
	catalogRates?: CatalogClassRates;
}

/**
 * Price one usage record, most-authoritative source first:
 *
 *  1. provider/SDK-reported `cost.total` when truthy — cache classes included;
 *  2. nothing spent (all token classes zero) — priced at zero;
 *  3. catalog rates (any nonzero) from the Models registry — the provider's
 *     own price list covers every token class at its class rate (a fixture
 *     catalog may declare zero cache rates: simulated zero is a legitimate
 *     reported price);
 *  4. config role rates — the operator's fallback for when the provider/
 *     catalog cost is missing: input/output are priced; a NONZERO cache
 *     delta with no configured cache rate is UNKNOWN (never folded into the
 *     input rate — no flat-input approximation);
 *  5. the faux provider's explicit zero-cost report — fixtures/replays
 *     simulate zero cost; that is a known zero, not an unknown;
 *  6. otherwise UNKNOWN — a previously used nonzero class with no price
 *     source must not be treated as free.
 */
export function priceUsage(usage: UsageLike, ctx: PriceContext): UsagePricing {
	if (usage.cost && usage.cost.total > 0) return { kind: "priced", usd: usage.cost.total };
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	if (tokens <= 0) return { kind: "priced", usd: 0 };
	const catalog = ctx.catalogRates;
	if (catalog && (catalog.input || catalog.output || catalog.cacheRead || catalog.cacheWrite)) {
		if (usage.input > 0 && !Number.isFinite(catalog.input)) return { kind: "unknown", reason: "catalog has no finite input price for the class" };
		if (usage.output > 0 && !Number.isFinite(catalog.output)) return { kind: "unknown", reason: "catalog has no finite output price for the class" };
		if (usage.cacheRead > 0 && !Number.isFinite(catalog.cacheRead)) return { kind: "unknown", reason: "catalog has no finite cache-read price for the class" };
		if (usage.cacheWrite > 0 && !Number.isFinite(catalog.cacheWrite)) return { kind: "unknown", reason: "catalog has no finite cache-write price for the class" };
		const usd = (usage.input / 1_000_000) * catalog.input
			+ (usage.output / 1_000_000) * catalog.output
			+ (usage.cacheRead / 1_000_000) * catalog.cacheRead
			+ (usage.cacheWrite / 1_000_000) * catalog.cacheWrite;
		return { kind: "priced", usd };
	}
	const config = ctx.configRates;
	if (config && (config.costPerMillionInput || config.costPerMillionOutput || config.costPerMillionCacheRead || config.costPerMillionCacheWrite)) {
		if (usage.cacheRead > 0 && !config.costPerMillionCacheRead) {
			return { kind: "unknown", reason: "observed cache-read tokens have no configured or reported price" };
		}
		if (usage.cacheWrite > 0 && !config.costPerMillionCacheWrite) {
			return { kind: "unknown", reason: "observed cache-write tokens have no configured or reported price" };
		}
		const usd = (usage.input / 1_000_000) * (config.costPerMillionInput ?? 0)
			+ (usage.output / 1_000_000) * (config.costPerMillionOutput ?? 0)
			+ (usage.cacheRead / 1_000_000) * (config.costPerMillionCacheRead ?? 0)
			+ (usage.cacheWrite / 1_000_000) * (config.costPerMillionCacheWrite ?? 0);
		return { kind: "priced", usd };
	}
	// The faux provider always reports an explicit all-zero cost object; fixtures
	// and replays legitimately simulate zero cost. That is a reported zero.
	if (ctx.providerId === "faux" && usage.cost && typeof usage.cost.total === "number") {
		return { kind: "priced", usd: 0 };
	}
	return { kind: "unknown", reason: "previously used nonzero class has no SDK-reported cost, catalog price, or config rates — refusing to label it free" };
}

/**
 * DISPLAY-ONLY estimate (USD) for one usage record — readouts and status
 * panels, never an admission decision. Reported cost wins; else config rates
 * price input/output (cache deltas are NOT folded into the input rate and are
 * not priced here); else 0. Admission uses `priceUsage`, which can refuse.
 */
export function usageUsd(usage: UsageLike, rates: CostRates | undefined): number {
	if (usage.cost && usage.cost.total > 0) return usage.cost.total;
	if (rates && (rates.costPerMillionInput || rates.costPerMillionOutput)) {
		return ((usage.input / 1_000_000) * (rates.costPerMillionInput ?? 0))
			+ ((usage.output / 1_000_000) * (rates.costPerMillionOutput ?? 0));
	}
	return 0;
}

/** True when the cost figure for this usage is provider/catalog reported, not derived. */
export function costIsReported(usage: UsageLike): boolean {
	return Boolean(usage.cost && usage.cost.total > 0);
}

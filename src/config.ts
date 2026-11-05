/**
 * Project config loader: `.orch/config.toml`, simple schema, defaults,
 * errors in plain words. No secrets live here (env provides credentials).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as toml from "smol-toml";

export const KIT_VERSION = "0.1.0";

export type RoleName = "planner" | "implementer" | "verifier";
export const ROLES: readonly RoleName[] = ["planner", "implementer", "verifier"];

export interface RoleConfig {
	provider: string;
	modelId: string;
	thinkingLevel?: "off" | "low" | "medium" | "high";
	costPerMillionInput?: number;
	costPerMillionOutput?: number;
}

export interface Budgets {
	sessionUsd: number;
	waveUsdWarn: number;
	maxConsecutiveErrors: number;
	maxSleepCycles: number;
}

export interface GatesConfig {
	timeoutSec: number;
	enforceTargetPaths: boolean;
	/** When true, an approving verifier must also survive a skeptic second pass. */
	skepticSecondPass: boolean;
}

export interface DeliveryConfig {
	mode: "none" | "commit" | "pr";
}

export interface PathsConfig {
	prd: string;
	specs: string;
}

export interface EngineConfig {
	piDurable: string;
	maxTurns: number;
	retryLimit: number;
}

export interface KitConfig {
	root: string;
	engine: EngineConfig;
	roles: Record<RoleName, RoleConfig>;
	budgets: Budgets;
	gates: GatesConfig;
	delivery: DeliveryConfig;
	paths: PathsConfig;
}

export const DEFAULT_CONFIG: KitConfig = {
	root: "",
	engine: { piDurable: "1.5.0", maxTurns: 50, retryLimit: 3 },
	roles: {
		planner: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
		implementer: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
		verifier: { provider: "openrouter", modelId: "openai/gpt-5-nano" },
	},
	budgets: { sessionUsd: 10.0, waveUsdWarn: 2.0, maxConsecutiveErrors: 3, maxSleepCycles: 3 },
	gates: { timeoutSec: 120, enforceTargetPaths: true, skepticSecondPass: false },
	delivery: { mode: "none" },
	paths: { prd: "docs/prd.md", specs: "specs/" },
};

export class ConfigError extends Error {}

function orStr(v: unknown, fallback: string, what: string): string {
	if (v === undefined || v === null) return fallback;
	if (typeof v !== "string" || !v.trim()) throw new ConfigError(`[engine] ${what}: must be a non-empty string`);
	return v;
}

function orNum(v: unknown, fallback: number, what: string, min: number): number {
	if (v === undefined || v === null) return fallback;
	if (typeof v !== "number" || !Number.isFinite(v) || v < min)
		throw new ConfigError(`[engine] ${what}: must be a number ≥ ${min} (got ${JSON.stringify(v)})`);
	return v;
}

function orBool(v: unknown, fallback: boolean, what: string): boolean {
	if (v === undefined || v === null) return fallback;
	if (typeof v !== "boolean") throw new ConfigError(`[engine] ${what}: must be true or false`);
	return v;
}

/**
 * Parse and validate the project config at `<root>/.orch/config.toml`.
 * Missing file: throw (every project `init` scaffolds one). Unknown tables are
 * ignored (additive config), unknown fields inside known tables error.
 */
export function loadConfig(root: string, file = join(root, ".orch", "config.toml")): KitConfig {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		throw new ConfigError(
			`no config at ${file} — run "llm-toolkit-001 init ." in the project first (or point at the repo root)`,
		);
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = toml.parse(raw) as unknown as Record<string, unknown>;
	} catch (err) {
		throw new ConfigError(`config.toml is not valid TOML: ${(err as Error).message}`);
	}
	if (parsed["roles"] !== undefined && typeof parsed["roles"] !== "object") throw new ConfigError("roles: must be a [roles] table");
	if (parsed["engine"] !== undefined && typeof parsed["engine"] !== "object") throw new ConfigError("engine: must be an [engine] table");

	const engine = (parsed["engine"] ?? {}) as Record<string, unknown>;
	const roles = ((parsed["roles"] as Record<string, unknown>) ?? {}) as Record<string, Record<string, unknown>>;
	const budgets = (parsed["budgets"] ?? {}) as Record<string, unknown>;
	const gates = (parsed["gates"] ?? {}) as Record<string, unknown>;
	const delivery = (parsed["delivery"] ?? {}) as Record<string, unknown>;
	const paths = (parsed["paths"] ?? {}) as Record<string, unknown>;

	const cfg: KitConfig = {
		root,
		engine: {
			piDurable: orStr(engine["piDurable"], DEFAULT_CONFIG.engine.piDurable, "piDurable"),
			maxTurns: orNum(engine["maxTurns"], DEFAULT_CONFIG.engine.maxTurns, "maxTurns", 1),
			retryLimit: orNum(engine["retryLimit"], DEFAULT_CONFIG.engine.retryLimit, "retryLimit", 0),
		},
		roles: {} as Record<RoleName, RoleConfig>,
		budgets: {
			sessionUsd: orNum(budgets["sessionUsd"], DEFAULT_CONFIG.budgets.sessionUsd, "sessionUsd", 0),
			waveUsdWarn: orNum(budgets["waveUsdWarn"], DEFAULT_CONFIG.budgets.waveUsdWarn, "waveUsdWarn", 0),
			maxConsecutiveErrors: orNum(budgets["maxConsecutiveErrors"], DEFAULT_CONFIG.budgets.maxConsecutiveErrors, "maxConsecutiveErrors", 1),
			maxSleepCycles: orNum(budgets["maxSleepCycles"], DEFAULT_CONFIG.budgets.maxSleepCycles, "maxSleepCycles", 0),
		},
		gates: {
			timeoutSec: orNum(gates["timeoutSec"], DEFAULT_CONFIG.gates.timeoutSec, "timeoutSec", 1),
			enforceTargetPaths: orBool(gates["enforceTargetPaths"], DEFAULT_CONFIG.gates.enforceTargetPaths, "enforceTargetPaths"),
			skepticSecondPass: orBool(gates["skepticSecondPass"], DEFAULT_CONFIG.gates.skepticSecondPass, "skepticSecondPass"),
		},
		delivery: { mode: readDeliveryMode(delivery["mode"]) },
		paths: {
			prd: orStr(paths["prd"], DEFAULT_CONFIG.paths.prd, "prd"),
			specs: orStr(paths["specs"], DEFAULT_CONFIG.paths.specs, "specs"),
		},
	};

	for (const role of ROLES) {
		const r = roles[role];
		if (!r || r["provider"] === undefined || r["modelId"] === undefined)
			throw new ConfigError(
				`roles.${role}: needs provider and modelId — e.g. provider = "openrouter"\n  modelId = "openai/gpt-5-nano" (cheaper models are welcome for verifier)`,
			);
		if (typeof r["provider"] !== "string" || typeof r["modelId"] !== "string")
			throw new ConfigError(`roles.${role}: provider and modelId must be strings`);
		const thinking = r["thinkingLevel"];
		if (thinking !== undefined && thinking !== null && !["off", "low", "medium", "high"].includes(String(thinking)))
			throw new ConfigError(`roles.${role}.thinkingLevel: one of off | low | medium | high`);
		cfg.roles[role] = {
			provider: r["provider"],
			modelId: r["modelId"],
			thinkingLevel: thinking === null || thinking === undefined ? undefined : (String(thinking) as RoleConfig["thinkingLevel"]),
			costPerMillionInput: num(r["costPerMillionInput"]),
			costPerMillionOutput: num(r["costPerMillionOutput"]),
		};
	}
	return cfg;
}

function readDeliveryMode(v: unknown): DeliveryConfig["mode"] {
	if (v === undefined || v === null) return DEFAULT_CONFIG.delivery.mode;
	if (v === "none" || v === "commit" || v === "pr") return v;
	throw new ConfigError(`delivery.mode = ${JSON.stringify(v)}: one of "none" | "commit" | "pr" (default "none")`);
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

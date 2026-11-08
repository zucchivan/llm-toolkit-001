/**
 * Project harness: the ONLY module (besides infos.ts) allowed to import
 * `@earendil-works/pi-durable` and `@earendil-works/pi-ai`
 * (API encapsulation, brief §3.10).
 *
 * Responsibilities (brief §3.1): open SQLite storage under `.orch/lock`
 * (single-store-owner rule), wire role→provider models, install the registry
 * with harness-enforced boundaries (§3.6), expose durable settings, atomic
 * `.orch/status.json` flushing, and the PD version assertion with a fail-fast
 * "see docs/api-map.md before upgrading" message.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, Harness, NodeExecutionEnv, openNodeSqliteStorage, createReadTool, createWriteTool, createEditTool, createBashTool, createRegistry, defineDoc, defineExtension, hook, ToolTask } from "./kit.ts";
import type { Context, Session, ConversationDocToken, Extension, ToolRegistration, SetTimer } from "./kit.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Models, Provider, Usage } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { LockBusyError, acquireLock } from "../util/lockfile.ts";
import { GovernorSleep } from "./tasks.ts";
import { maybeFauxModels } from "./faux-replay.ts";
import type { LockHandle } from "../util/lockfile.ts";
import { exists as fileExists, atomicWriteJson } from "../util/fsx.ts";
import { loadConfig, KIT_VERSION } from "../config.ts";
import type { KitConfig } from "../config.ts";
import { usageUsd, type CostRates } from "../util/budget.ts";

export { LockBusyError, KIT_VERSION };

// ---- type re-exports so engine modules never import pi-durable -------------
export type { ConversationDocToken, Extension, ToolRegistration, Models, Usage };
export { LiveDoc, UsageDoc } from "./kit.ts";
export { BACKGROUND_CONTEXT };
export type { Context };

// ---------------------------------------------------------------------------
// PD version pinning
// ---------------------------------------------------------------------------

/** Pinned pi-durable version this kit was written against. */
export const PD_VERSION = "1.5.0";

export function readInstalledPiDurableVersion(): string {
	const require = createRequire(import.meta.url);
	const pkg = require("@earendil-works/pi-durable/package.json") as { version: string };
	return pkg.version;
}

/** Fail fast on version mismatch with a pointer at the API map. */
export function assertPinnedPiDurable(claimed?: string): string {
	const installed = readInstalledPiDurableVersion();
	if (installed !== PD_VERSION) {
		throw new Error(
			`installed @earendil-works/pi-durable ${installed} differs from the tested pin ${PD_VERSION} — ` +
				`the API changes without notice between releases; see docs/api-map.md before upgrading`,
		);
	}
	if (claimed && claimed !== PD_VERSION) {
		throw new Error(
			`project config pins piDurable = ${claimed}, but this kit was built and tested against ${PD_VERSION} — ` +
				`see docs/api-map.md before upgrading`,
		);
	}
	return installed;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface ProjectPaths {
	root: string;
	orch: string;
	lock: string;
	status: string;
	pendingHandoff: string;
	waveLog: string;
	database: string;
	artifacts: string;
	config: string;
	routerMd: string;
}

export function projectPaths(root: string): ProjectPaths {
	const orch = join(root, ".orch");
	return {
		root,
		orch,
		lock: join(orch, "lock"),
		status: join(orch, "status.json"),
		pendingHandoff: join(orch, "pending-handoff.json"),
		waveLog: join(orch, "wave-log.jsonl"),
		database: join(orch, "durable.sqlite"),
		artifacts: join(orch, "artifacts"),
		config: join(orch, "config.toml"),
		routerMd: join(root, "router.md"),
	};
}

// ---------------------------------------------------------------------------
// Boundaries: role docs + beforeTool guards (§3.6)
// ---------------------------------------------------------------------------

export type LoopGuardDocValue = {
	version: 1;
	role: "implementer" | "verifier" | "planner";
	/** Non-empty: write/edit outside these paths are blocked (implementer only). */
	targetPaths: string[];
}

export const LoopGuardDoc: ConversationDocToken<LoopGuardDocValue> = defineDoc({
	kind: "loop.guard",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ version: 1, role: "implementer", targetPaths: [] }),
	checkpointWhen: () => true,
});

const PROTECTED_WRITE_MESSAGE =
	"blocked: orchestration files (.orch/**, evals/**, router.md, PROMPT.md) are owned by the engine — write to your task's target paths instead";
const VERIFIER_MESSAGE = "blocked: this conversation is a read-only verifier — only the read tool is available";

const VERIFY_UNWELCOME = new Set(["write", "edit", "bash"]);

export function structuredBoundaryExtension(): Extension<ToolRegistration> {
	return defineExtension({
		name: "kit-boundaries",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					const guard = (await api.snapshot(LoopGuardDoc, api.conversationId, context)) ?? {
						version: 1,
						role: "implementer",
						targetPaths: [],
					};
					if (guard.role === "verifier" && VERIFY_UNWELCOME.has(call.name)) return { block: VERIFIER_MESSAGE };
					if (guard.role === "planner" && VERIFY_UNWELCOME.has(call.name))
						return { block: "the planner only reads (read tool); it must emit the plan JSON instead of editing files" };
					if (guard.role === "implementer" && (call.name === "write" || call.name === "edit")) {
						const args = (call.arguments ?? {}) as { path?: string };
						const rel = String(args.path ?? "");
						if (rel.startsWith(".orch/") || rel.startsWith("evals/") || rel === "router.md" || rel === "PROMPT.md") {
							return { block: PROTECTED_WRITE_MESSAGE };
						}
						if (guard.targetPaths.length > 0 && !matchesTargetPaths(rel, guard.targetPaths)) {
							return {
								block: `blocked: this task's targetPaths are [${guard.targetPaths.join(", ")}] — ${rel || "<empty>"} is outside them`,
							};
						}
					}
					return undefined;
				},
			}),
		],
	});
}

function matchesTargetPaths(rel: string, patterns: readonly string[]): boolean {
	return patterns.some((p) => {
		const trimmed = p.trim();
		if (!trimmed) return false;
		if (trimmed.endsWith("/") || trimmed.endsWith("/**")) {
			const base = trimmed.replace(/\/(\*\*)?$/, "");
			return rel === base || rel.startsWith(`${base}/`);
		}
		if (trimmed.includes("*")) {
			const rx = new RegExp(
				`^${trimmed.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*")
					.replaceAll("\u0001", ".*")}$`,
			);
			return rx.test(rel);
		}
		return rel === trimmed || rel.startsWith(`${trimmed}/`);
	});
}

// ---------------------------------------------------------------------------
// Model wiring
// ---------------------------------------------------------------------------

const builtinProviderFactories: Record<string, () => Provider> = {
	anthropic: anthropicProvider as unknown as () => Provider,
	openai: openaiProvider as unknown as () => Provider,
	openrouter: openrouterProvider as unknown as () => Provider,
};

/**
 * Build the session `Models` from the providers the config roles name.
 * Credentials resolve from env at request time (§ anti-goal: no secrets in config).
 * Tests register the faux provider via `models.setProvider(faux.provider)` themselves.
 */
export function buildModels(needed: Iterable<string>, flags: { fauxOverlay?: boolean; lenient?: boolean } = {}): Models {
	const models = createModels();
	for (const id of needed) {
		if (id === "faux" && flags.fauxOverlay) continue; // overlay wired via maybeFauxModels()
		if (id === "faux" && flags.lenient) continue; // read-only views never send requests; display-only projects may say "faux"
		const factory = builtinProviderFactories[id];
		if (!factory) {
			if (flags.lenient) continue; // visibility commands wire only what they will never call
			throw new Error(
				`roles.*.provider = "${id}" is not wired in this kit (supports: ${Object.keys(builtinProviderFactories).join(", ")}) — ` +
					`see docs/api-map.md; config.toml holds no secrets, credentials come from env as pi-ai expects`,
			);
		}
		models.setProvider(factory());
	}
	return models;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface ReportRow {
	kind: string;
	reason?: string;
	detail?: string;
	ts: number;
}

const MAX_REPORTS = 100;

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export interface LoopHarness {
	config: KitConfig;
	paths: ProjectPaths;
	harness: Harness;
	models: Models;
	/** Handle kit tools; ConversationKit selects these per role. */
	toolBox: { read: ToolRegistration; write: ToolRegistration; edit: ToolRegistration; bash: ToolRegistration };
	/** ring buffer of harness reports (task_faulted, task_interrupted, …) since open */
	reports: ReportRow[];
	/** Session-wide spend in USD via pi-ai usage (roles' config rates as fallback). */
	sessionUsage(): Promise<{ totalUsd: number; tokens: number; byModel: Record<string, Usage> }>;
	close(): Promise<void>;
}

export interface LoopAndLock {
	lock: LockHandle;
	loop: LoopHarness;
}

/**
 * Acquire `.orch/lock`, then open the project harness over
 * `.orch/durable.sqlite`. Throws `LockBusyError` when another process owns the
 * storage (polite refusal; caller prints it and exits 1).
 */
export async function openProjectHarness(
	root: string,
	cmdHint: string,
	opts: { modelsOverride?: Models; now?: () => number; setTimer?: SetTimer; retryMax?: number; readView?: boolean } = {},
): Promise<LoopAndLock> {
	const paths = projectPaths(root);
	requireConfig(paths.config);
	const lock = await acquireLock(paths.lock, cmdHint);

	try {
		const config = loadConfig(root, paths.config);
		assertPinnedPiDurable(config.engine.piDurable);

		const faux = maybeFauxModels();
		const models =
			opts.modelsOverride ??
			faux?.models ??
			buildModels(Object.values(config.roles).map((r) => r.provider), { fauxOverlay: faux !== undefined, lenient: opts.readView === true });

		const tools: ToolRegistration[] = [createReadTool(), createWriteTool(), createEditTool(), createBashTool()];
		const registry = createRegistry();
		registry.install(defineExtension({ name: "kit-tools", tools }));
		registry.install(structuredBoundaryExtension());
		registry.install(defineExtension({ name: "kit-governor", tasks: [GovernorSleep] }));

		const reports: ReportRow[] = [];
		const push = (row: ReportRow) => {
			reports.push(row);
			if (reports.length > MAX_REPORTS) reports.shift();
		};

		const storage = await openNodeSqliteStorage(paths.database);
		const harness = await Harness.open(storage, {
			models,
			registry,
			...(opts.now || opts.setTimer ? { now: opts.now, setTimer: opts.setTimer } : {}),
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? root }),
			settings: {
				retry: { enabled: true, maxRetries: opts.retryMax ?? 3, baseDelayMs: 2_000 },
				afterFailedRun: "withdraw",
				toolExecution: "parallel",
				progress: { partialIntervalMs: 200, outputIntervalMs: 200, persistWithinMs: 2_000 },
			},
			onReport: (report) => {
				push({
					ts: Date.now(),
					kind: report.kind,
					reason: "reason" in report ? String(report.reason) : undefined,
					detail: report.error instanceof Error ? report.error.message : String(report.error ?? ""),
				});
			},
		}, BACKGROUND_CONTEXT);

		return {
			lock,
			loop: {
				config,
				paths,
				harness,
				models,
				toolBox: { read: tools[0]!, write: tools[1]!, edit: tools[2]!, bash: tools[3]! },
				reports,
				sessionUsage: () => computeSessionUsage(harness, config),
				close: async () => {
					await harness.close(BACKGROUND_CONTEXT);
				},
			},
		};
	} catch (err) {
		lock.release();
		throw err;
	}
}

/** Session totals in USD (provider/catalog cost first, config rates as fallback). */
export async function computeSessionUsage(harness: Harness, config: KitConfig): Promise<{ totalUsd: number; tokens: number; byModel: Record<string, Usage> }> {
	const usage = await harness.usage(BACKGROUND_CONTEXT);
	let totalUsd = 0;
	let tokens = 0;
	const byModel: Record<string, Usage> = {};
	for (const [key, record] of Object.entries(usage.models)) {
		const u = unwrapUsage(record);
		byModel[key] = u;
		tokens += u.input + u.output + u.cacheRead + u.cacheWrite;
		const rates: CostRates | undefined = roleRatesFor(config, key);
		totalUsd += usageUsd(u, rates);
	}
	return { totalUsd, tokens, byModel };
}

/** pi.usage stores usage as JSON-ish records; safe narrow to the Usage shape. */
function unwrapUsage(record: unknown): Usage {
	const u = record as Usage;
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } as const;
	return {
		input: Number(u?.input ?? 0),
		output: Number(u?.output ?? 0),
		cacheRead: Number(u?.cacheRead ?? 0),
		cacheWrite: Number(u?.cacheWrite ?? 0),
		totalTokens: Number(u?.totalTokens ?? 0),
		cost: {
			input: Number(u?.cost?.input ?? 0),
			output: Number(u?.cost?.output ?? 0),
			cacheRead: Number(u?.cost?.cacheRead ?? 0),
			cacheWrite: Number(u?.cost?.cacheWrite ?? 0),
			total: Number(u?.cost?.total ?? 0),
		},
	};
}

/** USD estimator over a Usage record using role rates; catalog total kept as-is. */
export function estimateUsageUsd(record: unknown, rates: CostRates | undefined): number {
	return usageUsd(unwrapUsage(record), rates);
}

/** Config rates (USD per 1M tokens) for one `provider/modelId` usage key; absent when nothing matches. */
export function roleRatesFor(config: KitConfig, modelKey: string): CostRates | undefined {
	for (const role of Object.values(config.roles)) {
		if (`${role.provider}/${role.modelId}` === modelKey) {
			return { costPerMillionInput: role.costPerMillionInput, costPerMillionOutput: role.costPerMillionOutput };
		}
	}
	return undefined;
}

function requireConfig(configPath: string): void {
	if (!fileExists(configPath)) {
		throw new Error(`no ${configPath} in this project — run "llm-toolkit-001 init ." at the repo root first`);
	}
}

// ---------------------------------------------------------------------------
// Live status side-car (read by status --view from another process; §3.8)
// ---------------------------------------------------------------------------

export interface StatusPayloads {
	kit: string;
	piDurable: string;
	ts: number;
	root: string;
	lockedByPid?: number;
	phase: "planning" | "wave-running" | "idle" | "closed";
	/** UI seam A.1: `startedAt` rides the wave-running task so an attached UI can
	 *  render a truthful elapsed timer without storage. */
	task?: { id: string; wave: number; status: string; startedAt?: number };
	budget: { spentUsd: number; sessionCeilingUsd: number; waveWarnUsd: number };
	tasks: { id: string; status: string; waveCount: number; title: string;
		/** UI seam A.2 (additive): the task's baseline tree, so an attached UI can compute a live diff without storage. */
		baselineTreeSha?: string }[];
	reports?: ReportRow[];
	alert?: string;
	message?: string;
	/** Session usage estimate at flush time, USD. */
	usageNote?: number;
	// --- UI seam A.1 (additive): governor state mirrored so an attached UI can
	// render it without opening storage while a run owns the lock. ---
	/** Armed durable sleep deadline (epoch ms) when a rate limit is being waited out. */
	sleepUntil?: number;
	consecutiveErrors?: number;
	sleepCycleCount?: number;
	prdPath?: string;
}

export async function flushStated(paths: ProjectPaths, payload: StatusPayloads): Promise<void> {
	await atomicWriteJson(paths.status, payload);
}

export type { Session };

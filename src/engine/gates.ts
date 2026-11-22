/**
 * Gates (§4.3): deterministic recipes from evals/recipes.toml (zero-exit-on-
 * pass commands with optional stdout `match` regexes and `on` path patterns
 * for fast-skip) plus the scope check that runs FIRST on git status: the wave
 * may touch only its targetPaths and never the protected orchestration files.
 * Gate failures never mark tasks done; they produce compact feedback text.
 *
 * M0-P07: each recipe has EXACTLY ONE command form — legacy `cmd` (trimmed
 * and split on whitespace only; shell characters refused with a pointer at
 * argv) or literal `argv` tokens (spaces, empty values and metacharacters are
 * data). ALL `match` patterns must match captured stdout; parsing, matching
 * and every execution go through the ONE runner in `recipe-runner.ts`, which
 * the probe in `adoption/probe.ts` shares (same parser, same deadline rules).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as toml from "smol-toml";
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { changedFilesVsTree, isScopeViolation } from "../util/git.ts";
import { preflightRecipes, runRecipe, recipeArgv } from "./recipe-runner.ts";
import type { ExecArgvCapability, RecipeRunOutcome } from "./recipe-runner.ts";
import type { LoopAndLock, ProjectPaths } from "./harness.ts";
import type { ExecutionContext, ImmutableRecipeBundle, TaskExecutionContext } from "./workspace.ts";
import { diffTaskTrees } from "./workspace.ts";
import { readBlob, readTreeEntries, resolveTree } from "../util/git-objects.ts";

/** §3 Recipe: exactly one command form per recipe. */
export type Recipe =
	& { name: string; cwd?: string; on?: string[]; match?: string[] }
	& ({ argv: [string, ...string[]]; cmd?: never } | { cmd: string; argv?: never });

export interface GateFile {
	recipes: Recipe[];
}

export function loadRecipes(paths: ProjectPaths): GateFile {
	// Generated recipes are defaults. Reading human recipes second makes a
	// same-named human entry the effective one without editing either file.
	const byName = new Map<string, Recipe>();
	for (const file of ["recipes.auto.toml", "recipes.toml"]) {
		for (const recipe of loadRecipeFile(paths.root, file)) byName.set(recipe.name, recipe);
	}
	return { recipes: [...byName.values()] };
}

export function loadRecipeFile(root: string, file: string): Recipe[] {
	try {
		return parseRecipeText(readFileSync(join(root, "evals", file), "utf8"), file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // empty gates = scope check only
		throw new Error(`evals/${file} is unreadable/invalid: ${(err as Error).message}`);
	}
}

function parseRecipeText(raw: string, file: string): Recipe[] {
	const parsed = toml.parse(raw) as unknown as Record<string, Record<string, unknown>>;
	return Object.entries(parsed).map(([name, block]) => parseRecipeBlock(name, block, `${file}: [${name}]`));
}

/** Read reviewed recipe bytes from an immutable Git tree, preserving absent-vs-empty. */
export async function recipeBundleFromTree(root: string, oid: string): Promise<ImmutableRecipeBundle> {
	const sourceTree = await resolveTree(root, oid);
	const rows = await readTreeEntries(root, sourceTree);
	const wanted = ["evals/recipes.auto.toml", "evals/recipes.toml"] as const;
	const files = [];
	for (const path of wanted) {
		const entry = rows.find((row) => row.path === path);
		if (!entry) {
			files.push(Object.freeze({ path, contents: null }));
			continue;
		}
		if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) throw new Error(`${path} in reviewed tree is not a regular file`);
		const bytes = await readBlob(root, entry.oid);
		const contents = bytes.toString("utf8");
		if (!Buffer.from(contents, "utf8").equals(bytes)) throw new Error(`${path} in reviewed tree is not valid UTF-8`);
		files.push(Object.freeze({ path, contents }));
	}
	const sha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
	return Object.freeze({ sourceTree, sha256, files: Object.freeze(files) });
}

/** Parse only captured reviewed bytes; never consult the operator's evals/ during a task run. */
export function recipesFromBundle(bundle: ImmutableRecipeBundle): Recipe[] {
	const byName = new Map<string, Recipe>();
	for (const file of bundle.files) {
		if (file.contents === null) continue;
		for (const recipe of parseRecipeText(file.contents, file.path.slice("evals/".length))) byName.set(recipe.name, recipe);
	}
	return [...byName.values()];
}

/** Parse one `[name]` block into a validated §3 Recipe (form + limits + arrays). */
function parseRecipeBlock(name: string, block: Record<string, unknown>, context: string): Recipe {
	const cmd = block["cmd"];
	const argv = block["argv"];
	if (cmd !== undefined && argv !== undefined) {
		throw new Error(`${context}: set exactly ONE command form — cmd = "…" (legacy simple) or argv = [...] (literal tokens), never both`);
	}
	if (argv !== undefined && (!Array.isArray(argv) || !argv.every((token) => typeof token === "string"))) {
		throw new Error(`${context}: argv must be an array of strings`);
	}
	if (cmd !== undefined && typeof cmd !== "string") throw new Error(`${context}: cmd must be a string`);
	if (cmd === undefined && argv === undefined) throw new Error(`${context}: needs cmd = "…" (legacy simple) or argv = [...] (literal tokens)`);
	const match = strictStrList(block["match"], `${context}: match`);
	const on = strictStrList(block["on"], `${context}: on`);
	const cwd = block["cwd"];
	if (cwd !== undefined && (typeof cwd !== "string" || !cwd.trim())) throw new Error(`${context}: cwd must be a project-relative path`);
	const base = {
		name,
		match: match.length ? match : undefined,
		on: on.length ? on : undefined,
		cwd: typeof cwd === "string" ? cwd : undefined,
	};
	// Build the typed form, then validate it (limits, NUL, legacy shell-character
	// refusal) at load time. Regex compilation and real-cwd containment are
	// preflighted before any recipe runs (runGates / preflightRecipes).
	const recipe: Recipe = argv !== undefined
		? { ...base, argv: argv as [string, ...string[]] }
		: { ...base, cmd: cmd as string };
	recipeArgv(recipe, context); // form validation; throws on invalid input
	return recipe;
}

function strictStrList(v: unknown, what: string): string[] {
	if (v === undefined) return [];
	if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`${what} must be an array of strings`);
	return v as string[];
}

// --- canonical argv helpers shared by the adoption modules -----------------

/** Canonical DISPLAY text for a recipe command: legacy `cmd` renders as-is;
 * argv recipes render as their literal token array (never re-quoted prose). */
export function recipeCommandText(recipe: Recipe): string {
	return "argv" in recipe && recipe.argv !== undefined ? JSON.stringify(recipe.argv) : recipe.cmd;
}

/** Canonical TOML right-hand side: `cmd = "…"` or `argv = [...]`. Legacy cmd
 * rendering is byte-identical to pre-P07 writers so unchanged generated
 * recipes keep their fingerprints and refreshes create no spurious writes. */
export function recipeTomlCommand(recipe: Recipe): string {
	return "argv" in recipe && recipe.argv !== undefined
		? `argv = ${JSON.stringify(recipe.argv)}`
		: `cmd = ${JSON.stringify(recipe.cmd)}`;
}

/**
 * Canonical equivalence: name, cwd, match/on lists, and the CANONICAL argv
 * tokens must agree — a legacy `cmd = "npm test"` decision equals an
 * `argv = ["npm", "test"]` recipe, so legacy decisions never drift spuriously.
 */
export function recipesEquivalent(a: Recipe, b: Recipe): boolean {
	if (a.name !== b.name || (a.cwd ?? undefined) !== (b.cwd ?? undefined)) return false;
	if (JSON.stringify(a.match ?? []) !== JSON.stringify(b.match ?? [])) return false;
	if (JSON.stringify(a.on ?? []) !== JSON.stringify(b.on ?? [])) return false;
	try {
		return JSON.stringify(recipeArgv(a)) === JSON.stringify(recipeArgv(b));
	} catch {
		return false; // invalid recipes are equivalent to nothing
	}
}

export interface GateOutcome {
	allPassed: boolean;
	scopeOK: boolean;
	scopeBody: string;
	results: GateResult[];
	/** Compact feedback text for the router doc (failing recipe + output tail). */
	feedbackText: string;
	/** SHA256 over the failing output — duplicate-error breaker. */
	failHash?: string;
	logFile: string;
}

export interface GateResult {
	name: string;
	skipped?: string;
	passed: boolean;
	exit?: number | null;
	tail: string;
	matched: boolean;
	durationMs: number;
	/** Compact failure reason (timeout / output_capped / match overrun / …). */
	reason?: string;
}

/**
 * Run the scope check, then the recipes (sequential; no parallel shell storms).
 * `targetPaths` enforcement uses the working tree status vs. the task baseline.
 */
export async function runGates(
	kit: LoopAndLock,
	task: { id: string; targetPaths: string[]; baselineTreeSha: string },
	engineFiles: Record<string, string> = {},
	options: { capability?: ExecArgvCapability; context?: ExecutionContext } = {},
): Promise<GateOutcome> {
	const context = options.context;
	const paths = context?.controlPaths ?? kit.loop.paths;
	if (context && paths.root !== kit.loop.paths.root) throw new Error("execution context control root does not match the open project harness");
	const taskContext = context?.kind === "task-execution" ? context : undefined;
	if (taskContext && taskContext.taskId !== task.id) throw new Error(`gate task ${task.id} does not match execution context task ${taskContext.taskId}`);
	const executionRoot = taskContext?.frozenReadView.viewPath ?? (context?.kind === "trusted-compatibility" ? context.executionRoot : paths.root);
	const capability = taskContext?.execArgv ?? options.capability;
	const now = Date.now();
	const logFile = join(paths.artifacts, `gate-${task.id}-${now}.log`);

	// --- Scope check first (§4.3): git facts, no model inference. Empty
	// targetPaths means no restriction beyond the protected files.
	// Engine-synced files (router.md mirrors the RouterDoc) whose CURRENT bytes
	// equal the engine's render are not scope violations — the implementer
	// cannot hand-edit them without breaking the match.
	const engineSynced = (f: string): boolean => {
		const expected = engineFiles[f];
		return expected !== undefined ? readFileSync(join(paths.root, f), "utf8") === expected : false;
	};
	// Scope list = diff-vs-baseline + newly-created untracked files (changedFilesVsTree),
	// not raw status: files unchanged since the baseline capture (incl. intent-to-add
	// entries) are not the implementer's doing. Engine-managed runtime files drop
	// out entirely: .orch/** churns every run, PROMPT.md is user-edited, and a
	// correctly synced router.md equals the mirror bytes.
	const changed = taskContext
		? (await diffTaskTrees({ root: paths.root, oid: taskContext.parentOid }, taskContext.startOid, taskContext.candidateOid)).map((change) => change.path)
		: await changedFilesVsTree(paths.root, task.baselineTreeSha);
	const statusFiles = changed.filter((f) => taskContext
		? f !== ".orch" && !f.startsWith(".orch/") && f !== "router.md" && f !== "PROMPT.md" && !engineSynced(f)
		: !f.startsWith(".orch") && f !== "PROMPT.md" && !engineSynced(f));
	const protectedTouched = statusFiles.filter(isScopeViolation);
	const outsideTouched =
		task.targetPaths.length === 0
			? []
			: statusFiles.filter((f) => !isScopeViolation(f) && !engineSynced(f) && !targetPathsContain(f, task.targetPaths));
	const scopeOK = protectedTouched.length === 0 && outsideTouched.length === 0;
	const scopeBody = [
		protectedTouched.length ? `protected files modified: ${protectedTouched.join(", ")}` : "",
		outsideTouched.length
			? `files outside this task's targetPaths [${task.targetPaths.join(", ")}]: ${outsideTouched.slice(0, 12).join(", ")}${outsideTouched.length > 12 ? ", …" : ""}`
			: "",
	]
		.filter(Boolean)
		.join("; ");

	const results: GateResult[] = [{ name: "scope", passed: scopeOK, tail: scopeBody, matched: true, durationMs: 0 }];

	// --- ADR 05: fail invalid input BEFORE spawning anything. One invalid
	// recipe (unknown form, bad regex, escaping cwd) must not let ANY recipe
	// command start; each problem is reported as that recipe's failed check.
	let recipes: Recipe[] = [];
	let loadError: string | undefined;
	try {
		recipes = taskContext ? recipesFromBundle(taskContext.recipeBundle) : loadRecipes(paths).recipes;
	} catch (err) {
		loadError = (err as Error).message;
	}
	if (loadError !== undefined) {
		results.push({ name: "recipes", passed: false, tail: loadError, matched: false, durationMs: 0, reason: "[invalid] recipe file refused" });
	} else if (scopeOK) {
		const preflightErrors = preflightRecipes(executionRoot, recipes);
		if (preflightErrors.length) {
			for (const { name, error } of preflightErrors) {
				results.push({ name, passed: false, tail: error, matched: false, durationMs: 0, reason: "[invalid] no command started" });
			}
		} else {
			for (const recipe of recipes) {
				if (recipe.on?.length && !statusFiles.some((f) => recipe.on!.some((p) => matchPattern(f, p)))) {
					results.push({ name: recipe.name, skipped: `on ${recipe.on.join(",")}`, passed: true, tail: "", matched: true, durationMs: 0 });
					continue;
				}
				results.push(gateResult(await runRecipe(executionRoot, recipe, {
					timeoutMs: kit.loop.config.gates.timeoutSec * 1000,
					capability,
				})));
			}
		}
	}
	const failed = results.filter((r) => !r.passed);
	const firstFailureTail = failed[0] ? `${failed[0].name}: ${[failed[0].reason, failed[0].tail].filter(Boolean).join(" — ").slice(0, 1200)}` : "";
	const allPassed = failed.length === 0;
	const failHash = failed.length ? shasum(results.map((r) => `${r.name}:${r.tail}`).join("\n")) : undefined;
	const feedbackText = allPassed ? "" : `GATES FAILED: ${firstFailureTail}\nFix the named failure; stay within the task's targetPaths.`;
	await appendGateLog(logFile, results);
	return { allPassed, scopeOK, scopeBody, results, feedbackText, failHash, logFile };
}

/** Map the shared runner's outcome onto a gate row (tail keeps the output). */
function gateResult(outcome: RecipeRunOutcome): GateResult {
	return {
		name: outcome.name,
		passed: outcome.passed,
		exit: outcome.exit,
		tail: `${outcome.stdout}\n${outcome.stderr}`.trim().slice(-1500),
		matched: outcome.matched,
		durationMs: outcome.durationMs,
		...(outcome.reason ? { reason: `[${outcome.failure ?? "failed"}] ${outcome.reason}` } : {}),
	};
}

/** Fast-skip/path-pattern match: literal file, directory prefix with trailing
 * `/`, or `*`/`**` globs — compiled here, never expanded in a shell. */
function matchPattern(rel: string, pattern: string): boolean {
	if (pattern.endsWith("/")) return rel.startsWith(pattern);
	if (pattern.includes("*")) {
		return onPatternRegex(pattern).test(rel);
	}
	return rel === pattern;
}

function onPatternRegex(pattern: string): RegExp {
	return new RegExp(
		`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replaceAll("\u0001", ".*")}$`,
	);
}

function targetPathsContain(rel: string, targetPaths: readonly string[]): boolean {
	return targetPaths.some((p) => p.endsWith("/") ? rel.startsWith(p) : matchPattern(rel, p));
}

function shasum(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

async function appendGateLog(file: string, results: readonly GateResult[]): Promise<void> {
	try {
		await mkdir(dirname(file), { recursive: true });
		const lines = results.map((r) => `## ${r.name}${r.skipped ? ` (skipped: ${r.skipped})` : ""} — ${r.passed ? "PASS" : "FAIL"} (exit ${r.exit ?? "?"}, ${r.durationMs}ms)${r.reason ? ` ${r.reason}` : ""}\n${r.tail}\n`);
		await appendFile(file, lines.join("\n"), "utf8");
	} catch {
		/* artifacts are best effort; the wave log is the durable row */
	}
}

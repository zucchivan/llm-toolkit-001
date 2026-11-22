/**
 * The ONE bounded, no-shell recipe runner (M0-P07 / ADR 05). Both the wave
 * gates (`runGates`) and the separately consented baseline probe
 * (`gates probe`) execute recipes exclusively through this module, using an
 * injected `execArgv` capability — today the host spawn in `util/exec.ts`;
 * in M1 a sandbox lease with the same shape. There is deliberately no shell
 * and no second parser: invalid input fails before spawning, matching shares
 * the recipe deadline, and abort/timeout never pass.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { exec } from "../util/exec.ts";
import type { ExecOutcome } from "../util/exec.ts";
import { compilePatterns, matchStdout } from "./recipe-match.ts";
import type { Recipe } from "./gates.ts";

/** Recipe argv budget (§3): 1–128 literal string tokens, ≤32 KiB total. */
export const MAX_ARGV_TOKENS = 128;
export const MAX_ARGV_BYTES = 32 * 1024;

/**
 * The injected execArgv capability: the only way a recipe command starts.
 * Implemented by the host spawn today and by sandbox leases (M1) later.
 */
export type ExecArgvCapability = (
	argv: readonly [string, ...string[]],
	cwd: string,
	timeoutMs: number,
	signal: AbortSignal,
) => Promise<ExecOutcome>;

/** Host capability for M0: literal argv, no shell, bounded capture, group kill. */
export const hostExecArgv: ExecArgvCapability = (argv, cwd, timeoutMs, signal) =>
	exec([...argv], { cwd, timeoutMs, signal });

/** Characters that only make sense through a shell; legacy `cmd` refuses them. */
const SHELL_METACHARACTERS = /["'`\\$|<>;&(){}[\]*?~]/;

/** True when a command string can be a legacy cmd-form recipe (no shell-only
 * characters). Generators use it to avoid recommending recipes that could
 * never load; humans write non-simple recipes in argv form instead. */
export function isSimpleCommand(cmd: string): boolean {
	return typeof cmd === "string" && cmd.trim() !== "" && !SHELL_METACHARACTERS.test(cmd);
}

function contextOf(recipe: Recipe): string {
	return `recipe ${JSON.stringify(recipe.name)}`;
}

/** Validate literal argv tokens (M0-P07): 1–128 strings, nonempty executable, no NUL, ≤32 KiB. */
export function validateArgv(argv: readonly unknown[], context: string): void {
	if (argv.length < 1) throw new Error(`${context}: argv needs at least the executable token`);
	if (argv.length > MAX_ARGV_TOKENS) throw new Error(`${context}: argv allows at most ${MAX_ARGV_TOKENS} tokens (got ${argv.length})`);
	let bytes = 0;
	for (const token of argv) {
		if (typeof token !== "string") throw new Error(`${context}: argv tokens must be strings`);
		if (token.includes("\0")) throw new Error(`${context}: argv tokens must not contain NUL`);
		bytes += Buffer.byteLength(token, "utf8");
	}
	if (!argv[0]) throw new Error(`${context}: argv executable must be a non-empty string`);
	if (bytes > MAX_ARGV_BYTES) throw new Error(`${context}: argv exceeds the ${MAX_ARGV_BYTES}-byte budget (${bytes} bytes); move long inputs into files`);
}

/**
 * Legacy `cmd` form: trimmed and split on whitespace ONLY. Quoting,
 * redirections, pipes, expansions and other shell operators are rejected with
 * an instruction to use argv — recipes are executed without a shell, so such
 * a command would run with the wrong meaning.
 */
export function cmdArgv(cmd: string, context: string): [string, ...string[]] {
	if (typeof cmd !== "string" || !cmd.trim()) throw new Error(`${context}: cmd must be a non-empty string`);
	const offending = [...new Set(cmd.match(new RegExp(SHELL_METACHARACTERS.source, "g")) ?? [])];
	if (offending.length) {
		throw new Error(
			`${context}: cmd contains shell characters ${offending.map((c) => JSON.stringify(c)).join(" ")} — recipes run without a shell; `
			+ `put the literal tokens in argv = [...] instead (spaces, empty values and metacharacters are passed through verbatim)`,
		);
	}
	const tokens = cmd.trim().split(/\s+/);
	validateArgv(tokens, context);
	return tokens as [string, ...string[]];
}

/** Normalize either accepted form to literal argv tokens; throws on invalid input. */
export function recipeArgv(recipe: Recipe, context = contextOf(recipe)): [string, ...string[]] {
	if ("argv" in recipe && recipe.argv !== undefined) {
		validateArgv(recipe.argv, context);
		return [...recipe.argv] as [string, ...string[]];
	}
	return cmdArgv(recipe.cmd, context);
}

/**
 * Resolve a recipe cwd and refuse anything that is not contained in the REAL
 * project root: absolute paths, `..` escapes and — unlike a purely lexical
 * check — symlinks inside the project pointing outside it. Missing
 * directories fail here, before any spawn.
 */
export function safeRecipeCwdReal(root: string, cwd: string | undefined): string {
	const cwdName = cwd ?? ".";
	const absolute = resolve(root, cwdName);
	if (cwd !== undefined && isAbsolute(cwd)) throw new Error(`recipe cwd must be project-relative: ${cwd}`);
	const rel = relative(root, absolute);
	if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`recipe cwd must stay inside the project: ${cwdName}`);
	const realRoot = realpathSync(root);
	let realCwd: string;
	try {
		realCwd = realpathSync(absolute);
	} catch (err) {
		throw new Error(`recipe cwd is not a usable directory (${cwdName}): ${(err as Error).message}`);
	}
	if (realCwd !== realRoot && !realCwd.startsWith(realRoot + sep)) {
		throw new Error(`recipe cwd escapes the project through a symlink: ${cwdName}`);
	}
	return absolute;
}

export type RecipeFailure = "timeout" | "aborted" | "output-capped" | "match-overrun";

export interface RecipeRunOutcome {
	name: string;
	/** The literal argv tokens observed (parity surface for wave vs probe). */
	argv: readonly string[];
	/** The absolute working directory used. */
	cwd: string;
	exit: number | null;
	timedOut: boolean;
	stdoutCapped: boolean;
	stderrCapped: boolean;
	/** Bounded captured streams (tail past the 256 KiB cap). */
	stdout: string;
	stderr: string;
	matched: boolean;
	passed: boolean;
	failure?: RecipeFailure;
	/** Compact human reason for a failed check (feedback text). */
	reason?: string;
	durationMs: number;
}

/**
 * Validate every recipe (command form, match regexes, real-cwd containment)
 * BEFORE any recipe executes — one invalid recipe must not let ANY command
 * start (ADR 05: fail invalid input before spawning).
 */
export function preflightRecipes(root: string, recipes: readonly Recipe[]): Array<{ name: string; error: string }> {
	const errors: Array<{ name: string; error: string }> = [];
	for (const recipe of recipes) {
		const context = contextOf(recipe);
		try {
			recipeArgv(recipe, context);
			compilePatterns(recipe.match ?? [], context);
			safeRecipeCwdReal(root, recipe.cwd);
		} catch (err) {
			errors.push({ name: recipe.name, error: (err as Error).message });
		}
	}
	return errors;
}

/**
 * Run one recipe through the injected capability: literal argv, no shell;
 * regexes compiled before the spawn; code 0 + not timed out + not aborted +
 * ALL match patterns proven against the WHOLE captured stdout (a capped
 * stdout with `match` present fails `output_capped` — never prove a
 * whole-stream expression on a tail). Matching runs in a terminable worker
 * under the remaining recipe deadline.
 */
export async function runRecipe(
	root: string,
	recipe: Recipe,
	options: { timeoutMs: number; capability?: ExecArgvCapability; signal?: AbortSignal },
): Promise<RecipeRunOutcome> {
	const context = contextOf(recipe);
	const capability = options.capability ?? hostExecArgv;
	const argv = recipeArgv(recipe, context); // throws before any spawn on invalid input
	const cwd = safeRecipeCwdReal(root, recipe.cwd);
	const patterns = compilePatterns(recipe.match ?? [], context); // compile BEFORE executing
	const signal = options.signal ?? new AbortController().signal;

	const started = Date.now();
	const outcome = await capability(
		[...argv] as [string, ...string[]],
		cwd,
		options.timeoutMs,
		signal,
	);
	const durationMs = Date.now() - started;
	const base = {
		name: recipe.name,
		argv,
		cwd,
		exit: outcome.code,
		timedOut: outcome.timedOut === true,
		stdoutCapped: outcome.stdoutCapped === true,
		stderrCapped: outcome.stderrCapped === true,
		stdout: outcome.stdout,
		stderr: outcome.stderr,
		durationMs,
	};

	// Abort/timeout never pass, whatever the child printed or exited with.
	if (signal.aborted) {
		return { ...base, matched: false, passed: false, failure: "aborted", reason: "aborted before completion; abort never passes" };
	}
	if (base.timedOut) {
		return { ...base, matched: false, passed: false, failure: "timeout", reason: `timed out after ${options.timeoutMs}ms; timeout never passes` };
	}
	if (outcome.code !== 0) {
		return {
			...base,
			matched: false,
			passed: false,
			...(outcome.code === null
				? { reason: "command did not start (spawn error or missing executable)" }
				: { reason: `exit code ${outcome.code}` }),
		};
	}
	if (patterns.length === 0) return { ...base, matched: true, passed: true };
	// ALL patterns must be proven against the WHOLE captured stdout. A tail is
	// not evidence: beyond the capture cap the match fails as output_capped.
	if (base.stdoutCapped) {
		return {
			...base,
			matched: false,
			passed: false,
			failure: "output-capped",
			reason: `stdout exceeded the 256 KiB capture cap; match cannot be proven on a truncated tail (output_capped)`,
		};
	}
	const match = await matchStdout([...patterns.map((re) => re.source)], base.stdout, Math.max(0, options.timeoutMs - durationMs));
	if (match.reason === "match-overrun") {
		return { ...base, matched: false, passed: false, failure: "match-overrun", reason: `match evaluation overran the remaining recipe deadline and was terminated` };
	}
	if (match.reason === "invalid") {
		return { ...base, matched: false, passed: false, reason: match.failedPattern ? `match evaluation failed: ${match.failedPattern}` : "match evaluation failed" };
	}
	if (!match.matched) {
		return { ...base, matched: false, passed: false, reason: match.failedPattern ? `required stdout pattern did not match: ${JSON.stringify(match.failedPattern)}` : "required stdout pattern did not match" };
	}
	return { ...base, matched: true, passed: true };
}

/**
 * Gates (§4.3): deterministic recipes from evals/recipes.toml (zero-exit-on-
 * pass shell commands, optional stdout `match` regexes, `on` path patterns for
 * fast-skip) plus the scope check that runs FIRST on git status: the wave may
 * touch only its targetPaths and never the protected orchestration files.
 * Gate failures never mark tasks done; they produce compact feedback text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as toml from "smol-toml";
import { exec } from "../util/exec.ts";
import type { ExecOutcome } from "../util/exec.ts";
import { workingTreeStatus, isProtectedPath } from "../util/git.ts";
import type { LoopAndLock, ProjectPaths } from "./harness.ts";

export interface Recipe {
	name: string;
	cmd: string;
	match?: string[];
	/** Fast-skip: run only when changed files match any of these prefixes/globs. */
	on?: string[];
}

export interface GateFile {
	recipes: Recipe[];
}

export function loadRecipes(paths: ProjectPaths): GateFile {
	try {
		const raw = readFileSync(join(paths.root, "evals", "recipes.toml"), "utf8");
		const parsed = toml.parse(raw) as unknown as Record<string, Record<string, unknown>>;
		const recipes: Recipe[] = [];
		for (const [name, block] of Object.entries(parsed)) {
			const cmd = block["cmd"];
			if (typeof cmd !== "string") throw new Error(`recipes.toml: [${name}] needs cmd = "…"`);
			const match = strList(block["match"]);
			const on = strList(block["on"]);
			recipes.push({ name, cmd, match: match.length ? match : undefined, on: on.length ? on : undefined });
		}
		return { recipes };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { recipes: [] }; // empty gates = scope check only
		throw new Error(`evals/recipes.toml is unreadable/invalid: ${(err as Error).message}`);
	}
}

function strList(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string");
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
}

/**
 * Run the scope check, then the recipes (sequential; no parallel shell storms).
 * `targetPaths` enforcement uses the working tree status vs. the task baseline.
 */
export async function runGates(
	kit: LoopAndLock,
	task: { id: string; targetPaths: string[] },
): Promise<GateOutcome> {
	const paths = kit.loop.paths;
	const now = Date.now();
	const logFile = join(paths.artifacts, `gate-${task.id}-${now}.log`);

	// --- Scope check first (§4.3): git facts, no model inference. Empty
	// targetPaths means no restriction beyond the protected files.
	const statusFiles = await workingTreeStatus(paths.root);
	const protectedTouched = statusFiles.filter(isProtectedPath);
	const outsideTouched =
		task.targetPaths.length === 0
			? []
			: statusFiles.filter((f) => !isProtectedPath(f) && !targetPathsContain(f, task.targetPaths));
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

	const recipes = loadRecipes(paths).recipes;
	if (scopeOK) {
		for (const recipe of recipes) {
			if (recipe.on?.length && !statusFiles.some((f) => recipe.on!.some((p) => matchPattern(f, p)))) {
				results.push({ name: recipe.name, skipped: `on ${recipe.on.join(",")}`, passed: true, tail: "", matched: true, durationMs: 0 });
				continue;
			}
			results.push(await runRecipe(paths.root, recipe, kit.loop.config.gates.timeoutSec * 1000));
		}
	}
	const failed = results.filter((r) => !r.passed);
	const firstFailureTail = failed[0] ? `${failed[0].name}: ${failed[0].tail.slice(0, 1200)}` : "";
	const allPassed = failed.length === 0;
	const failHash = failed.length ? shasum(results.map((r) => `${r.name}:${r.tail}`).join("\n")) : undefined;
	const feedbackText = allPassed ? "" : `GATES FAILED: ${firstFailureTail}\nFix the named failure; stay within the task's targetPaths.`;
	await appendGateLog(logFile, results);
	return { allPassed, scopeOK, scopeBody, results, feedbackText, failHash, logFile };
}

function matchPattern(rel: string, pattern: string): boolean {
	if (pattern.endsWith("/")) return rel.startsWith(pattern);
	if (pattern.includes("*")) {
		return new RegExp(
			`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replaceAll("\u0001", ".*")}$`,
		).test(rel);
	}
	return rel === pattern;
}

function targetPathsContain(rel: string, targetPaths: readonly string[]): boolean {
	return targetPaths.some((p) => p.endsWith("/") ? rel.startsWith(p) : matchPattern(rel, p));
}

async function runRecipe(root: string, recipe: Recipe, timeoutMs: number): Promise<GateResult> {
	const started = Date.now();
	const argv = recipe.cmd.split(/\s+/); // recipes must stay argv-simple: no pipes, no && (docs)
	const outcome = await exec([argv[0]!, ...argv.slice(1)], { cwd: root, timeoutMs });
	const tail = `${outcome.stdout}\n${outcome.stderr}`.trim();
	const matched = !recipe.match?.length || recipe.match.some((m) => new RegExp(m).test(outcome.stdout));
	const passed = outcome.code === 0 && matched; // spawn/timeout failures fail, never pass
	return {
		name: recipe.name,
		passed,
		exit: outcome.code,
		tail: tail.slice(-1500),
		matched,
		durationMs: Date.now() - started,
	};
}

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

function shasum(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

async function appendGateLog(file: string, results: readonly GateResult[]): Promise<void> {
	try {
		await mkdir(dirname(file), { recursive: true });
		const lines = results.map((r) => `## ${r.name}${r.skipped ? ` (skipped: ${r.skipped})` : ""} — ${r.passed ? "PASS" : "FAIL"} (exit ${r.exit ?? "?"}, ${r.durationMs}ms)\n${r.tail}\n`);
		await appendFile(file, lines.join("\n"), "utf8");
	} catch {
		/* artifacts are best effort; the wave log is the durable row */
	}
}

export type { ExecOutcome };

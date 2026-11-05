/** Git plumbing helpers: baseline tree capture, scope check, rollback, delivery. */
import { exec } from "./exec.ts";
import { createHash } from "node:crypto";

export interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

async function run(argv: string[], cwd: string, timeoutMs = 30_000): Promise<GitResult> {
	const out = await exec(argv, { cwd, timeoutMs });
	return { ok: out.code === 0, stdout: out.stdout.trim(), stderr: out.stderr.trim() };
}

export function hasRepo(cwd: string): Promise<boolean> {
	return run(["git", "rev-parse", "--is-inside-work-tree"], cwd).then((r) => r.ok);
}

export function shasum(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Capture the current working tree state as a durable tree SHA:
 * `git add -N . && git write-tree` (intent-to-add makes untracked-but-written
 * files visible to write-tree without staging their content). Falls back to
 * `git rev-parse HEAD^{tree}` when write-tree is impossible.
 */
export async function captureBaselineTree(cwd: string): Promise<string> {
	const head = await run(["git", "rev-parse", "--verify", "HEAD^{tree}"], cwd);
	const wt = await run(["git", "write-tree"], cwd);
	if (wt.ok) return wt.stdout;
	if (head.ok) return head.stdout;
	throw new Error(`not a usable git repository for baseline capture: ${wt.stderr || head.stderr}`);
}

/** Files that differ (status + content) between a baseline tree and the working tree. */
export async function changedFilesVsTree(cwd: string, baseTree: string): Promise<string[]> {
	const r = await run(["git", "diff", "--name-only", "--diff-filter=ACMRTUXB", baseTree], cwd);
	if (!r.ok) return [];
	return r.stdout ? r.stdout.split("\n") : [];
}

export async function diffStatVsTree(cwd: string, baseTree: string): Promise<string> {
	const r = await run(["git", "diff", "--stat", baseTree], cwd);
	return r.ok ? r.stdout : "";
}

/**
 * Working-tree scope check, driven from `git status --porcelain` entries:
 * paths relative to the repo root.
 */
export interface ScopeVerdict {
	files: string[];
	/** true when `enforceTargetPaths` catches files outside the task's targetPaths. */
	outside: string[];
	/** protected orchestration files touched (engine contract violations). */
	protectedModified: string[];
	all: string[];
}

export async function workingTreeStatus(cwd: string): Promise<string[]> {
	const r = await run(["git", "status", "--porcelain", "--untracked-files=all"], cwd, 60_000);
	if (!r.ok) return [];
	return r.stdout
		.split("\n")
		.filter((l) => l.length >= 4)
		.map((l) => l.slice(3).trim().replace(/^"|"$/g, "")); // drop XY and quotes
}

export function isProtectedPath(rel: string): boolean {
	return (
		rel === ".orch" ||
		rel.startsWith(".orch/") ||
		rel === "evals" ||
		rel.startsWith("evals/") ||
		rel === "router.md" ||
		rel === "PROMPT.md"
	);
}

export function matchesTargetPaths(rel: string, targetPaths: readonly string[]): boolean {
	return targetPaths.some((pattern) => {
		const trimmed = pattern.trim();
		if (!trimmed) return false;
		if (trimmed.endsWith("/")) return rel.startsWith(trimmed) || rel === trimmed.slice(0, -1);
		if (trimmed.includes("*")) {
			const rx = new RegExp(
				`^${trimmed.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§§").replace(/\*/g, "[^/]*").replace(/§§/g, ".*")}$`,
			);
			return rx.test(rel);
		}
		return rel === trimmed || rel.startsWith(`${trimmed}/`);
	});
}

/**
 * Restore the working tree to a captured baseline (quarantine rollback)
 * without moving HEAD: index+worktree reset to the baseline tree, then untracked
 * leftover files (created by the failed wave) are cleaned.
 */
export async function restoreTree(cwd: string, baseTree: string): Promise<void> {
	const reset = await run(["git", "reset", "--hard", baseTree], cwd, 60_000);
	if (!reset.ok) {
		// Fall back to the two-step form for older gnus.
		await run(["git", "read-tree", baseTree], cwd);
		await run(["git", "checkout-index", "-f", "-a"], cwd);
	}
	await run(["git", "clean", "-fd"], cwd);
}

/** Create/overwrite a local branch for task delivery (pr mode). */
export async function recreateBranch(cwd: string, branch: string, fromTree: string): Promise<GitResult> {
	return run(["git", "branch", "-f", branch, fromTree], cwd);
}

/** Persist a patch of the wave's changes (quarantine artifact). */
export async function savePatch(cwd: string, baseTree: string, outFile: string): Promise<boolean> {
	const r = await run(["git", "diff", "--binary", baseTree], cwd, 60_000);
	if (!r.ok || (!r.stdout.trim() && !r.stderr)) return false;
	await import("node:fs/promises").then((fs) => fs.writeFile(outFile, r.stdout, "utf8"));
	return r.stdout.length > 0;
}

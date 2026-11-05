/** Git plumbing helpers: baseline tree capture, change detection, rollback, delivery. */
import { exec } from "./exec.ts";
import { createHash } from "node:crypto";

export interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

async function run(argv: string[], cwd: string, timeoutMs = 30_000, env?: Record<string, string | undefined>): Promise<GitResult> {
	const out = await exec(argv, { cwd, timeoutMs, env });
	return { ok: out.code === 0, stdout: out.stdout.trim(), stderr: out.stderr.trim() };
}

export function hasRepo(cwd: string): Promise<boolean> {
	return run(["git", "rev-parse", "--is-inside-work-tree"], cwd).then((r) => r.ok);
}

export function shasum(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Directory + blob hashing (deterministic change detection, no diff quirks)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([".git", "node_modules", ".orch", "dist"]);
const SKIP_FILES = new Set([".DS_Store"]);

/** Recursively list worktree files with .gitignore-style skips (never touches the index). */
export async function worktreeFiles(cwd: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string, rel: string): Promise<void> => {
		const { readdirSync } = await import("node:fs");
		let entries: string[];
		try {
			entries = readdirSync(`${cwd}/${dir}${rel ? `/${rel}` : ""}`, { withFileTypes: true }).map((e) => e.name);
		} catch {
			return;
		}
		for (const name of entries.sort()) {
			const childRel = rel ? `${rel}/${name}` : name;
			if (name.endsWith("/")) continue;
			const full = `${cwd}/${dir}/${childRel}`;
			// file-or-dir status
			const stat = await import("node:fs").then((fs) => fs.statSync(full, { throwIfNoEntry: false } as never));
			if (!stat) continue;
			if (stat.isDirectory()) {
				if (SKIP_DIRS.has(name)) continue;
				await walk(dir, childRel);
			} else if (stat.isFile()) {
				if (SKIP_FILES.has(name)) continue;
				out.push(childRel);
			}
		}
	};
	await walk(".", "");
	return out;
}

/** Blobs of the given paths as git would see them (attributes-aware hashing). */
export async function hashPaths(cwd: string, paths: readonly string[]): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	if (paths.length === 0) return map;
	const { spawn } = await import("node:child_process");
	const lines = await new Promise<string>((resolve) => {
		const proc = spawn("git", ["hash-object", "--stdin-paths"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		proc.stdout!.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		proc.on("close", () => resolve(stdout));
		proc.on("error", () => resolve(""));
		proc.stdin!.end(`${paths.join("\n")}\n`);
	});
	const hashes = lines.trim().split("\n").filter(Boolean);
	for (let i = 0; i < Math.min(hashes.length, paths.length); i++) {
		map.set(paths[i]!, hashes[i]!.trim());
	}
	return map;
}

/** Tracked+untracked contents of a captured tree (the membership reference). */
export async function treeContents(cwd: string, tree: string): Promise<Map<string, string>> {
	const listing = await exec(["git", "ls-tree", "-r", "-z", tree], { cwd, timeoutMs: 30_000 });
	const map = new Map<string, string>();
	if (listing.code !== 0) return map;
	for (const entry of listing.stdout.split("\0").filter(Boolean)) {
		const meta = entry.split("\t");
		if (meta.length < 2) continue;
		const info = meta[0]!.split(" ");
		const blob = info[2] ?? info[3];
		if (blob) map.set(meta[1]!, blob);
	}
	return map;
}

// ---------------------------------------------------------------------------
// Baseline capture + change + rollback
// ---------------------------------------------------------------------------

/**
 * Capture the current working tree as a durable tree SHA WITHOUT touching the
 * project index: a temporary GIT_INDEX_FILE snapshots all engine-relevant files
 * and `write-tree` reads it back. Real blobs for untracked files make rollback
 * exact, and the project's own index stays untouched (adding intent entries
 * would pollute user-facing status).
 */
export async function captureBaselineTree(cwd: string): Promise<string> {
	const files = await worktreeFiles(cwd);
	if (files.length === 0) {
		const head = await run(["git", "rev-parse", "--verify", "HEAD^{tree}"], cwd);
		if (head.ok) return head.stdout;
		throw new Error("not a usable git repository for baseline capture");
	}
	const tmpIndex = `${cwd}/.orch/.baseline-${process.pid}-${process.env["VITEST_WORKER_ID"] ?? "0"}`;
	const env = { GIT_INDEX_FILE: tmpIndex };
	const add = await exec(["git", "add", "--", ...files], { cwd, timeoutMs: 120_000, env });
	if (add.code !== 0) {
		throw new Error(`baseline snapshot failed at git add: ${(add.stderr || "").slice(0, 200)}`);
	}
	const wt = await exec(["git", "write-tree"], { cwd, timeoutMs: 30_000, env });
	if (wt.code !== 0) throw new Error(`baseline snapshot failed: ${wt.stderr}`);
	return wt.stdout.trim();
}

export interface TreeChange {
	/** Files whose content differs from the baseline tree. */
	modified: string[];
	/** Files present now that were not in the baseline snapshot. */
	created: string[];
	/** Files in the baseline snapshot that are gone. */
	deleted: string[];
}

/** Deterministic comparison of the working tree against a captured baseline tree. */
export async function treeChanges(cwd: string, baseTree: string): Promise<TreeChange> {
	const [baseline, nowPaths] = await Promise.all([treeContents(cwd, baseTree), worktreeFiles(cwd)]);
	const hashes = await hashPaths(cwd, nowPaths);
	const changed: TreeChange = { modified: [], created: [], deleted: [] };
	for (const [path, box] of hashes) {
		const atBaseline = baseline.get(path);
		if (atBaseline === undefined) changed.created.push(path);
		else if (atBaseline !== box) changed.modified.push(path);
	}
	for (const path of baseline.keys()) {
		if (!hashes.has(path)) changed.deleted.push(path);
	}
	return changed;
}

/** Files the wave can be held responsible for (created+modified+deleted). */
export async function changedFilesVsTree(cwd: string, baseTree: string): Promise<string[]> {
	const change = await treeChanges(cwd, baseTree);
	return [...change.created, ...change.modified, ...change.deleted];
}

/** Human-readable wave summary for the verifier prompt: path with +/- lines or (new). */
export async function summarizeChanges(cwd: string, baseTree: string): Promise<string> {
	const change = await treeChanges(cwd, baseTree);
	const lines: string[] = [];
	for (const path of change.created.sort()) lines.push(`${path}  (new)`);
	for (const path of change.modified.sort()) {
		const stat = await run(["git", "diff", "--numstat", baseTree, "--", path], cwd, 30_000);
		lines.push(stat.ok && stat.stdout ? stat.stdout.replace(/\t.*/, `  ${path}`) : `${path}  (modified)`);
	}
	for (const path of change.deleted.sort()) lines.push(`${path}  (deleted)`);
	return lines.join("\n");
}

export async function diffStatVsTree(cwd: string, baseTree: string): Promise<string> {
	return summarizeChanges(cwd, baseTree);
}

/** Raw porcelain entries: "XY <path>" lines, quoted renames unquoted; empty when not a repo. */
export async function workingTreeStatus(cwd: string): Promise<string[]> {
	const r = await run(["git", "status", "--porcelain", "--untracked-files=all"], cwd, 60_000);
	if (!r.ok) return [];
	return r.stdout
		.split("\n")
		.filter((l) => l.length >= 4)
		.map((l) => `${l.slice(0, 3)}${unquote(l.slice(3).trim())}`);
}

function unquote(path: string): string {
	return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}

/** Status paths only (XY dropped). */
export async function workingTreeFiles(cwd: string): Promise<string[]> {
	return (await workingTreeStatus(cwd)).map((l) => l.slice(3));
}

/**
 * Scope-check violations (gates): files the implementer must never touch.
 * `.orch/**` is ENGINE-kept (durable storage + side-cars change every run), and
 * `router.md` is validated separately against the live mirror byte-for-byte.
 */
export function isScopeViolation(rel: string): boolean {
	return rel === "evals" || rel.startsWith("evals/");
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

/**
 * Restore the working tree to a captured baseline (quarantine rollback) without
 * moving HEAD: index+worktree reset to the tree via read-tree/checkout-index
 * (git reset --hard refuses plain trees), then untracked leftovers created by
 * the wave are cleaned — except engine runtime under .orch.
 */
export async function restoreTree(cwd: string, baseTree: string): Promise<void> {
	const read = await run(["git", "read-tree", baseTree], cwd, 60_000);
	if (!read.ok) throw new Error(`rollback read-tree failed: ${read.stderr}`);
	const checkout = await run(["git", "checkout-index", "-f", "-a"], cwd, 120_000);
	if (!checkout.ok) throw new Error(`rollback checkout-index failed: ${checkout.stderr}`);
	// Deleted-by-the-wave files come back via checkout-index; untracked leftovers
	// (created by the wave) are cleaned. Engine .orch runtime is excluded.
	await run(["git", "clean", "-fd", "-e", ".orch"], cwd);
}

/** Create/overwrite a local branch for task delivery (pr mode). */
export async function recreateBranch(cwd: string, branch: string, fromTree: string): Promise<GitResult> {
	return run(["git", "branch", "-f", branch, fromTree], cwd);
}

/** Persist a patch of the wave's changes (quarantine artifact) via a throwaway index. */
export async function savePatch(cwd: string, baseTree: string, outFile: string): Promise<boolean> {
	const tmpIdx = `${cwd}/.orch/.patch-idx-${process.pid}`;
	// Stage the CURRENT worktree into a throwaway index so untracked files enter
	// the diff, then produce a binary patch against the baseline tree.
	const add = await exec(["git", "add", "-A", "."], { cwd, timeoutMs: 120_000, env: { GIT_INDEX_FILE: tmpIdx } });
	if (add.code !== 0) return false;
	const wt = await exec(["git", "write-tree"], { cwd, timeoutMs: 30_000, env: { GIT_INDEX_FILE: tmpIdx } });
	if (wt.code !== 0) return false;
	const r = await exec(["git", "diff", "--binary", baseTree, wt.stdout.trim()], { cwd, timeoutMs: 60_000 });
	if (r.code !== 0 || !r.stdout.trim()) return false;
	await import("node:fs/promises").then((fs) => fs.writeFile(outFile, r.stdout, "utf8"));
	return true;
}

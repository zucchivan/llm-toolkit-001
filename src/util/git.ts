/** Git plumbing helpers: baseline tree capture, change detection, rollback, delivery. */
import { exec } from "./exec.ts";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

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

// ---------------------------------------------------------------------------
// Display diffs (UI seam Appendix A.2): patch + stats side-car for the UI.
// Same throwaway-index semantics as savePatch (untracked included, binary
// allowed, project index untouched), minus what the engine should not show:
// .orch/** churn, router.md (mirrors the RouterDoc), PROMPT.md (user-edited).
// A truncated result is DISPLAY ONLY — rollback never reads these patches
// (restoreTree re-checks-out the baseline tree directly).
// ---------------------------------------------------------------------------

/** Cap for stored/displayed patches: anything larger is cut and flagged. */
export const DISPLAY_PATCH_CAP_BYTES = 5 * 1024 * 1024;

/** Engine-owned paths hidden from display diffs + stats (same set the
 *  zero-progress breaker discounts: .orch/**, router.md, PROMPT.md). */
export function isEngineOwnedPath(rel: string): boolean {
	return rel === ".orch" || rel.startsWith(".orch/") || rel === "router.md" || rel === "PROMPT.md";
}

/** Pathspecs mirroring isEngineOwnedPath (git exclude magic; the all-in `.`
 *  anchor balances the `:(exclude)` entries). */
const DISPLAY_DIFF_PATHSPECS: string[] = [
	"--", ".", ":(exclude).orch", ":(exclude).orch/**", ":(exclude)router.md", ":(exclude)PROMPT.md",
];

export interface DiffFileStat {
	path: string;
	/** git name-status letter: A (added), M (modified), D (deleted), … */
	status: string;
	insertions: number;
	deletions: number;
	binary: boolean;
}

/** Per-file stats vs a captured baseline tree (the diff side-car's core). */
export interface DiffStats {
	files: DiffFileStat[];
	totalInsertions: number;
	totalDeletions: number;
}

/** The full stats side-car the engine writes next to each display patch. */
export interface DisplayDiffStats extends DiffStats {
	task: string;
	wave: number;
	baselineTreeSha: string;
	generatedAt: number;
	/** Stored patch size in bytes (the cap applies when true). */
	bytes: number;
	truncated: boolean;
}

export interface DisplayPatchOutcome {
	/** false: nothing to show (empty diff / git failure). */
	ok: boolean;
	/** Patch text, cut at DISPLAY_PATCH_CAP_BYTES when truncated. */
	text: string;
	/** Bytes actually carried (stored patch size / response size). */
	bytes: number;
	/** The raw diff exceeded the cap and was cut (never a rollback input). */
	truncated: boolean;
	/** Per-file stats vs the baseline tree (empty when not ok). */
	stats: DiffStats;
	/** Why ok is false (diagnostic hint). */
	reason?: string;
}

function noDisplayDiff(reason: string): DisplayPatchOutcome {
	return { ok: false, text: "", bytes: 0, truncated: false, stats: { files: [], totalInsertions: 0, totalDeletions: 0 }, reason };
}

/**
 * Full-stream capture for display diffs: `exec` tail-caps at 256 KiB for gate
 * tails — patches must keep their `diff --git` headers and can reach the 5 MiB
 * seam cap, so this helper head-caps instead. `overflow` reports bytes beyond
 * the cap so the caller can set `truncated`.
 */
function spawnCapture(argv: string[], cwd: string, timeoutMs: number, maxBytes: number, env?: Record<string, string | undefined>): Promise<{ code: number | null; stdout: string; overflow: boolean; stderr: string }> {
	return new Promise((done) => {
		const proc = spawn(argv[0] ?? "", argv.slice(1), {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: env ? { ...process.env, ...env } : undefined,
		});
		const out: Buffer[] = [];
		let size = 0;
		let stderr = "";
		const kill = setTimeout(() => {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* already exiting */
			}
		}, timeoutMs);
		const decode = (): string => Buffer.concat(out).toString("utf8");
		proc.stdout!.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size <= maxBytes) out.push(chunk);
		});
		proc.stderr!.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-2000);
		});
		proc.on("close", (code) => {
			clearTimeout(kill);
			done({ code, stdout: decode(), overflow: size > maxBytes, stderr });
		});
		proc.on("error", () => {
			clearTimeout(kill);
			done({ code: null, stdout: decode(), overflow: false, stderr });
		});
	});
}

/** numstat + name-status parses against two trees, engine-owned paths excluded. */
async function statsAgainstTrees(cwd: string, baseTree: string, compareTree: string): Promise<DiffStats> {
	const [numstat, nameStatus] = await Promise.all([
		spawnCapture(["git", "diff", "--numstat", "--no-renames", baseTree, compareTree, ...DISPLAY_DIFF_PATHSPECS], cwd, 120_000, 32 * 1024 * 1024),
		spawnCapture(["git", "diff", "--name-status", "--no-renames", baseTree, compareTree, ...DISPLAY_DIFF_PATHSPECS], cwd, 120_000, 32 * 1024 * 1024),
	]);
	const statuses = new Map<string, string>();
	if (nameStatus.code === 0) {
		for (const line of nameStatus.stdout.split("\n")) {
			if (!line.trim()) continue;
			const [code, ...paths] = line.split("\t");
			const path = paths.at(-1);
			if (code && path) statuses.set(path, code);
		}
	}
	const stats: DiffStats = { files: [], totalInsertions: 0, totalDeletions: 0 };
	if (numstat.code !== 0) return stats; // the patch already failed upstream; empty, not stale
	for (const line of numstat.stdout.split("\n")) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const insRaw = parts[0]!;
		const delRaw = parts[1]!;
		const path = parts.slice(2).join("\t");
		const binary = insRaw === "-" || delRaw === "-";
		const insertions = binary ? 0 : Number.parseInt(insRaw, 10) || 0;
		const deletions = binary ? 0 : Number.parseInt(delRaw, 10) || 0;
		stats.files.push({ path, status: statuses.get(path) ?? "?", insertions, deletions, binary });
		stats.totalInsertions += insertions;
		stats.totalDeletions += deletions;
	}
	return stats;
}

/**
 * Free-standing display diff vs a captured baseline tree (the live endpoint's
 * engine): throwaway index so untracked files enter the diff, engine-owned
 * paths excluded, capped at DISPLAY_PATCH_CAP_BYTES. Nothing is persisted: the
 * caller renders (and optionally stores) `text` and decides.
 */
export async function computeDisplayPatch(cwd: string, baseTree: string): Promise<DisplayPatchOutcome> {
	// Unique temp index per call: a live run's own savePatch and any two server
	// requests must not share index state.
	const tmpIdx = `${cwd}/.orch/.patch-idx-${process.pid}-${Math.floor(Math.random() * 1e9).toString(36)}`;
	try {
		await mkdir(dirname(tmpIdx), { recursive: true });
		const add = await exec(["git", "add", "-A", "."], { cwd, timeoutMs: 120_000, env: { GIT_INDEX_FILE: tmpIdx } });
		if (add.code !== 0) return noDisplayDiff(`git add failed: ${(add.stderr || add.stdout).trim().slice(0, 200)}`);
		const wt = await exec(["git", "write-tree"], { cwd, timeoutMs: 30_000, env: { GIT_INDEX_FILE: tmpIdx } });
		if (wt.code !== 0) return noDisplayDiff(`git write-tree failed: ${(wt.stderr || wt.stdout).trim().slice(0, 200)}`);
		const compareTree = wt.stdout.trim();
		const diff = await spawnCapture(["git", "diff", "--binary", "--no-renames", baseTree, compareTree, ...DISPLAY_DIFF_PATHSPECS], cwd, 120_000, DISPLAY_PATCH_CAP_BYTES + 1);
		if (diff.code !== 0) return noDisplayDiff(`git diff failed: ${(diff.stderr || diff.stdout).trim().slice(0, 200)}`);
		if (diff.stdout.trim() === "") return noDisplayDiff("no display diff (nothing changed outside engine-owned paths)");
		// Cap by bytes: slice whole bytes, then drop a UTF-8 rune cut in half.
		const raw = Buffer.from(diff.stdout, "utf8");
		const truncated = diff.overflow || raw.length > DISPLAY_PATCH_CAP_BYTES;
		const capped = truncated ? raw.subarray(0, DISPLAY_PATCH_CAP_BYTES) : raw;
		const text = capped.toString("utf8").replace(/\uFFFD+$/, "");
		const stats = await statsAgainstTrees(cwd, baseTree, compareTree);
		return { ok: true, text, bytes: Buffer.byteLength(text, "utf8"), truncated, stats };
	} finally {
		await rm(tmpIdx, { force: true }).catch(() => {});
		await rm(`${tmpIdx}.lock`, { force: true }).catch(() => {});
	}
}

/**
 * savePatch's display twin: same throwaway-index semantics, but engine-owned
 * paths excluded, the stored text capped at 5 MiB, and stats captured on the
 * spot for the side-car. Callers that persist (engine done/quarantine)
 * assemble the DisplayDiffStats JSON around the returned outcome.
 */
export async function saveDisplayPatch(cwd: string, baseTree: string, outFile: string): Promise<DisplayPatchOutcome> {
	const outcome = await computeDisplayPatch(cwd, baseTree);
	if (!outcome.ok) return outcome;
	await mkdir(dirname(outFile), { recursive: true });
	await import("node:fs/promises").then((fs) => fs.writeFile(outFile, outcome.text, "utf8"));
	return outcome;
}

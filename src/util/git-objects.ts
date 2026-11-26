/**
 * Host-owned, index-isolated Git object plumbing for prepared task workspaces.
 * These helpers address immutable Git objects/trees only; they never inspect or
 * mutate the operator worktree or its index.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { runTrustedTool } from "../sandbox/trusted-exec.ts";
import type { TrustedExecOutcome } from "../util/exec.ts";
import type { TrustedInstallationDescriptor } from "../sandbox/types.ts";

export type GitOid = string;
export type GitTreeEntry = { path: string; mode: string; type: string; oid: GitOid };
export type GitTreeChange = {
	path: string;
	kind: "create" | "modify" | "delete";
	before?: { mode: string; oid: GitOid };
	after?: { mode: string; oid: GitOid };
};
export type GitCommit = { oid: GitOid; tree: GitOid; parents: GitOid[] };

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_TEXT_OUTPUT = 64 * 1024 * 1024;
const MAX_BLOB_BYTES = 32 * 1024 * 1024;

export function assertGitOid(oid: string): GitOid {
	if (!OID_RE.test(oid)) throw new Error(`invalid full Git object ID: ${JSON.stringify(oid)}`);
	return oid;
}

export interface RunGitOptions {
	timeoutMs?: number;
	/** Allowed plumbing overrides only (index path / commit identity). */
	env?: Readonly<Record<string, string>>;
	input?: Buffer | string;
	maxOutputBytes?: number;
	overflow?: "tail" | "head" | "refuse";
	/** Add the absolute resolved gh credential helper (PR publication only). */
	credentialHelper?: boolean;
	gitHubToken?: string;
	signal?: AbortSignal;
	hostInstallation?: TrustedInstallationDescriptor;
}

/**
 * One Git call through the host-owned resolver: fixed literal argv, the
 * selected absolute executable and the callback-free host environment. A
 * refusal (missing/invalid selection) is a failed outcome with zero spawns.
 */
export async function runGit(
	root: string,
	args: readonly string[],
	options: RunGitOptions = {},
): Promise<TrustedExecOutcome> {
	return await runTrustedTool("git", args, {
		targetRoot: root,
		timeoutMs: options.timeoutMs ?? 30_000,
		...(options.env ? { env: options.env } : {}),
		...(options.input !== undefined ? { input: options.input } : {}),
		...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
		...(options.overflow !== undefined ? { overflow: options.overflow } : {}),
		...(options.credentialHelper ? { credentialHelper: true } : {}),
		...(options.gitHubToken !== undefined ? { gitHubToken: options.gitHubToken } : {}),
		...(options.signal ? { signal: options.signal } : {}),
		...(options.hostInstallation ? { installation: options.hostInstallation } : {}),
	});
}

/** `gh` through the same resolver + host-built noninteractive environment. */
export async function runGh(
	root: string,
	args: readonly string[],
	options: { timeoutMs?: number; gitHubToken?: string; hostInstallation?: TrustedInstallationDescriptor } = {},
): Promise<TrustedExecOutcome> {
	return await runTrustedTool("gh", args, {
		targetRoot: root,
		timeoutMs: options.timeoutMs ?? 30_000,
		...(options.gitHubToken !== undefined ? { gitHubToken: options.gitHubToken } : {}),
		...(options.hostInstallation ? { installation: options.hostInstallation } : {}),
	});
}

/** Execute a fixed git argv with bounded byte capture and checked status. */
export async function gitBytes(
	root: string,
	args: readonly string[],
	options: { input?: Buffer | string; env?: Record<string, string | undefined>; maxOutputBytes?: number; timeoutMs?: number } = {},
): Promise<Buffer> {
	const max = options.maxOutputBytes ?? MAX_TEXT_OUTPUT;
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(options.env ?? {})) {
		if (value === undefined) continue;
		env[key] = value;
	}
	const outcome = await runGit(root, args, {
		timeoutMs: options.timeoutMs ?? 120_000,
		...(Object.keys(env).length ? { env } : {}),
		...(options.input !== undefined ? { input: options.input } : {}),
		maxOutputBytes: max,
		overflow: "refuse",
	});
	if (outcome.timedOut) throw new Error(`git ${args[0]} timed out after ${options.timeoutMs ?? 120_000}ms`);
	if (outcome.overflowed) throw new Error(`git ${args[0]} output exceeded ${max} bytes`);
	if (outcome.code !== 0) {
		throw new Error(`git ${args[0]} failed (${outcome.signaledBy ?? outcome.code}): ${(outcome.stderr || outcome.stdout).trim().slice(0, 1000)}`);
	}
	return outcome.stdoutBytes ?? Buffer.from(outcome.stdout, "utf8");
}

export async function gitText(root: string, args: readonly string[], options: { env?: Record<string, string | undefined>; timeoutMs?: number; input?: Buffer | string } = {}): Promise<string> {
	return (await gitBytes(root, args, { ...options, maxOutputBytes: MAX_TEXT_OUTPUT })).toString("utf8").replace(/\n$/, "");
}

/** Resolve a commit/tree-ish to an existing full tree OID. */
export async function resolveTree(root: string, oid: string): Promise<GitOid> {
	assertGitOid(oid);
	const tree = await gitText(root, ["rev-parse", "--verify", `${oid}^{tree}`]);
	return assertGitOid(tree);
}

/** Read the immutable commit headers needed to validate lineage and tree identity. */
export async function readCommit(root: string, oid: string): Promise<GitCommit> {
	assertGitOid(oid);
	const kind = await gitText(root, ["cat-file", "-t", oid], { timeoutMs: 15_000 });
	if (kind !== "commit") throw new Error(`Git object ${oid} has type ${kind}, not commit`);
	const raw = await gitText(root, ["cat-file", "-p", oid], { timeoutMs: 15_000 });
	const header = raw.split("\n\n", 1)[0] ?? "";
	const treeLine = header.split("\n").find((line) => line.startsWith("tree "));
	if (!treeLine) throw new Error(`Git object ${oid} is not a commit with a tree header`);
	const tree = assertGitOid(treeLine.slice(5));
	const parents = header.split("\n").filter((line) => line.startsWith("parent ")).map((line) => assertGitOid(line.slice(7)));
	return { oid, tree, parents };
}

/** Create a reproducible one-parent commit object; caller pins it before journaling intent. */
export async function createCommitObject(root: string, tree: string, parent: string, message: string): Promise<GitOid> {
	const checkedTree = assertGitOid(tree);
	const checkedParent = assertGitOid(parent);
	if (await resolveTree(root, checkedTree) !== checkedTree) throw new Error("candidate tree OID did not resolve exactly");
	await readCommit(root, checkedParent);
	if (message.includes("\0") || message.length > 2000) throw new Error("commit message is invalid or exceeds 2000 characters");
	const oid = await gitText(root, ["commit-tree", checkedTree, "-p", checkedParent, "-m", message], {
		timeoutMs: 30_000,
		env: {
			GIT_AUTHOR_NAME: "llm-toolkit-001",
			GIT_AUTHOR_EMAIL: "loop@localhost",
			GIT_COMMITTER_NAME: "llm-toolkit-001",
			GIT_COMMITTER_EMAIL: "loop@localhost",
			GIT_AUTHOR_DATE: "@0 +0000",
			GIT_COMMITTER_DATE: "@0 +0000",
		},
	});
	return assertGitOid(oid.trim());
}

/** Read one exact ref name; an absent ref is undefined, not an error. */
export async function readRef(root: string, ref: string): Promise<GitOid | undefined> {
	await gitBytes(root, ["check-ref-format", ref]);
	const output = await gitText(root, ["for-each-ref", "--format=%(refname)%00%(objectname)", ref]);
	for (const line of output.split("\n")) {
		const [name, oid] = line.split("\0");
		if (name === ref && oid) return assertGitOid(oid);
	}
	return undefined;
}

/** Compare-and-swap a ref; `expectedOld=null` means it must be absent. */
export async function compareAndSwapRef(root: string, ref: string, newOid: string, expectedOld: string | null): Promise<boolean> {
	const next = assertGitOid(newOid);
	await gitBytes(root, ["check-ref-format", ref]);
	const expected = expectedOld === null ? "0".repeat(next.length) : assertGitOid(expectedOld);
	try {
		await gitBytes(root, ["update-ref", ref, next, expected], { timeoutMs: 15_000 });
		return true;
	} catch {
		return false; // caller MUST read back and distinguish conflict from command failure
	}
}

/** True when any linked worktree currently has this local branch checked out. */
export async function isBranchCheckedOut(root: string, ref: string): Promise<boolean> {
	await gitBytes(root, ["check-ref-format", ref]);
	const listing = await gitText(root, ["worktree", "list", "--porcelain"]);
	return listing.split("\n").some((line) => line === `branch ${ref}`);
}

/** Recursive, NUL-delimited tree listing; path bytes must be valid UTF-8. */
export async function readTreeEntries(root: string, tree: string): Promise<GitTreeEntry[]> {
	const resolved = await resolveTree(root, tree);
	const raw = await gitBytes(root, ["ls-tree", "-r", "-z", resolved], { maxOutputBytes: MAX_TEXT_OUTPUT });
	const entries: GitTreeEntry[] = [];
	for (const record of raw.toString("utf8").split("\0")) {
		if (!record) continue;
		const tab = record.indexOf("\t");
		if (tab < 0) throw new Error("malformed git ls-tree record");
		const [mode, type, oid] = record.slice(0, tab).split(" ");
		const path = record.slice(tab + 1);
		if (!mode || !type || !oid || !path || !assertValidUtf8(path)) throw new Error("invalid Git tree entry");
		entries.push({ path, mode, type, oid: assertGitOid(oid) });
		if (entries.length > 100_000) throw new Error("Git tree exceeds the 100000-entry workspace limit");
	}
	return entries;
}

function assertValidUtf8(text: string): boolean {
	return !text.includes("\uFFFD") && Buffer.from(text, "utf8").toString("utf8") === text;
}

/** Read one regular blob, refusing oversized objects before buffering it. */
export async function readBlob(root: string, oid: string): Promise<Buffer> {
	assertGitOid(oid);
	const sizeText = await gitText(root, ["cat-file", "-s", oid]);
	if (!/^\d+$/.test(sizeText)) throw new Error(`invalid blob size for ${oid}`);
	const size = Number(sizeText);
	if (!Number.isSafeInteger(size) || size > MAX_BLOB_BYTES) throw new Error(`blob ${oid} exceeds the 32 MiB workspace file limit`);
	const bytes = await gitBytes(root, ["cat-file", "blob", oid], { maxOutputBytes: MAX_BLOB_BYTES });
	if (bytes.length !== size) throw new Error(`short Git blob read for ${oid}`);
	return bytes;
}

/** Store exact bytes in the object database (no clean filters or attributes). */
export async function hashBlob(root: string, bytes: Buffer): Promise<GitOid> {
	if (bytes.length > MAX_BLOB_BYTES) throw new Error("workspace file exceeds the 32 MiB limit");
	return assertGitOid((await gitText(root, ["hash-object", "-w", "--no-filters", "--stdin"], { timeoutMs: 120_000, input: bytes })).trim());
}

// ---------------------------------------------------------------------------
// Filter-free worktree staging (no repository clean filters/hooks can run)
// ---------------------------------------------------------------------------

const MAX_STAGED_ENTRIES = 100_000;

interface StagedEntry {
	path: string;
	mode: "100644" | "100755" | "120000" | "160000";
	oid: GitOid;
}

/**
 * Validate one worktree-relative path before it enters a Git index record or a
 * newline-delimited plumbing input. Control characters, empty/`.`/`..`
 * components, absolute paths and `.git` entries are refused, never rewritten.
 */
function assertStageablePath(path: string): string {
	if (typeof path !== "string" || path.length === 0 || path.length > 4096) throw new Error("invalid worktree path for staging");
	if (/[\0\n\r]/.test(path)) throw new Error(`worktree path contains a control character: ${JSON.stringify(path)}`);
	if (path.includes("\uFFFD")) throw new Error(`worktree path is not valid UTF-8: ${JSON.stringify(path)}`);
	if (path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
		throw new Error(`worktree path is not a normalized project-relative path: ${JSON.stringify(path)}`);
	}
	if (path === ".git" || path.startsWith(".git/")) throw new Error(`worktree path names Git metadata: ${JSON.stringify(path)}`);
	return path;
}

async function hashRegularPaths(root: string, paths: readonly string[], write: boolean): Promise<GitOid[]> {
	if (paths.length === 0) return [];
	const bytes = await gitBytes(root, ["hash-object", ...(write ? ["-w"] : []), "--no-filters", "--stdin-paths"], {
		input: `${paths.join("\n")}\n`,
		timeoutMs: 120_000,
		maxOutputBytes: MAX_TEXT_OUTPUT,
	});
	const oids = bytes.toString("utf8").split("\n").filter(Boolean);
	if (oids.length !== paths.length) throw new Error("git hash-object returned a different object count than the staged path list");
	return oids.map((oid) => assertGitOid(oid.trim()));
}

async function hashSymlink(root: string, path: string, write: boolean): Promise<GitOid> {
	const target = await readlink(join(root, path), { encoding: "buffer" });
	const bytes = await gitBytes(root, ["hash-object", ...(write ? ["-w"] : []), "--stdin"], {
		input: target,
		timeoutMs: 30_000,
	});
	return assertGitOid(bytes.toString("utf8").trim());
}

/**
 * Raw worktree entries for staging: regular files are hashed with
 * `--no-filters` and symlinks as link-target blobs, so a repository
 * `.gitattributes` clean filter is never executed. A missing path is a deletion
 * (omitted); a tracked gitlink is preserved by its recorded index object rather
 * than inspecting the submodule.
 */
async function worktreeEntries(
	root: string,
	paths: readonly string[],
	options: { write: boolean; tracked?: ReadonlyMap<string, { mode: string; oid: GitOid }> },
): Promise<StagedEntry[]> {
	const unique = [...new Set(paths.map(assertStageablePath))];
	if (unique.length > MAX_STAGED_ENTRIES) throw new Error(`Git staging exceeds the ${MAX_STAGED_ENTRIES}-entry limit`);
	const entries: StagedEntry[] = [];
	const regular: { path: string; mode: "100644" | "100755" }[] = [];
	for (const path of unique) {
		let info;
		try {
			info = await lstat(join(root, path));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new Error(`cannot inspect worktree path ${JSON.stringify(path)}: ${(error as Error).message}`);
		}
		if (info.isSymbolicLink()) {
			entries.push({ path, mode: "120000", oid: await hashSymlink(root, path, options.write) });
		} else if (info.isFile()) {
			regular.push({ path, mode: (info.mode & 0o100) !== 0 ? "100755" : "100644" });
		} else if (info.isDirectory()) {
			const tracked = options.tracked?.get(path);
			if (tracked?.mode !== "160000") throw new Error(`cannot stage non-regular worktree entry ${JSON.stringify(path)}`);
			entries.push({ path, mode: "160000", oid: assertGitOid(tracked.oid) });
		} else {
			throw new Error(`cannot stage non-regular worktree entry ${JSON.stringify(path)}`);
		}
	}
	const oids = await hashRegularPaths(root, regular.map((entry) => entry.path), options.write);
	regular.forEach((entry, index) => entries.push({ path: entry.path, mode: entry.mode, oid: oids[index]! }));
	return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** OIDs for the given worktree paths (raw bytes; symlinks as link-target blobs). */
export async function hashWorktreePaths(root: string, paths: readonly string[]): Promise<Map<string, GitOid>> {
	const entries = await worktreeEntries(root, paths, { write: false });
	return new Map(entries.map((entry) => [entry.path, entry.oid]));
}

function parseStagedIndex(raw: Buffer): Map<string, { mode: string; oid: GitOid }> {
	const map = new Map<string, { mode: string; oid: GitOid }>();
	for (const record of raw.toString("utf8").split("\0")) {
		if (!record) continue;
		const tab = record.indexOf("\t");
		if (tab < 0) throw new Error("malformed git ls-files --stage record");
		const [mode, oid] = record.slice(0, tab).split(" ");
		const path = record.slice(tab + 1);
		if (!mode || !oid || !path) throw new Error("invalid git ls-files --stage record");
		map.set(path, { mode, oid: assertGitOid(oid) });
	}
	return map;
}

/**
 * Every path `git add -A` would stage (tracked current content + untracked
 * non-ignored files), read through plumbing rather than the add machinery.
 */
async function gitAddAllEntries(root: string): Promise<StagedEntry[]> {
	const tracked = parseStagedIndex(await gitBytes(root, ["ls-files", "--stage", "-z", "--", "."], { maxOutputBytes: MAX_TEXT_OUTPUT }));
	const untracked = (await gitBytes(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", "."], { maxOutputBytes: MAX_TEXT_OUTPUT }))
		.toString("utf8").split("\0").filter(Boolean);
	return await worktreeEntries(root, [...tracked.keys(), ...untracked], { write: true, tracked });
}

export interface WorktreeTreeOptions {
	/** Throwaway index file under private `.orch` state. */
	indexFile: string;
	/** Exact project-relative paths to stage (capture); omit for `git add -A` semantics. */
	paths?: readonly string[];
}

/**
 * Build a tree from the current worktree through a private index, using
 * `hash-object --no-filters` + `update-index --index-info` stubs. No `git add`,
 * no clean filters, no hooks and no argv-sized path list. The caller owns the
 * throwaway index file and removes it afterwards.
 */
export async function writeWorktreeTree(root: string, options: WorktreeTreeOptions): Promise<GitOid> {
	const entries = options.paths !== undefined
		? await worktreeEntries(root, options.paths, { write: true })
		: await gitAddAllEntries(root);
	const env = { GIT_INDEX_FILE: options.indexFile };
	await gitBytes(root, ["read-tree", "--empty"], { env, timeoutMs: 15_000 });
	if (entries.length > 0) {
		const input = Buffer.concat(entries.map((entry) => Buffer.from(`${entry.mode} ${entry.oid}\t${entry.path}\0`, "utf8")));
		await gitBytes(root, ["update-index", "-z", "--index-info"], { env, input, timeoutMs: 120_000 });
	}
	return assertGitOid((await gitText(root, ["write-tree"], { env })).trim());
}

/**
 * Write a tree through an isolated index under private state. Entries are
 * NUL-delimited; caller paths are never expanded as shell/pathspec syntax.
 */
export async function writeTreeFromChanges(
	root: string,
	baseTree: string,
	changes: readonly ({ path: string; mode: "100644" | "100755" | "0"; oid: string })[],
): Promise<GitOid> {
	const tree = await resolveTree(root, baseTree);
	const orch = `${root}/.orch`;
	try { await mkdir(orch, { mode: 0o700 }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	const orchInfo = await lstat(orch);
	if (!orchInfo.isDirectory() || orchInfo.isSymbolicLink()) throw new Error(".orch must be a real directory for private Git index state");
	const work = `${orch}/work`;
	try { await mkdir(work, { mode: 0o700 }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	const workInfo = await lstat(work);
	if (!workInfo.isDirectory() || workInfo.isSymbolicLink() || (workInfo.mode & 0o077) !== 0) throw new Error(".orch/work must be a private real directory");
	const indexFile = `${work}/git-index-${process.pid}-${randomUUID()}`;
	const env = { GIT_INDEX_FILE: indexFile };
	await rm(indexFile, { force: true });
	try {
		await gitBytes(root, ["read-tree", tree], { env });
		if (changes.length) {
			const zero = "0".repeat(tree.length);
			const input = Buffer.concat(changes.map((change) => {
				if (change.mode !== "0") assertGitOid(change.oid);
				const oid = change.mode === "0" ? zero : change.oid;
				return Buffer.from(`${change.mode} ${oid}\t${change.path}\0`, "utf8");
			}));
			await gitBytes(root, ["update-index", "-z", "--index-info"], { env, input });
		}
		return assertGitOid((await gitText(root, ["write-tree"], { env })).trim());
	} finally {
		await rm(indexFile, { force: true });
		await rm(`${indexFile}.lock`, { force: true });
	}
}

/** Exact path/mode/object comparison between immutable trees. */
export async function diffTrees(root: string, before: string, after: string): Promise<GitTreeChange[]> {
	const [leftRows, rightRows] = await Promise.all([readTreeEntries(root, before), readTreeEntries(root, after)]);
	const left = new Map(leftRows.map((entry) => [entry.path, entry]));
	const right = new Map(rightRows.map((entry) => [entry.path, entry]));
	const changes: GitTreeChange[] = [];
	for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
		const a = left.get(path);
		const b = right.get(path);
		if (!a && b) changes.push({ path, kind: "create", after: { mode: b.mode, oid: b.oid } });
		else if (a && !b) changes.push({ path, kind: "delete", before: { mode: a.mode, oid: a.oid } });
		else if (a && b && (a.mode !== b.mode || a.oid !== b.oid)) {
			changes.push({ path, kind: "modify", before: { mode: a.mode, oid: a.oid }, after: { mode: b.mode, oid: b.oid } });
		}
	}
	return changes;
}

/** Pin an object under a validated private ref; `heads` is never touched. */
export async function pinObject(root: string, ref: string, oid: string): Promise<void> {
	assertGitOid(oid);
	if (!ref.startsWith("refs/kit/")) throw new Error("object pins are restricted to refs/kit/ private refs");
	await gitBytes(root, ["check-ref-format", ref]);
	await gitBytes(root, ["update-ref", ref, oid, "0".repeat(oid.length)]);
}

/** Machine-checkable tree diff (`--raw -z`), kept separate from display diffs. */
export async function rawTreeDiff(root: string, before: string, after: string): Promise<Buffer> {
	return await gitBytes(root, ["diff-tree", "--no-commit-id", "--raw", "-r", "-z", before, after], { maxOutputBytes: MAX_TEXT_OUTPUT });
}

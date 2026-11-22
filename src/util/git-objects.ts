/**
 * Host-owned, index-isolated Git object plumbing for prepared task workspaces.
 * These helpers address immutable Git objects/trees only; they never inspect or
 * mutate the operator worktree or its index.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";

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
const GIT_CONFIG_ARGS = [
	"-c", "core.hooksPath=/dev/null",
	"-c", "core.attributesFile=/dev/null",
	"-c", "core.autocrlf=false",
	"-c", "core.safecrlf=false",
	"-c", "core.fsmonitor=false",
	"-c", "diff.external=",
];

export function assertGitOid(oid: string): GitOid {
	if (!OID_RE.test(oid)) throw new Error(`invalid full Git object ID: ${JSON.stringify(oid)}`);
	return oid;
}

function gitEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env["GIT_DIR"];
	delete env["GIT_WORK_TREE"];
	delete env["GIT_INDEX_FILE"];
	delete env["GIT_PREFIX"];
	Object.assign(env, {
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
		...(extra ?? {}),
	});
	return env;
}

/** Execute a fixed git argv with bounded byte capture and checked status. */
export async function gitBytes(
	root: string,
	args: readonly string[],
	options: { input?: Buffer | string; env?: Record<string, string | undefined>; maxOutputBytes?: number; timeoutMs?: number } = {},
): Promise<Buffer> {
	const max = options.maxOutputBytes ?? MAX_TEXT_OUTPUT;
	return await new Promise<Buffer>((resolve, reject) => {
		const proc = spawn("git", [...GIT_CONFIG_ARGS, ...args], {
			cwd: root,
			env: gitEnv(options.env),
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		let stdoutSize = 0;
		let stderr = "";
		let settled = false;
		let overflow = false;
		const timeout = setTimeout(() => terminate("SIGTERM"), options.timeoutMs ?? 120_000);
		let killTimeout: NodeJS.Timeout | undefined;
		const terminate = (signal: NodeJS.Signals): void => {
			if (proc.pid === undefined) return;
			try {
				if (process.platform !== "win32") process.kill(-proc.pid, signal);
				else proc.kill(signal);
			} catch { /* already exited */ }
		};
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (killTimeout) clearTimeout(killTimeout);
			reject(error);
		};
		proc.stdout!.on("data", (chunk: Buffer) => {
			stdoutSize += chunk.length;
			if (stdoutSize > max) {
				overflow = true;
				terminate("SIGTERM");
				killTimeout ??= setTimeout(() => terminate("SIGKILL"), 1000);
			} else stdout.push(chunk);
		});
		proc.stderr!.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-8192);
		});
		proc.on("error", (error) => fail(error));
		proc.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (killTimeout) clearTimeout(killTimeout);
			if (overflow) return reject(new Error(`git ${args[0]} output exceeded ${max} bytes`));
			if (code !== 0) return reject(new Error(`git ${args[0]} failed (${signal ?? code}): ${stderr.trim().slice(0, 1000)}`));
			resolve(Buffer.concat(stdout));
		});
		if (options.input !== undefined) {
			proc.stdin!.on("error", (error) => {
				if ((error as NodeJS.ErrnoException).code !== "EPIPE") fail(error);
			});
			proc.stdin!.end(options.input);
		}
	});
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

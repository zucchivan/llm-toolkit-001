/**
 * Immutable task-tree workspace plumbing (M0-P09, activated for the serial
 * driver in M0-P14). Callers supply committed Git objects and explicitly
 * attest that workspace writers are fenced before freezing; this is not a
 * process-kill implementation or an OS sandbox.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, readdir, chmod, writeFile, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { PlanIdentity } from "./plans.ts";
import type { ProjectPaths } from "./harness.ts";
import type { ExecArgvCapability } from "./recipe-runner.ts";
import { assertAdmissiblePath, createTaskControls, isDeniedPath, isReadOnlyPath, type TaskControls } from "./controls.ts";
import {
	assertGitOid, diffTrees, gitText, hashBlob, pinObject, readBlob, readRef,
	readTreeEntries, resolveTree, writeTreeFromChanges, type GitOid, type GitTreeChange, type GitTreeEntry,
} from "../util/git-objects.ts";

export type GitTreeSource = Readonly<{ root: string; oid: GitOid }>;
type WorkspaceData = { root: string; parentTree: GitOid; scopeBaseTree: GitOid; privateRoot: string; projected: Map<string, { mode: "100644" | "100755"; oid: GitOid }>; excluded: string[]; refBase: string; disposed: boolean; frozen: boolean };
type ReadViewData = { root: string; privateRoot: string; projected: string[]; excluded: string[]; tree: GitOid; disposed: boolean };

/** Opaque, host-created handle; its filesystem path is intentionally not an input to discard. */
export type OwnedLease = Readonly<{ id: string; kind: "task" | "read"; projectedParentPaths: readonly string[]; excludedParentPaths: readonly string[] }>;
export type TaskWorkspaceLease = OwnedLease & Readonly<{
	kind: "task";
	root: string;
	/** Start-of-this-wave tree; progress is measured from here. */
	parentTree: GitOid;
	/** Tree of the integration parent; full candidate scope is measured from here. */
	scopeBaseTree: GitOid;
	workspacePath: string;
	/** Set only when resumeTask observes this lease's pinned frozen candidate. */
	frozenCandidateTree?: GitOid;
}>;
export type ReadWorkspace = OwnedLease & Readonly<{ kind: "read"; root: string; tree: GitOid; viewPath: string }>;
export type FencedWorkspace = Readonly<{ lease: TaskWorkspaceLease; controls: TaskControls }>;
export type FrozenTree = Readonly<{
	parentTree: GitOid;
	scopeBaseTree: GitOid;
	tree: GitOid;
	/** Per-wave progress: start-of-wave tree → candidate. */
	changes: readonly GitTreeChange[];
	projectedParentPaths: readonly string[];
}>;

/** Reviewed recipe bytes are captured once; callers cannot re-read mutable evals/ files mid-run. */
export type ImmutableRecipeBundle = Readonly<{
	/** Immutable tree reviewed for this task; must equal the task's start tree. */
	sourceTree: GitOid;
	sha256: string;
	files: readonly Readonly<{ path: "evals/recipes.toml" | "evals/recipes.auto.toml"; contents: string | null }>[];
}>;

/** Explicit authority/path split for a task execution and its read-only checks. */
export type TaskExecutionContext = Readonly<{
	kind: "task-execution";
	controlPaths: ProjectPaths;
	grant: Readonly<{ planRevision: string; selectedTaskIds: readonly string[] }>;
	taskId: string;
	parentOid: GitOid;
	startOid: GitOid;
	candidateOid: GitOid;
	writableWorkspace: TaskWorkspaceLease;
	frozenReadView: ReadWorkspace;
	recipeBundle: ImmutableRecipeBundle;
	execArgv: ExecArgvCapability;
}>;

/** Candidate-only context used by diagnostic verification; it has no write lease. */
export type TaskReadContext = Readonly<{
	kind: "task-read";
	controlPaths: ProjectPaths;
	taskId: string;
	startOid: GitOid;
	candidateOid: GitOid;
	frozenReadView: ReadWorkspace;
	recipeBundle: ImmutableRecipeBundle;
}>;

export type ExecutionContext = TaskExecutionContext | TaskReadContext;

export async function createTaskExecutionContext(input: Omit<TaskExecutionContext, "kind">): Promise<TaskExecutionContext> {
	const parentOid = assertGitOid(input.parentOid);
	const startOid = assertGitOid(input.startOid);
	const candidateOid = assertGitOid(input.candidateOid);
	if (!input.grant.planRevision || !input.grant.selectedTaskIds.includes(input.taskId)) throw new Error("execution context task must belong to its explicit plan grant");
	if (input.writableWorkspace.kind !== "task" || input.frozenReadView.kind !== "read") throw new Error("execution context requires an owned writable task workspace and frozen read view");
	if (input.writableWorkspace.root !== input.controlPaths.root || input.frozenReadView.root !== input.controlPaths.root) throw new Error("execution roots must share the project control root");
	if (input.writableWorkspace.parentTree !== startOid) throw new Error("writable task workspace must start at the execution context start OID");
	if (input.writableWorkspace.scopeBaseTree !== await resolveTree(input.controlPaths.root, parentOid)) throw new Error("writable task workspace scope base must be the integration parent tree");
	if (input.frozenReadView.tree !== candidateOid) throw new Error("frozen read view must materialize the candidate OID");
	assertGitOid(input.recipeBundle.sourceTree);
	const reviewedTree = await resolveTree(input.controlPaths.root, startOid);
	if (input.recipeBundle.sourceTree !== reviewedTree) throw new Error("recipe bundle must come from the immutable task start tree");
	if (!/^[0-9a-f]{64}$/.test(input.recipeBundle.sha256)) throw new Error("recipe bundle requires a full SHA256 digest");
	const files = input.recipeBundle.files.map((file) => {
		if (file.path !== "evals/recipes.toml" && file.path !== "evals/recipes.auto.toml") throw new Error(`unexpected reviewed recipe path ${JSON.stringify(file.path)}`);
		if (file.contents !== null && typeof file.contents !== "string") throw new Error("reviewed recipe contents must be UTF-8 text or absent");
		return Object.freeze({ ...file });
	});
	if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("recipe bundle contains a duplicate path");
	const bundleDigest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
	if (bundleDigest !== input.recipeBundle.sha256) throw new Error("recipe bundle SHA256 does not match its captured bytes");
	const treeEntries = await readTreeEntries(input.controlPaths.root, reviewedTree);
	for (const file of files) {
		const entry = treeEntries.find((row) => row.path === file.path);
		let treeContents: string | null = null;
		if (entry) {
			if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) throw new Error(`${file.path} in the reviewed tree is not a regular file`);
			const bytes = await readBlob(input.controlPaths.root, entry.oid);
			treeContents = bytes.toString("utf8");
			if (!Buffer.from(treeContents, "utf8").equals(bytes)) throw new Error(`${file.path} in the reviewed tree is not valid UTF-8`);
		}
		if (treeContents !== file.contents) throw new Error(`recipe bundle bytes for ${file.path} do not match the immutable task start tree`);
	}
	return Object.freeze({
		...input, kind: "task-execution", parentOid, startOid, candidateOid,
		grant: Object.freeze({ planRevision: input.grant.planRevision, selectedTaskIds: Object.freeze([...input.grant.selectedTaskIds]) }),
		recipeBundle: Object.freeze({ sourceTree: input.recipeBundle.sourceTree, sha256: input.recipeBundle.sha256, files: Object.freeze(files) }),
	});
}

export async function createTaskReadContext(input: Omit<TaskReadContext, "kind">): Promise<TaskReadContext> {
	const startOid = assertGitOid(input.startOid);
	const candidateOid = assertGitOid(input.candidateOid);
	if (input.frozenReadView.kind !== "read" || input.frozenReadView.root !== input.controlPaths.root) {
		throw new Error("diagnostic verification requires an owned frozen read view in the control project");
	}
	if (input.frozenReadView.tree !== candidateOid) throw new Error("diagnostic read view does not match the retained candidate OID");
	const reviewedTree = await resolveTree(input.controlPaths.root, startOid);
	if (input.recipeBundle.sourceTree !== reviewedTree) throw new Error("diagnostic recipe bundle must come from the wave start tree");
	if (!/^[0-9a-f]{64}$/.test(input.recipeBundle.sha256)) throw new Error("recipe bundle requires a full SHA256 digest");
	const files = input.recipeBundle.files.map((file) => {
		if (file.path !== "evals/recipes.toml" && file.path !== "evals/recipes.auto.toml") throw new Error(`unexpected reviewed recipe path ${JSON.stringify(file.path)}`);
		if (file.contents !== null && typeof file.contents !== "string") throw new Error("reviewed recipe contents must be UTF-8 text or absent");
		return Object.freeze({ ...file });
	});
	if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("recipe bundle contains a duplicate path");
	if (createHash("sha256").update(JSON.stringify(files)).digest("hex") !== input.recipeBundle.sha256) {
		throw new Error("recipe bundle SHA256 does not match its captured bytes");
	}
	const treeEntries = await readTreeEntries(input.controlPaths.root, reviewedTree);
	for (const file of files) {
		const entry = treeEntries.find((row) => row.path === file.path);
		let contents: string | null = null;
		if (entry) {
			if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) throw new Error(`${file.path} in the reviewed tree is not a regular file`);
			const bytes = await readBlob(input.controlPaths.root, entry.oid);
			contents = bytes.toString("utf8");
			if (!Buffer.from(contents, "utf8").equals(bytes)) throw new Error(`${file.path} in the reviewed tree is not valid UTF-8`);
		}
		if (contents !== file.contents) throw new Error(`recipe bundle bytes for ${file.path} do not match the immutable wave start tree`);
	}
	return Object.freeze({
		...input,
		kind: "task-read",
		startOid,
		candidateOid,
		recipeBundle: Object.freeze({ sourceTree: input.recipeBundle.sourceTree, sha256: input.recipeBundle.sha256, files: Object.freeze(files) }),
	});
}

const owned = new WeakMap<object, WorkspaceData | ReadViewData>();
const fenced = new WeakMap<object, { data: WorkspaceData; controls: TaskControls }>();

const MAX_ENTRIES = 100_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function ensurePrivateDir(path: string): Promise<void> {
	try {
		await mkdir(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`private workspace component is not a real directory: ${path}`);
	if ((info.mode & 0o077) !== 0) throw new Error(`private workspace directory has unsafe permissions: ${path}`);
}

async function privateWorkRoot(root: string): Promise<string> {
	const orch = join(root, ".orch");
	try {
		await mkdir(orch, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const orchInfo = await lstat(orch);
	if (!orchInfo.isDirectory() || orchInfo.isSymbolicLink()) throw new Error(".orch must be a real directory before workspace preparation");
	const work = join(orch, "work");
	await ensurePrivateDir(work);
	return work;
}

function workspaceRef(identity: PlanIdentity, id: string, leaseId: string): string {
	if (!UUID_RE.test(identity.planRevision)) throw new Error("task workspace requires a valid planRevision UUIDv4");
	if (!ID_RE.test(id)) throw new Error(`invalid task ID for private workspace: ${JSON.stringify(id)}`);
	return `refs/kit/${identity.planRevision}/tasks/${id}/leases/${leaseId}`;
}

function assertInside(root: string, candidate: string): void {
	const rel = relative(root, candidate);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(candidate) !== candidate) throw new Error("private workspace escaped its owning state directory");
}

async function ensureParents(base: string, relPath: string): Promise<string> {
	const parts = relPath.split("/");
	const file = parts.pop();
	if (!file) throw new Error(`invalid workspace path ${JSON.stringify(relPath)}`);
	let dir = base;
	for (const part of parts) {
		dir = join(dir, part);
		try { await mkdir(dir, { mode: 0o700 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		const info = await lstat(dir);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe directory in projected path ${JSON.stringify(relPath)}`);
	}
	return join(dir, file);
}

function isRegularEntry(entry: GitTreeEntry): entry is GitTreeEntry & { type: "blob"; mode: "100644" | "100755" } {
	return entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
}

async function materializeTree(root: string, tree: GitOid, controls: TaskControls, output: string, readOnly: boolean): Promise<{ projected: Map<string, { mode: "100644" | "100755"; oid: GitOid }>; excluded: string[]; total: number }> {
	const entries = await readTreeEntries(root, tree);
	if (entries.length > MAX_ENTRIES) throw new Error("Git tree exceeds workspace entry limit");
	const projected = new Map<string, { mode: "100644" | "100755"; oid: GitOid }>();
	const excluded: string[] = [];
	const foldedPaths = new Set<string>();
	let total = 0;
	for (const entry of entries) {
		// Validate names before an intentional reserved-path exclusion. Invalid
		// names are errors, not candidates silently dropped by an ignore rule.
		if (entry.path.includes("\0") || entry.path.includes("\\") || entry.path.startsWith("/") || entry.path.split("/").some((p) => p === "" || p === "." || p === "..")) {
			throw new Error(`unsafe path in parent Git tree: ${JSON.stringify(entry.path)}`);
		}
		const folded = entry.path.toLowerCase();
		if (foldedPaths.has(folded)) throw new Error(`case-colliding Git path: ${JSON.stringify(entry.path)}`);
		foldedPaths.add(folded);
		if (isDeniedPath(entry.path, controls)) {
			excluded.push(entry.path);
			continue;
		}
		if (!isRegularEntry(entry)) throw new Error(`unsupported projected Git entry ${JSON.stringify(entry.path)} (${entry.mode} ${entry.type})`);
		const bytes = await readBlob(root, entry.oid);
		total += bytes.length;
		if (total > MAX_TOTAL_BYTES) throw new Error("projected Git tree exceeds the 512 MiB workspace content limit");
		const destination = await ensureParents(output, entry.path);
		const protectedReadOnly = readOnly || isReadOnlyPath(entry.path, controls);
		const fileMode = protectedReadOnly ? entry.mode === "100755" ? 0o500 : 0o400 : entry.mode === "100755" ? 0o700 : 0o600;
		await writeFile(destination, bytes, { flag: "wx", mode: fileMode });
		await chmod(destination, fileMode);
		projected.set(entry.path, { mode: entry.mode, oid: entry.oid });
	}
	return { projected, excluded: excluded.sort(), total };
}

async function makeDirectoriesReadOnly(root: string): Promise<void> {
	const rows = await readdir(root, { withFileTypes: true });
	for (const row of rows) {
		const full = join(root, row.name);
		const info = await lstat(full);
		if (info.isDirectory() && !info.isSymbolicLink()) await makeDirectoriesReadOnly(full);
	}
	await chmod(root, 0o500);
}

async function makeDirectoriesWritable(root: string): Promise<void> {
	await chmod(root, 0o700);
	for (const row of await readdir(root, { withFileTypes: true })) {
		const full = join(root, row.name);
		const info = await lstat(full);
		if (info.isDirectory() && !info.isSymbolicLink()) await makeDirectoriesWritable(full);
	}
}

async function canonicalRoot(root: string): Promise<string> {
	const actual = await realpath(root);
	const inside = await gitText(actual, ["rev-parse", "--is-inside-work-tree"]);
	if (inside !== "true") throw new Error("task-tree operations require an existing Git worktree");
	return actual;
}

/**
 * Create a private writable copy of one immutable parent. `parent` is a
 * committed object/tree reference, never the checked-out index or filesystem.
 */
export async function openTask(
	parent: GitTreeSource,
	identity: PlanIdentity,
	id: string,
	options: { scopeBaseOid?: string } = {},
): Promise<TaskWorkspaceLease> {
	const root = await canonicalRoot(parent.root);
	const parentTree = await resolveTree(root, assertGitOid(parent.oid));
	const scopeBaseTree = await resolveTree(root, assertGitOid(options.scopeBaseOid ?? parent.oid));
	const leaseId = randomUUID();
	const refBase = workspaceRef(identity, id, leaseId);
	await pinObject(root, `${refBase}/parent`, parentTree);
	const state = await privateWorkRoot(root);
	const revisionDir = join(state, identity.planRevision);
	const taskDir = join(revisionDir, id);
	await ensurePrivateDir(revisionDir);
	await ensurePrivateDir(taskDir);
	const privateRoot = join(taskDir, leaseId);
	await ensurePrivateDir(privateRoot);
	assertInside(state, privateRoot);
	const defaultControls = createTaskControls({ root, targetPaths: [] });
	const captured = await materializeTree(root, parentTree, defaultControls, privateRoot, false);
	const data: WorkspaceData = { root, parentTree, scopeBaseTree, privateRoot, projected: captured.projected, excluded: captured.excluded, refBase, disposed: false, frozen: false };
	const lease = Object.freeze({
		id: leaseId,
		kind: "task" as const,
		root,
		parentTree,
		scopeBaseTree,
		workspacePath: privateRoot,
		projectedParentPaths: Object.freeze([...captured.projected.keys()].sort()),
		excludedParentPaths: Object.freeze([...captured.excluded]),
	});
	owned.set(lease, data);
	return lease;
}

/** Reattach a checkpointed lease after reopen without recreating or recapturing its tree. */
export async function resumeTask(
	parent: GitTreeSource,
	identity: PlanIdentity,
	id: string,
	leaseId: string,
	options: { scopeBaseOid?: string } = {},
): Promise<TaskWorkspaceLease> {
	if (!UUID_RE.test(leaseId)) throw new Error("resumeTask requires the checkpointed lowercase lease UUID");
	const root = await canonicalRoot(parent.root);
	const parentTree = await resolveTree(root, assertGitOid(parent.oid));
	const scopeBaseTree = await resolveTree(root, assertGitOid(options.scopeBaseOid ?? parent.oid));
	const refBase = workspaceRef(identity, id, leaseId);
	const state = await privateWorkRoot(root);
	const privateRoot = join(state, identity.planRevision, id, leaseId);
	assertInside(state, privateRoot);
	for (const directory of [join(state, identity.planRevision), join(state, identity.planRevision, id)]) {
		const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
		if (info && (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)) {
			throw new Error(`checkpointed workspace parent is not a private real directory: ${directory}`);
		}
	}
	const privateInfo = await lstat(privateRoot).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
	if (privateInfo && (!privateInfo.isDirectory() || privateInfo.isSymbolicLink() || (privateInfo.mode & 0o077) !== 0)) {
		throw new Error(`checkpointed workspace is not a private real directory: ${privateRoot}`);
	}
	const pinnedParent = await readRef(root, `${refBase}/parent`);
	if (pinnedParent !== parentTree) throw new Error(`checkpointed workspace parent pin is ${pinnedParent ?? "absent"}, not ${parentTree}`);
	const candidate = await readRef(root, `${refBase}/candidate`);
	if (!privateInfo && !candidate) throw new Error("checkpointed workspace and frozen candidate are both absent; recovery is required");
	const defaultControls = createTaskControls({ root, targetPaths: [] });
	const entries = await readTreeEntries(root, parentTree);
	const projected = new Map<string, { mode: "100644" | "100755"; oid: GitOid }>();
	const excluded: string[] = [];
	for (const entry of entries) {
		if (isDeniedPath(entry.path, defaultControls)) {
			excluded.push(entry.path);
			continue;
		}
		if (!isRegularEntry(entry)) throw new Error(`unsupported checkpointed parent entry ${JSON.stringify(entry.path)}`);
		projected.set(entry.path, { mode: entry.mode, oid: entry.oid });
	}
	const lease = Object.freeze({
		id: leaseId,
		kind: "task" as const,
		root,
		parentTree,
		scopeBaseTree,
		workspacePath: privateRoot,
		...(candidate ? { frozenCandidateTree: await resolveTree(root, candidate) } : {}),
		projectedParentPaths: Object.freeze([...projected.keys()].sort()),
		excludedParentPaths: Object.freeze(excluded.sort()),
	});
	const data: WorkspaceData = {
		root, parentTree, scopeBaseTree, privateRoot, projected, excluded, refBase,
		disposed: false, frozen: candidate !== undefined,
	};
	owned.set(lease, data);
	return lease;
}

/**
 * Host lifecycle boundary: call only after every writer/process for this lease
 * has been fenced. This records that host assertion; it does not kill workers.
 */
export function fenceWorkspace(lease: TaskWorkspaceLease, controls: TaskControls): FencedWorkspace {
	const data = owned.get(lease);
	if (!data || !("parentTree" in data) || data.disposed) throw new Error("cannot fence an unowned or disposed task workspace");
	if (resolve(controls.root) !== data.root) throw new Error("task controls root does not match the workspace root");
	// Validate targets/denies now, before any candidate filesystem scan.
	const normalized = createTaskControls(controls);
	const token = Object.freeze({ lease, controls: normalized });
	fenced.set(token, { data, controls: normalized });
	return token;
}

/** Validate the opaque host fence token and return its owned lease. */
export function requireFencedWorkspace(fencedWorkspace: FencedWorkspace): TaskWorkspaceLease {
	const authority = fenced.get(fencedWorkspace);
	if (!authority) throw new Error("operation requires a workspace fence created by fenceWorkspace");
	return fencedWorkspace.lease;
}

/**
 * Freeze a fenced workspace into a host-owned tree. Starts from the pinned
 * parent index, overlays only its projected delta, validates every delta path,
 * records the projection, and pins the candidate before returning.
 */
export async function freeze(fencedWorkspace: FencedWorkspace): Promise<FrozenTree> {
	const authority = fenced.get(fencedWorkspace);
	if (!authority || authority.data.disposed || authority.data.frozen) throw new Error("freeze requires a live, not-yet-frozen host-fenced workspace");
	const { data, controls } = authority;
	const current = await walkWorkspace(data.privateRoot);
	for (const item of current.values()) item.oid = await hashBlob(data.root, item.bytes);
	const changes: { path: string; mode: "100644" | "100755" | "0"; oid: string }[] = [];
	const changePaths = new Set([...data.projected.keys(), ...current.keys()]);
	let total = 0;
	for (const path of [...changePaths].sort()) {
		const before = data.projected.get(path);
		const after = current.get(path);
		if (!after) {
			if (before) {
				assertAdmissiblePath(path, controls);
				changes.push({ path, mode: "0", oid: "" });
			}
			continue;
		}
		if (!before || before.mode !== after.mode || before.oid !== after.oid) {
			assertAdmissiblePath(path, controls);
			changes.push({ path, mode: after.mode, oid: after.oid });
		}
		total += after.bytes.length;
		if (total > MAX_TOTAL_BYTES) throw new Error("frozen workspace exceeds the 512 MiB content limit");
	}
	// Removal records must precede additions when a worker replaced a file with
	// a directory (or vice versa), otherwise Git's temporary index sees a D/F conflict.
	changes.sort((a, b) => (a.mode === "0" ? 0 : 1) - (b.mode === "0" ? 0 : 1) || a.path.localeCompare(b.path));
	const tree = await writeTreeFromChanges(data.root, data.parentTree, changes);
	const treeChanges = await diffTrees(data.root, data.parentTree, tree);
	// Independently validate the per-wave tree delta, not just the filesystem walk.
	for (const change of treeChanges) assertAdmissiblePath(change.path, controls);
	// Scope is cumulative from the unchanged integration parent, while progress
	// above is measured from this wave's start tree.
	for (const change of await diffTrees(data.root, data.scopeBaseTree, tree)) assertAdmissiblePath(change.path, controls);
	await pinObject(data.root, `${data.refBase}/candidate`, tree);
	data.frozen = true;
	return Object.freeze({
		parentTree: data.parentTree,
		scopeBaseTree: data.scopeBaseTree,
		tree,
		changes: Object.freeze(treeChanges),
		projectedParentPaths: Object.freeze([...data.projected.keys()].sort()),
	});
}

async function walkWorkspace(root: string): Promise<Map<string, { mode: "100644" | "100755"; bytes: Buffer; oid: GitOid }>> {
	const files = new Map<string, { mode: "100644" | "100755"; bytes: Buffer; oid: GitOid }>();
	let total = 0;
	const foldedPaths = new Set<string>();
	const walk = async (dir: string, prefix: string): Promise<void> => {
		const rows = await readdir(dir, { withFileTypes: true });
		rows.sort((a, b) => a.name.localeCompare(b.name));
		for (const row of rows) {
			const relPath = prefix ? `${prefix}/${row.name}` : row.name;
			if (relPath.includes("\0") || relPath.includes("\\") || relPath.startsWith("/") || relPath.split("/").some((part) => part === "" || part === "." || part === "..")) {
				throw new Error(`invalid path in fenced workspace: ${JSON.stringify(relPath)}`);
			}
			const full = join(dir, row.name);
			const info = await lstat(full);
			if (info.isSymbolicLink()) throw new Error(`symlink in fenced workspace: ${JSON.stringify(relPath)}`);
			if (info.isDirectory()) {
				await walk(full, relPath);
				continue;
			}
			if (!info.isFile() || info.nlink !== 1) throw new Error(`non-regular or linked file in fenced workspace: ${JSON.stringify(relPath)}`);
			const folded = relPath.toLowerCase();
			if (foldedPaths.has(folded)) throw new Error(`case-colliding path in fenced workspace: ${JSON.stringify(relPath)}`);
			foldedPaths.add(folded);
			if (info.size > MAX_FILE_BYTES) throw new Error(`workspace file exceeds 32 MiB: ${JSON.stringify(relPath)}`);
			const bytes = await readFile(full);
			if (bytes.length !== info.size) throw new Error(`workspace file changed while freezing: ${JSON.stringify(relPath)}`);
			total += bytes.length;
			if (total > MAX_TOTAL_BYTES || files.size >= MAX_ENTRIES) throw new Error("fenced workspace exceeds entry/content limits");
			const mode = (info.mode & 0o111) !== 0 ? "100755" : "100644";
			files.set(relPath, { mode, bytes, oid: "" });
		}
	};
	await walk(root, "");
	return files;
}

/** Materialize a read-only projection of an immutable tree; no worker `.git`. */
export async function materializeRead(treeSource: GitTreeSource, controls: TaskControls): Promise<ReadWorkspace> {
	const root = await canonicalRoot(treeSource.root);
	if (resolve(controls.root) !== root) throw new Error("read controls root does not match Git object root");
	const normalized = createTaskControls(controls);
	const tree = await resolveTree(root, assertGitOid(treeSource.oid));
	const id = randomUUID();
	const state = await privateWorkRoot(root);
	const readRoot = join(state, "reads");
	await ensurePrivateDir(readRoot);
	const privateRoot = join(readRoot, id);
	await ensurePrivateDir(privateRoot);
	const captured = await materializeTree(root, tree, normalized, privateRoot, true);
	await makeDirectoriesReadOnly(privateRoot);
	const ref = `refs/kit/read/${id}/tree`;
	await pinObject(root, ref, tree);
	const data: ReadViewData = { root, privateRoot, tree, projected: [...captured.projected.keys()].sort(), excluded: captured.excluded, disposed: false };
	const view = Object.freeze({
		id,
		kind: "read" as const,
		root,
		tree,
		viewPath: privateRoot,
		projectedParentPaths: Object.freeze([...data.projected]),
		excludedParentPaths: Object.freeze([...data.excluded]),
	});
	owned.set(view, data);
	return view;
}

/** Observe the private directory behind a still-known opaque lease; never follows links. */
export async function observeLease(ownedLease: OwnedLease): Promise<"present" | "absent"> {
	const data = owned.get(ownedLease);
	if (!data) throw new Error("lease observation requires a handle created by this workspace module");
	const state = await privateWorkRoot(data.root);
	assertInside(state, data.privateRoot);
	const info = await lstat(data.privateRoot).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
	if (!info) return "absent";
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("owned lease path was replaced by a non-directory or symbolic link");
	return "present";
}

/** Remove only an opaque lease created by this module; callers supply no path. */
export async function discard(ownedLease: OwnedLease): Promise<void> {
	const data = owned.get(ownedLease);
	if (!data || data.disposed) throw new Error("discard requires a live lease created by this workspace module");
	const state = await privateWorkRoot(data.root);
	assertInside(state, data.privateRoot);
	const info = await lstat(data.privateRoot).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
	if (info?.isSymbolicLink()) throw new Error("refusing to discard a replaced symbolic-link lease path");
	if (info && !info.isDirectory()) throw new Error("refusing to discard a replaced non-directory lease path");
	if (info) {
		if ("tree" in data) await makeDirectoriesWritable(data.privateRoot);
		await rm(data.privateRoot, { recursive: true, force: false });
	}
	data.disposed = true;
}

/**
 * Observe a CHECKPOINTED task workspace without an in-memory lease handle
 * (M0-P18 human resolution). The lease id comes from the durable checkpoint, so
 * the caller never supplies a filesystem path: this module recomputes the
 * private location, refuses a replaced/symlinked component, and reports whether
 * the owned lease directory is still PRESENT. A resolution may only proceed on
 * a CONFIRMED FENCED DISCARD (`lease: "absent"`); a present directory means a
 * live/unsealed workspace and stops the human path.
 *
 * The retained candidate pin is read too, so `resolve --accept-tree` can prove
 * the requested tree is the one this wave froze.
 */
export type CheckpointedWorkspaceState = Readonly<{
	lease: "present" | "absent";
	/** The pinned frozen candidate of this lease, when one was frozen. */
	candidate?: GitOid;
}>;

export async function inspectCheckpointedWorkspace(
	root: string,
	identity: PlanIdentity,
	taskId: string,
	leaseId: string,
): Promise<CheckpointedWorkspaceState> {
	if (!UUID_RE.test(leaseId)) throw new Error("checkpointed workspace observation requires the recorded lowercase lease UUID");
	const actual = await canonicalRoot(root);
	const refBase = workspaceRef(identity, taskId, leaseId);
	const state = await privateWorkRoot(actual);
	const privateRoot = join(state, identity.planRevision, taskId, leaseId);
	assertInside(state, privateRoot);
	for (const directory of [join(state, identity.planRevision), join(state, identity.planRevision, taskId)]) {
		const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
		if (info && (!info.isDirectory() || info.isSymbolicLink())) {
			throw new Error(`checkpointed workspace parent is not a private real directory: ${directory}`);
		}
	}
	const info = await lstat(privateRoot).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
	if (info && (info.isSymbolicLink() || !info.isDirectory())) {
		throw new Error("checkpointed workspace path was replaced by a non-directory or symbolic link");
	}
	const candidate = await readRef(actual, `${refBase}/candidate`);
	return Object.freeze({
		lease: info ? "present" as const : "absent" as const,
		...(candidate ? { candidate } : {}),
	});
}

/** Compare two immutable Git trees with exact path and executable-mode changes. */
export async function diffTaskTrees(source: GitTreeSource, before: string, after: string): Promise<GitTreeChange[]> {
	const root = await canonicalRoot(source.root);
	return await diffTrees(root, before, after);
}

/** Convenience constructor for controls bound to the Git source's canonical root. */
export async function controlsForTree(source: GitTreeSource, targetPaths: readonly string[], deniedPaths: readonly string[] = []): Promise<TaskControls> {
	return createTaskControls({ root: await canonicalRoot(source.root), targetPaths, deniedPaths });
}

/**
 * plans.ts — plan identity (§1 ADR 01, M0-P04).
 *
 * A reviewed plan is not identified by its schema version, a PRD digest, or a
 * timestamp — each can survive a different decomposition. Every successful
 * `plan` mints a FRESH identity:
 *
 *   planRevision      — a new UUIDv4 per plan, even for identical replans;
 *   definitionSha256  — canonical SHA256 over the immutable task definitions
 *                       (recursively sorted object keys, order-preserving
 *                       arrays, UTF-8 JSON); status/counter/receipt fields are
 *                       excluded by construction;
 *   baseCommit        — git HEAD at planning (null when the project has no
 *                       commit yet); uncommitted operator edits are excluded
 *                       from the base;
 *   baseBranch        — the checked-out branch at planning (null when detached);
 *   prdPath/prdSha256 — the normalized project-relative PRD path and content
 *                       digest;
 *   controlsSha256    — digest over the reviewed control bundle captured ONCE
 *                       before disclosure: every `evals/**` regular-file byte,
 *                       PROMPT.md, approved gate remediations, the actual
 *                       configured/`--prd` file and the effective verification/
 *                       delivery/routing/admission settings. ABSENT (no control
 *                       input exists at all) is distinct from a digest over
 *                       empty controls, and absent remediations are distinct
 *                       from an empty approved list inside the hashed payload.
 *                       `budgets.sessionUsd` is excluded (a raised ceiling is
 *                       not control drift).
 *
 * Capturing the bundle before the planner sees the PRD means the recorded
 * identity describes the bytes and settings actually used for that review. The
 * same identity is validated at a new grant, at resume and at each fresh wave/
 * retry boundary; a mismatch refuses new work and never rewrites receipts.
 *
 * Replans archive the replaced plan's identity references on the RouterDoc and
 * invalidate prior approvals ATOMICALLY in the same commit (see planner.ts) —
 * a replaced plan is a new review point, never a continuation of the old grant.
 *
 * This module computes identity inputs only. It performs no storage writes and
 * never invents receipts: legacy (v1) plans have no identity and are never
 * given retroactive ones.
 */
import { createHash, randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import { headBranch, headCommit, shasum } from "../util/git.ts";
import { readBlob, readTreeEntries, resolveTree } from "../util/git-objects.ts";
import { resolveCanonicalProjectRoot } from "../sandbox/host-profile.ts";
import { SafeReadBudget, readSafeFile, readSafeText, walkSafeFiles } from "../util/safe-read.ts";
import { controlPolicySettings, loadConfig } from "../config.ts";
import type { ControlPolicySettings, KitConfig } from "../config.ts";
import type { RouterTask } from "./infos.ts";
import type { Remediation } from "../adoption/types.ts";

// ---------------------------------------------------------------------------
// Canonical hashing
// ---------------------------------------------------------------------------

/**
 * Recursively canonicalize a JSON value: object keys sorted, array order
 * preserved. The result feeds JSON.stringify (UTF-8), so the digest is
 * independent of the producer's key order and whitespace.
 */
export function canonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJson);
	if (value !== null && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) out[key] = canonicalJson(source[key]);
		return out;
	}
	return value;
}

/** SHA256 of the canonical UTF-8 JSON encoding (§3: recursively sorted keys, order-preserving arrays). */
export function canonicalSha256(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(canonicalJson(value)), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Digest type alias for readability (full lowercase SHA256 hex). */
export type Digest = string;

/**
 * The immutable definition of one task: exactly the reviewed planner fields.
 * Runtime fields (status, waveCount, counters, conversation ids, gate hashes,
 * feedback) are execution state and are NOT part of the definition digest.
 */
export type TaskDef = Pick<RouterTask, "id" | "title" | "spec" | "dependsOn" | "acceptance" | "targetPaths" | "priority">;

/** Identity of one reviewed plan (§3 host-owned shape; controlsSha256 stays optional: absent ≠ empty). */
export type PlanIdentity = {
	/** Fresh UUIDv4 minted by THIS plan run — even for identical replans. */
	planRevision: string;
	/** Canonical digest over the immutable task definitions. */
	definitionSha256: Digest;
	/** Reviewed base commit (git HEAD at planning); null when the project has no commit yet. */
	baseCommit: string | null;
	/** Checked-out branch at planning; null when HEAD is detached or there is no repository. */
	baseBranch: string | null;
	/** Normalized project-relative PRD path. */
	prdPath: string;
	/** SHA256 of the PRD text as planned. */
	prdSha256: Digest;
	/** Digest over the approved controls bundle; ABSENT when no control input exists (distinct from a digest over empty controls). */
	controlsSha256?: Digest;
};

/** Reference to a REPLACED plan, stored on the RouterDoc (most recent first). References only — never receipts. */
export type ArchivedPlanRef = {
	planRevision: string;
	definitionSha256: Digest;
	prdPath: string;
	prdSha256: Digest;
	archivedAt: number;
};

/** The immutable definition payload hashed into `definitionSha256`. */
export function planDefinition(tasks: readonly RouterTask[]): { tasks: TaskDef[] } {
	return {
		tasks: tasks.map((t) => ({
			id: t.id,
			title: t.title,
			spec: t.spec,
			dependsOn: [...t.dependsOn],
			acceptance: [...t.acceptance],
			targetPaths: [...t.targetPaths],
			priority: t.priority,
		})),
	};
}

/** Canonical digest over a plan's immutable task definitions. */
export function planDefinitionSha256(tasks: readonly RouterTask[]): Digest {
	return canonicalSha256(planDefinition(tasks));
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Normalize a project-relative path for identity storage: resolved against the
 * project root, POSIX separators, traversal refused. The PRD is a reviewable
 * project file; a plan that reaches outside the project has no admissible
 * identity.
 */
export function normalizeRelPath(root: string, path: string): string {
	if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || /^[A-Za-z]:/.test(path)) {
		throw new Error(`path ${JSON.stringify(path)} is not a safe project-relative path`);
	}
	const resolved = resolve(root, path);
	const rel = relative(root, resolved);
	if (!rel || rel.startsWith("..") || resolve(rel) === rel) {
		throw new Error(`path ${JSON.stringify(path)} is not inside the project root — plan inputs must be project-relative`);
	}
	return rel.split(/[\\/]/).join("/");
}

/**
 * Approved controls present in the project, as captured identity inputs.
 *
 * M1-P01 step (d) widened this from five named files to the reviewed control
 * bundle: every regular file under `evals/**` (bytes, so executable assertion
 * scripts count too), `PROMPT.md`, the approved gate remediations, the ACTUAL
 * configured/`--prd` file, and the effective verification/delivery/routing/
 * admission policy settings. `budgets.sessionUsd` is not part of the payload
 * because raising a spend ceiling is not a new plan.
 *
 * ABSENT is distinct from empty: `evals: null` means the directory does not
 * exist, `evals: []` means it exists and holds no files; `prompt: null` means
 * no PROMPT.md; `remediations: null` means no remediations file. A `prd` key
 * absent means this capture did not bind a PRD at all (unit capture only);
 * `prd: null` means a PRD was requested and is now absent.
 */
export interface PlanControlFile {
	/** Root-relative reviewed name. */
	path: string;
	/** Length of the reviewed bytes (UTF-8 bytes for text controls). */
	bytes: number;
	/** SHA256 over exactly those bytes. */
	sha256: Digest;
}

export interface PlanControls {
	/** Approved gate-gap remediations (parsed); null when the file is absent. */
	remediations: Remediation[] | null;
	/** Every regular file under `evals/` (sorted); null when the directory is absent. */
	evals: PlanControlFile[] | null;
	/** PROMPT.md (wave discipline rules); null when absent. */
	prompt: PlanControlFile | null;
	/** The actual configured/`--prd` file; omitted only when no PRD was requested. */
	prd?: PlanControlFile | null;
	/** Effective policy settings; null only for a file-only unit capture. */
	settings: ControlPolicySettings | null;
}

export interface ControlCaptureOptions {
	/** The actual configured/`--prd` path (normalized by the capture). Omitted only by unit captures. */
	prdPath?: string;
	/**
	 * The exact PRD text already loaded for disclosure (plan-time capture). When
	 * omitted, the file is read through the boundary at `prdPath`.
	 */
	prdText?: string;
	/** The effective config in force; its policy settings are bound to the digest. */
	config?: KitConfig;
}

function controlRefusal(code: string, rel: string, message: string): Error {
	const notRegular = code === "symlink" || code === "not-regular" || code === "hardlink";
	return new Error(
		`${notRegular ? "review control is not a regular file" : "review control is unreadable"}: ${rel} (${code}: ${message})`,
	);
}

/** Read one reviewed control as bytes (works for executable/binary eval scripts). */
async function reviewedControlFile(root: string, rel: string, budget: SafeReadBudget): Promise<PlanControlFile | null> {
	const read = await readSafeFile({ root, path: rel, budget });
	if (read.kind === "ok") {
		return { path: rel, bytes: read.value.byteLength, sha256: createHash("sha256").update(read.value).digest("hex") };
	}
	if (read.kind === "absent") return null;
	throw controlRefusal(read.code, rel, read.message);
}

/** Read one reviewed control as strict UTF-8 text. */
async function reviewedControlText(root: string, rel: string, budget: SafeReadBudget): Promise<string | null> {
	const read = await readSafeText({ root, path: rel, budget });
	if (read.kind === "ok") return read.value;
	if (read.kind === "absent") return null;
	throw controlRefusal(read.code, rel, read.message);
}

/** Text control record whose digest matches the PRD identity (`shasum` of the text). */
function textControl(path: string, text: string): PlanControlFile {
	return { path, bytes: Buffer.byteLength(text, "utf8"), sha256: shasum(text) };
}

async function readRemediationControls(root: string, budget: SafeReadBudget): Promise<Remediation[] | null> {
	const raw = await reviewedControlText(root, ".orch/gate-remediations.json", budget);
	if (raw === null) return null;
	const stored: unknown = JSON.parse(raw);
	if (!stored || typeof stored !== "object" || (stored as { version?: unknown }).version !== 1 || !Array.isArray((stored as { remediations?: unknown }).remediations)) {
		throw new Error("invalid reviewed gate-remediations.json; repair it before planning or running");
	}
	return (stored as { remediations: Remediation[] }).remediations;
}

async function readEvalControls(root: string, budget: SafeReadBudget): Promise<PlanControlFile[] | null> {
	const walk = await walkSafeFiles({ root, path: "evals" });
	if (walk.kind === "absent") return null;
	if (walk.kind === "refused") throw controlRefusal(walk.code, walk.path, walk.message);
	const files: PlanControlFile[] = [];
	for (const rel of walk.value.files) {
		const file = await reviewedControlFile(root, rel, budget);
		if (file === null) throw new Error(`review control vanished while the bundle was captured: ${rel}`);
		files.push(file);
	}
	return files;
}

/**
 * Capture the reviewed control bundle ONCE. Call this before the PRD (or any
 * control) is disclosed to a model, and reuse the returned payload for the
 * plan identity — never hash working files after disclosure. One canonical
 * root and one `SafeReadBudget` cover every read; a symlink, non-regular/hard-
 * linked file, escape, malformed text or cap excess refuses the capture.
 */
export async function loadPlanControls(rootInput: string, options: ControlCaptureOptions = {}): Promise<PlanControls> {
	const root = await resolveCanonicalProjectRoot(rootInput);
	const budget = new SafeReadBudget();
	const controls: PlanControls = {
		remediations: await readRemediationControls(root, budget),
		evals: await readEvalControls(root, budget),
		prompt: await reviewedControlFile(root, "PROMPT.md", budget),
		settings: options.config ? controlPolicySettings(options.config) : null,
	};
	if (options.prdPath !== undefined) {
		const rel = normalizeRelPath(root, options.prdPath);
		const text = options.prdText ?? await reviewedControlText(root, rel, budget);
		controls.prd = text === null ? null : textControl(rel, text);
	}
	return controls;
}

/** Approved remediations alone, read through the same boundary (null = absent). */
export async function readRemediations(rootInput: string): Promise<Remediation[] | null> {
	const root = await resolveCanonicalProjectRoot(rootInput);
	return readRemediationControls(root, new SafeReadBudget());
}

function controlsAbsent(controls: PlanControls): boolean {
	return controls.remediations === null
		&& controls.evals === null
		&& controls.prompt === null
		&& controls.settings === null
		&& !("prd" in controls);
}

/** Digest over a captured controls payload. ABSENT only when no input exists at all. */
export function controlsDigest(controls: PlanControls): Digest | undefined {
	return controlsAbsent(controls) ? undefined : canonicalSha256(controls);
}

/**
 * Digest of the PRE-step-(d) controls payload shape.
 *
 * This is used only to recognize a migration, never to authorize work: a plan
 * minted before the bundle widened recorded a digest over the five named
 * fields below. Recomputing that old shape from the CURRENT capture lets the
 * refusal say "the reviewed inputs are unchanged; the plan predates the
 * widened payload" instead of falsely claiming an on-disk edit.
 */
export function legacyControlsDigest(controls: PlanControls): Digest {
	const evalSha = (path: string): Digest | null => controls.evals?.find((file) => file.path === path)?.sha256 ?? null;
	return canonicalSha256({
		remediations: controls.remediations,
		promptSha256: controls.prompt?.sha256 ?? null,
		checklistSha256: evalSha("evals/checklist.md"),
		recipesSha256: evalSha("evals/recipes.toml"),
		recipesAutoSha256: evalSha("evals/recipes.auto.toml"),
	});
}

/**
 * Compare the current capture with the digest recorded by a reviewed plan.
 * `undefined` means the reviewed inputs still bind. A legacy-shaped digest is
 * named as a migration, not as an on-disk change; every other mismatch is
 * control drift and never authorizes fresh work.
 */
export function controlsBindingRefusal(identity: PlanIdentity, controls: PlanControls): string | undefined {
	if (controlsDigest(controls) === identity.controlsSha256) return undefined;
	if (identity.controlsSha256 !== undefined && legacyControlsDigest(controls) === identity.controlsSha256) {
		return `plan revision ${identity.planRevision} was reviewed under the pre-M1-P01-step-(d) control digest shape; that digest never bound the widened evals/PRD/PROMPT/settings bundle (the legacy named files are unchanged on disk) — replan and re-approve before granting or starting more work`;
	}
	return `reviewed controls changed — the approved control inputs changed on disk since plan revision ${identity.planRevision} was reviewed; restore them or replan before granting or starting more work`;
}

/**
 * Refuse a plan whose captured controls do not match the bytes the driver will
 * execute from the reviewed base tree.
 *
 * The driver reads recipes from the immutable start tree (`recipeBundleFromTree`)
 * and PROMPT.md from the projected start tree, never from the operator worktree.
 * Therefore every control file the base tree can execute must exist in the
 * capture with identical bytes. A tracked control edited or deleted after the
 * base commit is refused here, before the PRD is disclosed to the planner, so
 * the operator must commit the reviewed `evals/**`/PROMPT.md bytes (or restore
 * them) before planning. A genuinely new, UNTRACKED control file is captured in
 * the identity but cannot execute from the base tree; it is not a divergent
 * executed byte and is recorded as reviewed-but-not-executable.
 */
export async function reviewedBaseTreeRefusal(rootInput: string, baseCommit: string | null, controls: PlanControls): Promise<string | undefined> {
	if (baseCommit === null) return undefined; // no base tree exists; run refuses until a commit and replan
	const root = await resolveCanonicalProjectRoot(rootInput);
	let entries: Awaited<ReturnType<typeof readTreeEntries>>;
	try {
		entries = await readTreeEntries(root, await resolveTree(root, baseCommit));
	} catch (error) {
		return `the reviewed base commit ${baseCommit.slice(0, 12)} cannot be read: ${(error as Error).message} — commit the reviewed controls and replan`;
	}
	const captured = new Map<string, Digest>();
	for (const file of controls.evals ?? []) captured.set(file.path, file.sha256);
	if (controls.prompt !== null) captured.set(controls.prompt.path, controls.prompt.sha256);
	for (const entry of entries) {
		const reviewedControl = entry.path === "PROMPT.md" || entry.path.startsWith("evals/");
		if (!reviewedControl || entry.type === "tree") continue;
		if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
			return `reviewed base tree entry ${entry.path} is not a regular file (${entry.mode} ${entry.type}) — the driver cannot execute it as a reviewed control; remove it or replan from a clean base`;
		}
		const expected = captured.get(entry.path);
		if (expected === undefined) {
			return `reviewed control ${entry.path} exists in base commit ${baseCommit.slice(0, 12)} but is absent from the working-tree capture — restore it or commit the reviewed evals/** and PROMPT.md bytes before planning`;
		}
		let bytes: Buffer;
		try {
			bytes = await readBlob(root, entry.oid);
		} catch (error) {
			return `reviewed control ${entry.path} in base commit ${baseCommit.slice(0, 12)} cannot be read: ${(error as Error).message} — replan after repairing the base tree`;
		}
		if (createHash("sha256").update(bytes).digest("hex") !== expected) {
			return `reviewed control ${entry.path} differs from base commit ${baseCommit.slice(0, 12)} — the driver executes the base tree, not the working tree; commit the reviewed evals/** and PROMPT.md bytes before planning`;
		}
	}
	return undefined;
}

/**
 * Digest over the current control inputs. Production callers pass the effective
 * config and the reviewed `prdPath`; validation of an existing plan uses the
 * pinned `identity.prdPath`.
 */
export async function controlsSha256(root: string, options: ControlCaptureOptions = {}): Promise<Digest | undefined> {
	return controlsDigest(await loadPlanControls(root, options));
}

/**
 * Validate a reviewed plan identity against the current host/project inputs at
 * a boundary that may start or resume work. Returns a refusal string (no side
 * effects) or undefined. The pinned identity supplies the PRD path; HEAD, the
 * actual PRD bytes, every `evals/**` byte, PROMPT.md, approved remediations and
 * the effective policy settings must all still match what was reviewed.
 *
 * Raising only `budgets.sessionUsd` is NOT drift (the ceiling is excluded from
 * the settings projection), so a budget pause still resumes the same plan.
 */
export async function reviewBindingRefusal(
	root: string,
	identity: PlanIdentity,
	config: KitConfig,
): Promise<string | undefined> {
	const canonicalRoot = await resolveCanonicalProjectRoot(root);
	if (await headCommit(canonicalRoot) !== identity.baseCommit) return "reviewed HEAD moved — replan before granting or starting more work";
	let controls: PlanControls;
	try {
		controls = await loadPlanControls(canonicalRoot, { prdPath: identity.prdPath, config });
		const currentSettings = controlPolicySettings(await loadConfig(canonicalRoot));
		if (canonicalSha256(currentSettings) !== canonicalSha256(controls.settings)) {
			return "reviewed policy settings changed on disk — replan and re-approve before granting or starting more work";
		}
	} catch (error) {
		return `reviewed control inputs cannot be read: ${(error as Error).message} — restore them or replan before granting or starting more work`;
	}
	if (controls.prd === undefined || controls.prd === null) {
		return `the reviewed PRD ${identity.prdPath} is absent — restore it or replan before granting or starting more work`;
	}
	if (controls.prd.sha256 !== identity.prdSha256) {
		return `the reviewed PRD ${identity.prdPath} changed — replan and re-approve before granting or starting more work`;
	}
	return controlsBindingRefusal(identity, controls);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Mint the identity of one plan from the control bundle captured BEFORE the
 * PRD was disclosed (see `loadPlanControls`). No files are re-read here: the
 * recorded identity is the reviewed capture, not the working tree after the
 * planning conversation. No state mutation either — every input is read before
 * the plan commit, so a failure here leaves the previous plan untouched.
 */
export async function buildPlanIdentity(
	root: string,
	prdPath: string,
	prdText: string,
	tasks: readonly RouterTask[],
	controls: PlanControls,
	/** Git base captured with the controls BEFORE disclosure; absent = read now. */
	base?: { commit: string | null; branch: string | null },
): Promise<PlanIdentity> {
	const identity: PlanIdentity = {
		planRevision: randomUUID(),
		definitionSha256: planDefinitionSha256(tasks),
		baseCommit: base ? base.commit : await headCommit(root),
		baseBranch: base ? base.branch : await headBranch(root),
		prdPath: normalizeRelPath(root, prdPath),
		prdSha256: shasum(prdText),
	};
	const digest = controlsDigest(controls);
	if (digest !== undefined) identity.controlsSha256 = digest;
	return identity;
}

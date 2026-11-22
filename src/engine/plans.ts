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
 *   controlsSha256    — digest over the approved review controls (gate-gap
 *                       remediations, PROMPT.md rules, checklist, human and
 *                       approved generated recipes). ABSENT (no control input
 *                       exists at all) is distinct from a digest over empty
 *                       controls, and absent remediations are distinct from an
 *                       empty approved list inside the hashed payload.
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
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { readJson } from "../util/fsx.ts";
import { headBranch, headCommit, shasum } from "../util/git.ts";
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
	const resolved = resolve(root, path);
	const rel = relative(root, resolved);
	if (!rel || rel.startsWith("..") || resolve(rel) === rel) {
		throw new Error(`path ${JSON.stringify(path)} is not inside the project root — plan inputs must be project-relative`);
	}
	return rel.split(/[\\/]/).join("/");
}

/**
 * Approved controls present in the project, as identity inputs. Every field is
 * null when its input is absent, so "no approved remediations file" hashes
 * differently from "an approved (empty) remediations list".
 */
export interface PlanControls {
	/** Approved gate-gap remediations (parsed); null when the file is absent or unreadable. */
	remediations: Remediation[] | null;
	/** PROMPT.md (wave discipline rules) content digest; null when absent. */
	promptSha256: Digest | null;
	/** evals/checklist.md (review rules) content digest; null when absent. */
	checklistSha256: Digest | null;
	/** evals/recipes.toml (human recipes) content digest; null when absent. */
	recipesSha256: Digest | null;
	/** evals/recipes.auto.toml (approved generated recipes) content digest; null when absent. */
	recipesAutoSha256: Digest | null;
}

async function fileSha256(root: string, rel: string): Promise<Digest | null> {
	try {
		return shasum(await readFile(join(root, rel), "utf8"));
	} catch {
		return null;
	}
}

/** Read the approved controls inputs (no writes; absent files are null, not errors). */
export async function loadPlanControls(root: string): Promise<PlanControls> {
	const stored = await readJson<{ version: number; remediations: Remediation[] }>(join(root, ".orch", "gate-remediations.json"));
	const remediations = stored?.version === 1 && Array.isArray(stored.remediations) ? stored.remediations : null;
	return {
		remediations,
		promptSha256: await fileSha256(root, "PROMPT.md"),
		checklistSha256: await fileSha256(root, "evals/checklist.md"),
		recipesSha256: await fileSha256(root, "evals/recipes.toml"),
		recipesAutoSha256: await fileSha256(root, "evals/recipes.auto.toml"),
	};
}

/**
 * Digest over the approved controls payload. ABSENT (undefined) when no
 * control input exists at all — distinct from a digest over empty controls
 * (e.g. an approved-empty remediations list with a checklist present).
 */
export async function controlsSha256(root: string): Promise<Digest | undefined> {
	const controls = await loadPlanControls(root);
	if (
		controls.remediations === null &&
		controls.promptSha256 === null &&
		controls.checklistSha256 === null &&
		controls.recipesSha256 === null &&
		controls.recipesAutoSha256 === null
	) {
		return undefined;
	}
	return canonicalSha256(controls);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Mint the identity of one plan. Pure inputs, no state mutation: every read
 * (git, files) happens BEFORE the plan commit, so a failure here leaves the
 * previous plan untouched.
 */
export async function buildPlanIdentity(root: string, prdPath: string, prdText: string, tasks: readonly RouterTask[]): Promise<PlanIdentity> {
	const identity: PlanIdentity = {
		planRevision: randomUUID(),
		definitionSha256: planDefinitionSha256(tasks),
		baseCommit: await headCommit(root),
		baseBranch: await headBranch(root),
		prdPath: normalizeRelPath(root, prdPath),
		prdSha256: shasum(prdText),
	};
	const controls = await controlsSha256(root);
	if (controls !== undefined) identity.controlsSha256 = controls;
	return identity;
}

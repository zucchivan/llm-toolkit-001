/**
 * Three-class repository hygiene (engineering plan §1 ADR 04).
 *
 * Every project-relative path belongs to exactly one ownership class,
 * independent of authorship:
 *
 * - `reviewable` — project code, PRD, `PROMPT.md`, human and approved generated
 *   recipes, checklist, and the three reviewable kit controls
 *   (`.orch/config.toml`, `.orch/gate-decisions.json`,
 *   `.orch/gate-remediations.json`). Committable; the kit never auto-stages them.
 * - `optional-trail` — `router.md`, `.orch/wave-log.jsonl`, `.orch/kit-version`:
 *   the local paper trail. Ignored by default; the human may explicitly retain
 *   it after review.
 * - `private` — all other `.orch/**` data (SQLite/WAL/SHM, lock, notes,
 *   projections, workspaces, assessments, telemetry, exports, UI jobs).
 *   Ignored by default and never published by kit action.
 *
 * `classifyProjectPath` is the shared category helper: later packets (workspace
 * admission, delivery refusal) reuse it instead of re-deriving the classes.
 * `installProjectHygiene` writes one bounded, idempotent block into the target
 * project's root `.gitignore`. It never modifies the git index or history: a
 * pre-existing parent-exclusion pattern or a tracked private file is REPORTED
 * as a conflict with manual remediation, never repaired silently.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "./util/git-objects.ts";
import { readSafeText, requireSafeReadRoot, SafeReadRefusalError } from "./util/safe-read.ts";

export type OwnershipClass = "reviewable" | "optional-trail" | "private";

export const OWNERSHIP_CLASS_LABELS: Record<OwnershipClass, string> = {
	reviewable: "reviewable (committable; never auto-staged)",
	"optional-trail": "optional local paper trail (ignored by default; retain explicitly after review)",
	private: "private runtime state (ignored by default; never published by kit action)",
};

const REVIEWABLE_ORCH_FILES = new Set(["config.toml", "gate-decisions.json", "gate-remediations.json"]);
const OPTIONAL_TRAIL_ORCH_FILES = new Set(["wave-log.jsonl", "kit-version"]);

/**
 * Classify one project-relative path (POSIX separators; `./` and leading-slash
 * noise tolerated) into its ADR 04 ownership class.
 */
export function classifyProjectPath(relPath: string): OwnershipClass {
	let p = relPath.replaceAll("\\", "/");
	while (p.startsWith("./")) p = p.slice(2);
	p = p.replace(/^\/+/, "");
	if (p === "" || p === ".") throw new Error(`hygiene: cannot classify empty project path: ${JSON.stringify(relPath)}`);
	if (p === "router.md") return "optional-trail";
	const segments = p.split("/");
	if (segments[0] !== ".orch") return "reviewable";
	const rest = segments.slice(1).join("/");
	if (REVIEWABLE_ORCH_FILES.has(rest)) return "reviewable";
	if (OPTIONAL_TRAIL_ORCH_FILES.has(rest)) return "optional-trail";
	return "private";
}

// ---------------------------------------------------------------------------
// The bounded .gitignore block
// ---------------------------------------------------------------------------

export const HYGIENE_BLOCK_BEGIN = "# >>> llm-toolkit-001 repository hygiene (ADR 04: three ownership classes)";
export const HYGIENE_BLOCK_END = "# <<< llm-toolkit-001 repository hygiene";

/**
 * The exact rule lines, in order: private-by-default with reviewable
 * exceptions, then the paper-trail mirror. `/.orch/*` must precede the `!`
 * exceptions and `/router.md` follows them.
 */
export const HYGIENE_RULE_LINES: readonly string[] = [
	"/.orch/*",
	"!/.orch/config.toml",
	"!/.orch/gate-decisions.json",
	"!/.orch/gate-remediations.json",
	"/router.md",
];

export const HYGIENE_BLOCK_LINES: readonly string[] = [
	HYGIENE_BLOCK_BEGIN,
	"# Reviewable kit controls (.orch/config.toml, .orch/gate-decisions.json,",
	"# .orch/gate-remediations.json) stay committable; the kit never auto-stages",
	"# them and the negations below keep them visible:",
	HYGIENE_RULE_LINES[0]!,
	HYGIENE_RULE_LINES[1]!,
	HYGIENE_RULE_LINES[2]!,
	HYGIENE_RULE_LINES[3]!,
	"# Everything else under .orch/ is private runtime state (SQLite/WAL/SHM, lock,",
	"# notes, projections, workspaces, assessments, telemetry, exports, UI jobs);",
	"# router.md is the optional local paper-trail mirror. Trail and private state",
	"# are ignored by default; after review you may explicitly retain the trail:",
	"#   git add -f router.md .orch/wave-log.jsonl .orch/kit-version",
	"# See docs/project-contract.md (three ownership classes).",
	HYGIENE_RULE_LINES[4]!,
	HYGIENE_BLOCK_END,
];

/** The block as installed: LF-delimited, always newline-terminated. */
export function hygieneBlockText(): string {
	return `${HYGIENE_BLOCK_LINES.join("\n")}\n`;
}

/** Idempotency probe: the marker plus every rule line is present. */
export function hygieneBlockInstalled(content: string): boolean {
	return content.includes(HYGIENE_BLOCK_BEGIN) && HYGIENE_RULE_LINES.every((line) => content.includes(`\n${line}\n`) || content.includes(`${line}\n`));
}

/**
 * Patterns that exclude the `.orch/` directory ITSELF (or everything, which
 * includes it). Git cannot re-include files under an excluded directory, so
 * any such rule defeats the reviewable exceptions — report, don't repair.
 */
function excludesOrchParent(pattern: string): boolean {
	const p = pattern.trim();
	return p === ".orch" || p === ".orch/" || p === "/.orch" || p === "/.orch/" || p === ".*" || p === "*" || p === "/*" || p === "/**";
}

/** Conflicts found in pre-existing .gitignore content (comments/negations skipped). */
export function findGitignoreConflicts(existing: string): string[] {
	const conflicts: string[] = [];
	for (const raw of existing.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
		if (excludesOrchParent(line)) {
			conflicts.push(
				`.gitignore pattern ${JSON.stringify(line)} excludes the .orch/ directory itself, so the hygiene ` +
					`exceptions (reviewable .orch/config.toml, .orch/gate-decisions.json, .orch/gate-remediations.json) ` +
					`cannot take effect — Git cannot re-include files under an excluded directory. Adjust the rule ` +
					`(for example ${JSON.stringify("/.orch/*")} with explicit negations) so the reviewable kit controls stay committable.`,
			);
		}
	}
	return conflicts;
}

export interface HygienePlan {
	/** Full resulting .gitignore content (unchanged when already installed). */
	content: string;
	/** true when the block was appended on top of the input. */
	installed: boolean;
	/** Conflicts in pre-existing content; reported, never repaired here. */
	conflicts: string[];
}

/**
 * Pure block installer: LF-delimited, newline-safe when the existing file
 * lacks a final newline, existing comments/custom patterns preserved verbatim.
 */
export function applyHygieneBlock(existing: string): HygienePlan {
	const conflicts = findGitignoreConflicts(existing);
	if (hygieneBlockInstalled(existing)) return { content: existing, installed: false, conflicts };
	const base = existing === "" ? "" : existing.endsWith("\n") ? existing : `${existing}\n`;
	return { content: base + hygieneBlockText(), installed: true, conflicts };
}

// ---------------------------------------------------------------------------
// Installation + tracked-file conflicts (never index/history changes)
// ---------------------------------------------------------------------------

export interface HygieneInstall {
	/** true when the block was appended during this call. */
	installed: boolean;
	/** Human-readable conflicts (parent-exclusion patterns, tracked private files). */
	conflicts: string[];
}

/**
 * Install the hygiene block into `<root>/.gitignore` and report conflicts.
 * Idempotent; never touches the git index, never unstages, never deletes:
 * tracked private runtime files are reported with manual remediation
 * (`git rm --cached <path>` is the operator's explicit decision, after saving
 * anything they need), and pre-existing parent-exclusion patterns are
 * reported for the operator to adjust.
 *
 * M1-P01 step (g): the existing `.gitignore` is read through the canonical-root
 * + no-follow, capped boundary (Git itself already goes through `runGit`). A
 * genuine ENOENT writes a fresh block; a REFUSED file (a symlink — leaf or
 * ancestor — a hard link, a non-regular type, a permission failure or the cap)
 * throws `SafeReadRefusalError` BEFORE any write, so an already-hostile link is
 * never appended through. (The write itself is init's operator-invoked path and
 * is not part of P01's read boundary; a concurrent swap between this read and
 * the write is not claimed as closed here.)
 */
export async function installProjectHygiene(root: string): Promise<HygieneInstall> {
	const canonical = await requireSafeReadRoot(root);
	const gitignore = join(canonical, ".gitignore");
	const read = await readSafeText({ root: canonical, path: ".gitignore" });
	if (read.kind === "refused") throw new SafeReadRefusalError(read);
	const current = read.kind === "ok" ? read.value : "";
	const plan = applyHygieneBlock(current);
	if (plan.installed) await writeFile(gitignore, plan.content, "utf8");
	const conflicts = [...plan.conflicts];
	for (const tracked of await trackedPrivateFiles(canonical)) {
		conflicts.push(
			`tracked private runtime file ${JSON.stringify(tracked)}: .gitignore rules do not apply to tracked files, ` +
				`so it remains published even though its class is private. The kit never modifies the index or history; ` +
				`to stop tracking it, run \`git rm --cached -- ${tracked}\` yourself after saving anything you need.`,
		);
	}
	return { installed: plan.installed, conflicts };
}

/** Project-relative private-class files the repo already tracks (sorted; empty when not a repo). */
export async function trackedPrivateFiles(root: string): Promise<string[]> {
	const probe = await runGit(root, ["rev-parse", "--is-inside-work-tree"], { timeoutMs: 5_000 });
	if (probe.code !== 0) return [];
	const out = await runGit(root, ["ls-files", "-z", "--", ".orch"], { timeoutMs: 15_000 });
	if (out.code !== 0) return [];
	const tracked: string[] = [];
	for (const p of out.stdout.split("\0")) {
		if (p && classifyProjectPath(p) === "private") tracked.push(p);
	}
	return tracked.sort();
}

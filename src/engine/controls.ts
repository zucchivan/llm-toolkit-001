/**
 * Immutable, conservative path controls for task-tree projection/admission.
 * Patterns are matched in-process (literal file, trailing-slash directory
 * prefix, `*` within one component, `**` across components); no shell ever
 * receives a target or deny glob.
 */
import { resolve } from "node:path";
import { classifyProjectPath } from "../hygiene.ts";

export type TaskControlsInput = {
	root: string;
	targetPaths: readonly string[];
	/** Additional operator/host deny patterns; they always override targets. */
	deniedPaths?: readonly string[];
	/** Additional protected read-only paths (e.g. the configured PRD). */
	readOnlyPaths?: readonly string[];
};

export type TaskControls = Readonly<{
	root: string;
	targetPaths: readonly string[];
	deniedPaths: readonly string[];
	readOnlyPaths: readonly string[];
}>;

const SECRET_NAMES = new Set([".npmrc", ".netrc", ".pypirc"]);
const RESERVED_EXACT = new Set(["router.md", ".git", ".orch"]);
const DEFAULT_READ_ONLY_PATHS = [
	"evals/", "PROMPT.md", ".gitignore", ".gitattributes", ".gitmodules", ".gitconfig",
	".gitlab-ci.yml", ".github/workflows/",
];

/** Validate a project-relative path or target pattern without normalizing away evidence. */
export function validateProjectPath(path: string, { pattern = false }: { pattern?: boolean } = {}): string {
	if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
		throw new Error(`invalid project-relative path: ${JSON.stringify(path)}`);
	}
	const trailingSlash = path.endsWith("/");
	const body = trailingSlash ? path.slice(0, -1) : path;
	const segments = body.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || /[\x00-\x1f:]/.test(segment) || /[ .]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment))) {
		throw new Error(`invalid project-relative path component in ${JSON.stringify(path)}`);
	}
	if (!pattern && /[*?\[\]]/.test(path)) throw new Error(`wildcard is not valid in a materialized path: ${JSON.stringify(path)}`);
	if (pattern && /[?\[\]]/.test(path)) throw new Error(`only * and ** are supported in target paths: ${JSON.stringify(path)}`);
	return path;
}

/** Create a validated immutable bundle; empty targetPaths means all admissible project paths. */
export function createTaskControls(input: TaskControlsInput): TaskControls {
	if (!input.root || !Array.isArray(input.targetPaths) || !input.targetPaths.every((p) => typeof p === "string") ||
		(input.deniedPaths !== undefined && (!Array.isArray(input.deniedPaths) || !input.deniedPaths.every((p) => typeof p === "string"))) ||
		(input.readOnlyPaths !== undefined && (!Array.isArray(input.readOnlyPaths) || !input.readOnlyPaths.every((p) => typeof p === "string")))) {
		throw new Error("task controls require a root and string target, deny, and read-only path arrays");
	}
	if (input.targetPaths.length > 1000 || (input.deniedPaths?.length ?? 0) > 1000 || (input.readOnlyPaths?.length ?? 0) > 1000) {
		throw new Error("task controls contain too many path patterns; nothing was omitted");
	}
	const targets = input.targetPaths.map((path) => validateProjectPath(path, { pattern: true }));
	const denied = (input.deniedPaths ?? []).map((path) => validateProjectPath(path, { pattern: true }));
	const readOnly = [...DEFAULT_READ_ONLY_PATHS, ...(input.readOnlyPaths ?? [])].map((path) => validateProjectPath(path, { pattern: true }));
	return Object.freeze({
		root: resolve(input.root),
		targetPaths: Object.freeze([...targets]),
		deniedPaths: Object.freeze([...denied]),
		readOnlyPaths: Object.freeze([...readOnly]),
	});
}

/** One matcher shared by projection and candidate admission. */
export function matchesPath(path: string, pattern: string): boolean {
	const rel = validateProjectPath(path);
	const spec = validateProjectPath(pattern, { pattern: true });
	if (spec.endsWith("/")) return rel.startsWith(spec);
	const memo = new Map<string, boolean>();
	const match = (patternAt: number, pathAt: number): boolean => {
		const key = `${patternAt}:${pathAt}`;
		const cached = memo.get(key);
		if (cached !== undefined) return cached;
		let result: boolean;
		if (patternAt === spec.length) result = pathAt === rel.length;
		else if (spec[patternAt] !== "*") result = spec[patternAt] === rel[pathAt] && match(patternAt + 1, pathAt + 1);
		else if (spec[patternAt + 1] === "*") {
			const afterStars = patternAt + 2;
			if (spec[afterStars] === "/") {
				result = match(afterStars + 1, pathAt);
				for (let i = pathAt; !result && i < rel.length; i++) {
					if (rel[i] === "/") result = match(afterStars + 1, i + 1);
				}
			} else {
				result = match(afterStars, pathAt);
				if (!result && pathAt < rel.length) result = match(patternAt, pathAt + 1);
			}
		} else {
			result = match(patternAt + 1, pathAt);
			if (!result && pathAt < rel.length && rel[pathAt] !== "/") result = match(patternAt, pathAt + 1);
		}
		memo.set(key, result);
		return result;
	};
	return match(0, 0);
}

function hasReservedComponent(path: string): boolean {
	const normalized = validateProjectPath(path);
	if (RESERVED_EXACT.has(normalized.toLowerCase())) return true;
	const segments = normalized.split("/").map((part) => part.toLowerCase());
	if (segments.some((part) => part === ".git" || part === ".orch" || part === ".ssh" || part === ".aws")) return true;
	return segments.some((part) => SECRET_NAMES.has(part) || part === ".env" || part.startsWith(".env.") || part.endsWith(".pem") || part.endsWith(".key"));
}

/** Denies and reserved ownership classes override even an empty allowlist. */
export function isDeniedPath(path: string, controls: TaskControls): boolean {
	const rel = validateProjectPath(path);
	// `classifyProjectPath` is the shared ADR-04 ownership classifier. The
	// explicit reserved-path checks additionally protect reviewable .orch
	// controls from task writes; none are silently filtered from a candidate.
	const ownership = classifyProjectPath(rel);
	if (ownership === "private" || ownership === "optional-trail" || hasReservedComponent(rel)) return true;
	return controls.deniedPaths.some((pattern) => matchesPath(rel, pattern));
}

export function isReadOnlyPath(path: string, controls: TaskControls): boolean {
	const rel = validateProjectPath(path).toLowerCase();
	return controls.readOnlyPaths.some((pattern) => matchesPath(rel, pattern.toLowerCase()));
}

export function isTargetPath(path: string, controls: TaskControls): boolean {
	const rel = validateProjectPath(path);
	if (isDeniedPath(rel, controls) || isReadOnlyPath(rel, controls)) return false;
	return controls.targetPaths.length === 0 || controls.targetPaths.some((pattern) => matchesPath(rel, pattern));
}

/** Fail closed for malformed, denied, or out-of-scope candidate paths. */
export function assertAdmissiblePath(path: string, controls: TaskControls): void {
	const rel = validateProjectPath(path);
	if (isDeniedPath(rel, controls)) throw new Error(`reserved or denied task-tree path: ${JSON.stringify(rel)}`);
	if (isReadOnlyPath(rel, controls)) throw new Error(`read-only task-tree path: ${JSON.stringify(rel)}`);
	if (controls.targetPaths.length > 0 && !controls.targetPaths.some((pattern) => matchesPath(rel, pattern))) {
		throw new Error(`task-tree path ${JSON.stringify(rel)} is outside targetPaths [${controls.targetPaths.join(", ")}]`);
	}
}

/** True when a path is deliberately not projected to a worker/read view. */
export function shouldProjectPath(path: string, controls: TaskControls): boolean {
	return !isDeniedPath(path, controls);
}

/**
 * Operator-owned host policy (§2/§3).
 *
 * Two views share one file-trust implementation:
 *  - `readApprovedDeliveryOrigin` is the narrow M0 delivery-only view: it
 *    reads exactly `projects[].deliveryOrigin` and intentionally tolerates a
 *    project entry that predates the M1 sandbox fields, so M0 PR publication
 *    keeps its exact guarantees until a later P01 step cuts over.
 *  - `readHostProfile` is the strict M1 view: version 1, known keys only,
 *    canonical paths, exact backend/toolchain references and the documented
 *    public-env positive list. Sandbox admission consumes this view only.
 *
 * Project config, project env, target cwd and PATH can never supply or
 * override these values. Installation overrides are validated here (shape,
 * ancestry, ownership, exclusion from the target) before any launch.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, resolve, win32 } from "node:path";
import {
	BACKENDS,
	INSTALL_TOOLS,
} from "./types.ts";
import type {
	Backend,
	HostProfile,
	HostProjectEntry,
	HostToolchain,
	InstallTool,
	InstallationPaths,
} from "./types.ts";

export type ApprovedGitHubOrigin = { origin: string; repository: string };

export type HostProfileErrorCode =
	| "not-found"
	| "unsafe-file"
	| "unsafe-permissions"
	| "invalid-json"
	| "invalid-schema"
	| "unsafe-path"
	| "installation-inside-target";

export class HostProfileError extends Error {
	readonly code: HostProfileErrorCode;
	constructor(code: HostProfileErrorCode, message: string) {
		super(message);
		this.name = "HostProfileError";
		this.code = code;
	}
}

export function defaultHostProfilePath(): string {
	if (process.platform === "win32") {
		const local = process.env["LOCALAPPDATA"];
		if (!local) throw new Error("LOCALAPPDATA is unset; cannot locate the operator host profile");
		return win32.join(local, "llm-toolkit-001", "host-v1.json");
	}
	return posix.join(homedir(), ".config", "llm-toolkit-001", "host-v1.json");
}

/** Accept only a plain HTTPS GitHub repository URL and return its canonical form. */
export function parseApprovedGitHubOrigin(value: unknown): ApprovedGitHubOrigin {
	if (typeof value !== "string" || value.length > 512) throw new Error("approved deliveryOrigin is missing or invalid");
	let url: URL;
	try { url = new URL(value); }
	catch { throw new Error("deliveryOrigin must be a canonical HTTPS GitHub repository URL"); }
	if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) {
		throw new Error("deliveryOrigin must be an HTTPS github.com repository URL without credentials, port, query, or fragment");
	}
	const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
	if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
		throw new Error("deliveryOrigin must name exactly one GitHub owner/repository");
	}
	const owner = match[1]!;
	const repository = match[2]!;
	return { origin: `https://github.com/${owner}/${repository}.git`, repository: `${owner}/${repository}` };
}

// ---------------------------------------------------------------------------
// Canonical path decisions (pure)
// ---------------------------------------------------------------------------

function pathApi(platform: NodeJS.Platform) {
	return platform === "win32" ? win32 : posix;
}

/**
 * A trusted path is absolute, normalized, NUL-free and (on Windows) local —
 * never a UNC/device path. Rejecting non-canonical input is deliberate: the
 * policy never silently rewrites an operator-provided path.
 */
export function assertCanonicalAbsolutePath(value: unknown, what: string, platform: NodeJS.Platform = process.platform): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
		throw new HostProfileError("unsafe-path", `${what} must be a non-empty absolute path (at most 4096 characters)`);
	}
	if (value.includes("\0")) throw new HostProfileError("unsafe-path", `${what} must not contain a NUL byte`);
	const api = pathApi(platform);
	if (!api.isAbsolute(value)) throw new HostProfileError("unsafe-path", `${what} must be absolute: ${JSON.stringify(value)}`);
	if (platform === "win32" && (value.startsWith("\\\\") || value.startsWith("//"))) {
		throw new HostProfileError("unsafe-path", `${what} must be a local drive path, not a UNC/device path: ${JSON.stringify(value)}`);
	}
	const root = api.parse(value).root;
	if (value !== root && value.endsWith(api.sep)) {
		throw new HostProfileError("unsafe-path", `${what} must not end with a path separator: ${JSON.stringify(value)}`);
	}
	if (api.normalize(value) !== value) {
		throw new HostProfileError("unsafe-path", `${what} must be normalized (no "." or ".." segments, duplicate separators, or mixed separators): ${JSON.stringify(value)}`);
	}
	return value;
}

function foldPath(value: string, platform: NodeJS.Platform): string {
	return platform === "win32" ? value.toLowerCase() : value;
}

/** True when `candidate` is the target root or lives inside it. */
export function isInsideOrEqual(targetRoot: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
	const api = pathApi(platform);
	const root = foldPath(targetRoot, platform);
	const path = foldPath(candidate, platform);
	if (path === root) return true;
	const prefix = root.endsWith(api.sep) ? root : root + api.sep;
	return path.startsWith(prefix);
}

/**
 * Resolve the operator-selected project root ONCE at the boundary.
 *
 * Every later host read is root-relative and no-follow (`src/util/safe-read.ts`),
 * so no caller re-resolves a path from a project value or follows a project
 * symlink after this point. The canonical result is what exact-root enrollment
 * compares against, so an alias for the same directory keeps one grant.
 */
export async function resolveCanonicalProjectRoot(input: string): Promise<string> {
	const requested = assertCanonicalAbsolutePath(input, "project root");
	let actual: string;
	try {
		actual = await realpath(requested);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new HostProfileError("not-found", `project root does not exist: ${requested}`);
		}
		throw new HostProfileError("unsafe-path", `cannot canonicalize project root ${requested}: ${(error as Error).message}`);
	}
	return assertCanonicalAbsolutePath(actual, "canonical project root");
}

export interface InstallationPathOptions {
	targetRoot: string;
	platform?: NodeJS.Platform;
}

/**
 * Validate one trusted installation path against the current target. A binary
 * inside the checkout (including `node_modules/.bin`) is never trusted, even
 * when the operator names it in the host policy.
 */
export function validateInstallationPath(value: string, options: InstallationPathOptions): string {
	const platform = options.platform ?? process.platform;
	const path = assertCanonicalAbsolutePath(value, "installation path", platform);
	const target = assertCanonicalAbsolutePath(options.targetRoot, "target root", platform);
	if (isInsideOrEqual(target, path, platform)) {
		throw new HostProfileError(
			"installation-inside-target",
			`trusted installation path ${path} is inside the target checkout ${target}; trusted binaries must live outside the project`,
		);
	}
	return path;
}

// ---------------------------------------------------------------------------
// Strict schema
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS = new Set(["version", "installation", "projects", "toolchains"]);
const INSTALL_KEYS = new Set<string>(INSTALL_TOOLS);
const PROJECT_KEYS = new Set([
	"root", "backends", "toolchainId", "publicValues", "remoteProject", "deliveryOrigin", "otlpLoopback",
]);
const TOOLCHAIN_KEYS = new Set(["rootfs", "manifestSha256", "gondolinImage", "daytonaSnapshot", "deps"]);
const PUBLIC_ENV_KEY = /^PROJECT_PUBLIC_[A-Z0-9_]+$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_PUBLIC_VALUES = 16;
const MAX_PUBLIC_VALUE_BYTES = 128;

function invalid(message: string): never {
	throw new HostProfileError("invalid-schema", message);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${what} must be a JSON object`);
	return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) invalid(`unknown ${label} ${JSON.stringify(key)}`);
	}
}

function requiredString(value: unknown, what: string): string {
	if (typeof value !== "string" || value.length === 0) invalid(`${what} must be a non-empty string`);
	return value;
}

function safeId(value: unknown, what: string): string {
	const text = requiredString(value, what);
	if (!SAFE_ID.test(text)) invalid(`${what} must be a short identifier (letters, digits, ".", "_", ":", "-")`);
	return text;
}

function parsePublicValues(value: unknown): Record<string, string> {
	const record = asRecord(value, "project publicValues");
	const names = Object.keys(record);
	if (names.length > MAX_PUBLIC_VALUES) invalid(`project publicValues may grant at most ${MAX_PUBLIC_VALUES} names`);
	const out: Record<string, string> = {};
	for (const name of names) {
		if (name.length > 128 || !PUBLIC_ENV_KEY.test(name)) {
			invalid(`project publicValues name ${JSON.stringify(name)} must match PROJECT_PUBLIC_[A-Z0-9_]+`);
		}
		const literal = record[name];
		if (typeof literal !== "string") invalid(`project publicValues.${name} must be a string literal`);
		if (Buffer.byteLength(literal, "utf8") > MAX_PUBLIC_VALUE_BYTES) {
			invalid(`project publicValues.${name} exceeds ${MAX_PUBLIC_VALUE_BYTES} UTF-8 bytes`);
		}
		if (literal.length === 0 || literal !== literal.trim()) {
			invalid(`project publicValues.${name} must be a non-empty, unpadded public literal`);
		}
		for (const char of literal) {
			const code = char.codePointAt(0)!;
			if (code < 0x20 || code === 0x7f) invalid(`project publicValues.${name} must not contain control characters`);
		}
		out[name] = literal;
	}
	return out;
}

function parseBackends(value: unknown): Backend[] {
	if (!Array.isArray(value) || value.length === 0) invalid("project backends must be a non-empty array");
	const seen = new Set<string>();
	const out: Backend[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !(BACKENDS as readonly string[]).includes(item)) {
			invalid(`project backend ${JSON.stringify(item)} must be one of ${BACKENDS.join(" | ")}`);
		}
		if (seen.has(item)) invalid(`project backend ${JSON.stringify(item)} is listed twice`);
		seen.add(item);
		out.push(item as Backend);
	}
	return out;
}

function parseProject(value: unknown, platform: NodeJS.Platform): HostProjectEntry {
	const record = asRecord(value, "project entry");
	onlyKeys(record, PROJECT_KEYS, "project key");
	const root = assertCanonicalAbsolutePath(record["root"], "project root", platform);
	const backends = parseBackends(record["backends"]);
	const toolchainId = safeId(record["toolchainId"], "project toolchainId");
	const publicValues = parsePublicValues(record["publicValues"]);
	const remoteProject = record["remoteProject"] === undefined ? undefined : safeId(record["remoteProject"], "project remoteProject");
	let deliveryOrigin: string | undefined;
	if (record["deliveryOrigin"] !== undefined) {
		try {
			deliveryOrigin = parseApprovedGitHubOrigin(record["deliveryOrigin"]).origin;
		} catch (error) {
			throw new HostProfileError("invalid-schema", `project deliveryOrigin: ${(error as Error).message}`);
		}
	}
	if (record["otlpLoopback"] !== undefined && typeof record["otlpLoopback"] !== "boolean") {
		invalid("project otlpLoopback must be true or false");
	}
	const entry: HostProjectEntry = { root, backends, toolchainId, publicValues };
	if (remoteProject !== undefined) entry.remoteProject = remoteProject;
	if (deliveryOrigin !== undefined) entry.deliveryOrigin = deliveryOrigin;
	if (record["otlpLoopback"] !== undefined) entry.otlpLoopback = record["otlpLoopback"] as boolean;
	return entry;
}

function parseToolchain(value: unknown, platform: NodeJS.Platform): HostToolchain {
	const record = asRecord(value, "toolchain entry");
	onlyKeys(record, TOOLCHAIN_KEYS, "toolchain key");
	const manifestSha256 = requiredString(record["manifestSha256"], "toolchain manifestSha256");
	if (!SHA256.test(manifestSha256)) invalid("toolchain manifestSha256 must be a full lowercase SHA-256 digest");
	const rootfs = record["rootfs"] === undefined ? undefined : assertCanonicalAbsolutePath(record["rootfs"], "toolchain rootfs", platform);
	const gondolinImage = record["gondolinImage"] === undefined
		? undefined
		: assertCanonicalAbsolutePath(record["gondolinImage"], "toolchain gondolinImage", platform);
	const deps = record["deps"] === undefined ? undefined : assertCanonicalAbsolutePath(record["deps"], "toolchain deps", platform);
	const daytonaSnapshot = record["daytonaSnapshot"] === undefined
		? undefined
		: requiredString(record["daytonaSnapshot"], "toolchain daytonaSnapshot");
	if (daytonaSnapshot !== undefined && !SNAPSHOT_ID.test(daytonaSnapshot)) {
		invalid("toolchain daytonaSnapshot must be a short snapshot identifier");
	}
	const toolchain: HostToolchain = { manifestSha256 };
	if (rootfs !== undefined) toolchain.rootfs = rootfs;
	if (gondolinImage !== undefined) toolchain.gondolinImage = gondolinImage;
	if (daytonaSnapshot !== undefined) toolchain.daytonaSnapshot = daytonaSnapshot;
	if (deps !== undefined) toolchain.deps = deps;
	return toolchain;
}

export interface ParseHostProfileOptions {
	platform?: NodeJS.Platform;
}

/** Strict, pure version-1 host policy parser. Unknown keys are errors. */
export function parseHostProfile(value: unknown, options: ParseHostProfileOptions = {}): HostProfile {
	const platform = options.platform ?? process.platform;
	const record = asRecord(value, "operator host profile");
	onlyKeys(record, TOP_LEVEL_KEYS, "top-level key");
	if (record["version"] !== 1) invalid("operator host profile must use version 1");
	if (!Array.isArray(record["projects"])) invalid("operator host profile must have a projects array");
	if (!record["toolchains"] || typeof record["toolchains"] !== "object" || Array.isArray(record["toolchains"])) {
		invalid("operator host profile must have a toolchains object");
	}

	let installation: InstallationPaths | undefined;
	if (record["installation"] !== undefined) {
		const installRecord = asRecord(record["installation"], "installation");
		onlyKeys(installRecord, INSTALL_KEYS, "installation key");
		installation = {};
		for (const tool of INSTALL_TOOLS) {
			const path = installRecord[tool];
			if (path === undefined) continue;
			installation[tool] = assertCanonicalAbsolutePath(path, `installation.${tool}`, platform);
		}
	}

	const projects = record["projects"].map((entry) => parseProject(entry, platform));
	const seenRoots = new Set<string>();
	for (const project of projects) {
		const folded = foldPath(project.root, platform);
		if (seenRoots.has(folded)) invalid(`duplicate project root ${JSON.stringify(project.root)}`);
		seenRoots.add(folded);
	}

	const toolchains: Record<string, HostToolchain> = {};
	for (const [id, entry] of Object.entries(record["toolchains"] as Record<string, unknown>)) {
		safeId(id, "toolchain id");
		toolchains[id] = parseToolchain(entry, platform);
	}
	for (const project of projects) {
		if (!Object.hasOwn(toolchains, project.toolchainId)) {
			invalid(`project ${project.root} references unknown toolchain ${JSON.stringify(project.toolchainId)}`);
		}
	}

	const profile: HostProfile = { version: 1, projects, toolchains };
	if (installation !== undefined) profile.installation = installation;
	return profile;
}

// ---------------------------------------------------------------------------
// File trust
// ---------------------------------------------------------------------------

const MAX_PROFILE_BYTES = 1024 * 1024;

async function readOperatorProfileText(profilePath: string): Promise<{ file: string; text: string }> {
	const file = resolve(profilePath);
	let info;
	try {
		info = await lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new HostProfileError("not-found", `operator host profile not found at ${file}`);
		}
		throw new HostProfileError("unsafe-file", `cannot inspect operator host profile ${file}: ${(error as Error).message}`);
	}
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new HostProfileError("unsafe-file", "operator host profile must be a regular, non-symlink file");
	}
	if (info.size > MAX_PROFILE_BYTES) {
		throw new HostProfileError("unsafe-file", "operator host profile exceeds the 1 MiB read limit");
	}
	if (process.platform !== "win32") {
		if ((info.mode & 0o077) !== 0) {
			throw new HostProfileError("unsafe-permissions", "operator host profile permissions are too broad; chmod it to 600");
		}
		if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
			throw new HostProfileError("unsafe-permissions", "operator host profile is not owned by the current user");
		}
	}
	// Reject a symlinked path component so the configured user-owned location
	// cannot be redirected through a project-controlled alias.
	const actual = await realpath(file).catch((error: Error) => {
		throw new HostProfileError("unsafe-file", `cannot canonicalize operator host profile ${file}: ${error.message}`);
	});
	if (actual !== file) {
		throw new HostProfileError("unsafe-file", "operator host profile path must not traverse a symlink");
	}
	const text = await readFile(file, "utf8").catch((error: Error) => {
		throw new HostProfileError("unsafe-file", `cannot read operator host profile ${file}: ${error.message}`);
	});
	return { file, text };
}

function parseProfileJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new HostProfileError("invalid-json", "operator host profile is not valid JSON");
	}
}

/** Strict M1 read. Used by sandbox admission, never by the narrow M0 PR path. */
export async function readHostProfile(
	profilePath = defaultHostProfilePath(),
	options: ParseHostProfileOptions = {},
): Promise<HostProfile> {
	const { text } = await readOperatorProfileText(profilePath);
	return parseHostProfile(parseProfileJson(text), options);
}

/**
 * Narrow M0 delivery-only view: exact-root project entry → validated
 * deliveryOrigin. This intentionally accepts an entry without the M1 sandbox
 * fields; it grants nothing except the PR destination.
 */
export async function readApprovedDeliveryOrigin(
	projectRoot: string,
	profilePath = defaultHostProfilePath(),
): Promise<ApprovedGitHubOrigin> {
	const canonicalRoot = await realpath(projectRoot);
	const { text } = await readOperatorProfileText(profilePath);
	const parsed = parseProfileJson(text);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new HostProfileError("invalid-schema", "operator host profile must be a JSON object");
	}
	const root = parsed as Record<string, unknown>;
	if (root["version"] !== 1 || !Array.isArray(root["projects"])) {
		throw new HostProfileError("invalid-schema", "operator host profile must use version 1 and a projects array");
	}
	const matches = root["projects"].filter((entry): entry is Record<string, unknown> =>
		!!entry && typeof entry === "object" && !Array.isArray(entry) && entry["root"] === canonicalRoot,
	);
	if (matches.length !== 1) {
		throw new HostProfileError("invalid-schema", `host profile needs exactly one project entry for ${canonicalRoot}`);
	}
	const approved = matches[0]!["deliveryOrigin"];
	if (typeof approved !== "string") {
		throw new HostProfileError("invalid-schema", "host profile project entry has no approved deliveryOrigin");
	}
	return parseApprovedGitHubOrigin(approved);
}

// ---------------------------------------------------------------------------
// Trusted installation validation (filesystem)
// ---------------------------------------------------------------------------

export interface ValidateInstallationOptions {
	targetRoot: string;
	platform?: NodeJS.Platform;
	uid?: number;
}

/**
 * Validate every configured installation override before first use:
 * outside the target, canonical ancestry (no symlink component), regular
 * non-symlink file, not group/world writable, owned by the current user or
 * root on POSIX. Missing paths are errors, never silent fallbacks.
 */
export async function validateTrustedInstallation(
	profile: HostProfile,
	options: ValidateInstallationOptions,
): Promise<void> {
	const platform = options.platform ?? process.platform;
	const installation = profile.installation ?? {};
	for (const tool of INSTALL_TOOLS) {
		const configured = installation[tool];
		if (configured === undefined) continue;
		const safe = validateInstallationPath(configured, { targetRoot: options.targetRoot, platform });
		let info;
		try {
			info = await lstat(safe);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new HostProfileError("not-found", `trusted ${tool} executable not found at ${safe}`);
			}
			throw new HostProfileError("unsafe-file", `cannot inspect trusted ${tool} executable ${safe}: ${(error as Error).message}`);
		}
		if (info.isSymbolicLink()) {
			throw new HostProfileError("unsafe-path", `trusted ${tool} executable must not be a symlink: ${safe}`);
		}
		if (!info.isFile()) {
			throw new HostProfileError("unsafe-file", `trusted ${tool} executable must be a regular file: ${safe}`);
		}
		if (platform !== "win32") {
			if ((info.mode & 0o022) !== 0) {
				throw new HostProfileError("unsafe-file", `trusted ${tool} executable is group/world writable: ${safe}`);
			}
			const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : info.uid);
			if (info.uid !== uid && info.uid !== 0) {
				throw new HostProfileError("unsafe-file", `trusted ${tool} executable is not owned by the operator or root: ${safe}`);
			}
		}
		const actual = await realpath(safe).catch((error: Error) => {
			throw new HostProfileError("unsafe-file", `cannot canonicalize trusted ${tool} executable ${safe}: ${error.message}`);
		});
		if (actual !== safe) {
			throw new HostProfileError("unsafe-path", `trusted ${tool} executable path must not traverse a symlink: ${safe}`);
		}
	}
}

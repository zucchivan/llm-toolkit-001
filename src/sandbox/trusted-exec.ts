/**
 * M1-P01 step (e) — host-owned trusted installation resolver.
 *
 * One immutable descriptor names the selected executable for each host tool,
 * built from the operator host-profile `installation.*` overrides plus fixed
 * host defaults:
 *
 * - `node` is the running interpreter (`process.execPath`);
 * - `cli`/`ui` are the running operator-selected kit installation's own entries,
 *   derived from this module's resolved URL (never cwd, `argv[0]`, a target
 *   path or the presence of a kit copy in the target);
 * - on Linux, `git`/`gh` default to `/usr/bin/git` and `/usr/bin/gh`.
 *
 * There is no PATH search, target `node_modules/.bin`, cwd-relative candidate,
 * project config/env or `KIT_*` authority here, and no fallback: an override
 * that is selected but invalid refuses; it never tries another candidate.
 *
 * Selection is cheap and host-owned; the selected tool is resolved AND
 * validated per use (`requireTrustedTool`). Selecting an unused tool never
 * happens, so `delivery.mode=none` cannot require `gh` and a static command
 * cannot acquire a Git/UI/helper prerequisite.
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, posix, win32 } from "node:path";
import { execTrusted } from "../util/exec.ts";
import type { TrustedExecOutcome } from "../util/exec.ts";
import {
	HostProfileError,
	assertCanonicalAbsolutePath,
	defaultHostProfilePath,
	isInsideOrEqual,
	readInstallationOverrides,
	validateTrustedExecutableFile,
} from "./host-profile.ts";
import { isSameCanonicalPath, resolveTrustedExecutable } from "./policy.ts";
import { INSTALL_TOOLS } from "./types.ts";
import type {
	HostProfile,
	InstallTool,
	InstallationPaths,
	RunningInstallationIdentity,
	TrustedInstallationDescriptor,
	TrustedToolSelection,
	TrustedToolSource,
} from "./types.ts";

export type TrustedInstallationErrorCode =
	| "not-configured"
	| "unsupported-entry"
	| "unsafe-path"
	| "unsafe-file"
	| "unsafe-permissions"
	| "not-found"
	| "invalid-json"
	| "invalid-schema"
	| "installation-inside-target"
	| "running-installation-unknown"
	| "environment-invalid";

export class TrustedInstallationError extends Error {
	readonly code: TrustedInstallationErrorCode;
	readonly tool?: InstallTool;
	constructor(code: TrustedInstallationErrorCode, message: string, tool?: InstallTool) {
		super(message);
		this.name = "TrustedInstallationError";
		this.code = code;
		if (tool !== undefined) this.tool = tool;
	}
}

function pathApi(platform: NodeJS.Platform) {
	return platform === "win32" ? win32 : posix;
}

// ---------------------------------------------------------------------------
// Running installation identity (proven from the resolved module URL)
// ---------------------------------------------------------------------------

/**
 * Derive the running operator-selected installation from the resolved URL of
 * this module. The URL is the only provenance input: `src/sandbox/trusted-exec.ts`
 * proves a source checkout, `dist/sandbox/trusted-exec.js` a built install.
 */
export function runningInstallationFrom(moduleUrl: string, platform: NodeJS.Platform = process.platform): RunningInstallationIdentity {
	let url: URL;
	try {
		url = new URL(moduleUrl);
	} catch {
		throw new TrustedInstallationError("running-installation-unknown", "the running installation module URL is not a valid URL");
	}
	if (url.protocol !== "file:") {
		throw new TrustedInstallationError("running-installation-unknown", "the running installation module is not a local file URL");
	}
	url.search = "";
	url.hash = "";
	let modulePath: string;
	try {
		modulePath = fileURLToPath(url);
	} catch {
		throw new TrustedInstallationError("running-installation-unknown", "the running installation module URL is not a local file path");
	}
	const api = pathApi(platform);
	const sandboxDir = api.dirname(modulePath);
	const runtimeDir = api.dirname(sandboxDir);
	const root = api.dirname(runtimeDir);
	if (api.basename(sandboxDir) !== "sandbox") {
		throw new TrustedInstallationError("running-installation-unknown", `cannot prove the kit installation root from ${modulePath}`);
	}
	const runtimeName = api.basename(runtimeDir);
	const runtimeKind = runtimeName === "src" ? "source" : runtimeName === "dist" ? "built" : undefined;
	if (!runtimeKind) {
		throw new TrustedInstallationError("running-installation-unknown", `cannot prove the kit installation runtime from ${modulePath}`);
	}
	const uiEntry = api.join(root, "ui", "bin", "llm-toolkit-ui.js");
	const cliEntry = runtimeKind === "source" ? api.join(root, "src", "cli.ts") : api.join(root, "dist", "cli.js");
	const trustedEntries = Object.freeze([
		api.join(root, "src", "cli.ts"),
		api.join(root, "dist", "cli.js"),
		uiEntry,
	]);
	return Object.freeze({
		moduleUrl: url.href,
		root,
		runtimeKind,
		entries: Object.freeze({ cli: cliEntry, ui: uiEntry }),
		trustedEntries,
	});
}

/** The real running installation, or undefined when it cannot be proven. */
export function tryRunningInstallationIdentity(platform: NodeJS.Platform = process.platform): RunningInstallationIdentity | undefined {
	try {
		return runningInstallationFrom(import.meta.url, platform);
	} catch {
		return undefined;
	}
}

export function runningInstallationIdentity(platform: NodeJS.Platform = process.platform): RunningInstallationIdentity {
	return runningInstallationFrom(import.meta.url, platform);
}

// ---------------------------------------------------------------------------
// Descriptor selection (pure; no file validation, no target)
// ---------------------------------------------------------------------------

export interface InstallationSelectionInput {
	/** Operator host-profile overrides; absent means fixed defaults only. */
	installation?: InstallationPaths;
	/** Running installation; `null` disables the CLI/UI defaults, `undefined` derives it. */
	running?: RunningInstallationIdentity | null;
	/** The running interpreter path; defaults to `process.execPath`. */
	execPath?: string;
	platform?: NodeJS.Platform;
}

/**
 * Build the host-owned descriptor. Fixed defaults are platform rules, overrides
 * are the operator's explicit selection, and a tool with neither is omitted
 * (refused on use) — never filled from PATH, cwd, the target or project env.
 */
export function selectInstallation(input: InstallationSelectionInput = {}): TrustedInstallationDescriptor {
	const platform = input.platform ?? process.platform;
	const running = input.running === undefined ? tryRunningInstallationIdentity(platform) : input.running ?? undefined;
	const execPath = input.execPath ?? process.execPath;
	const defaults: Partial<Record<InstallTool, string>> = {};
	if (running) {
		defaults.cli = running.entries.cli;
		defaults.ui = running.entries.ui;
	}
	if (typeof execPath === "string" && execPath.length > 0) defaults.node = execPath;
	if (platform === "linux") {
		defaults.git = "/usr/bin/git";
		defaults.gh = "/usr/bin/gh";
	}
	const profile: HostProfile = { version: 1, projects: [], toolchains: {} };
	if (input.installation) profile.installation = input.installation;

	const tools: Partial<Record<InstallTool, TrustedToolSelection>> = {};
	for (const tool of INSTALL_TOOLS) {
		const resolved = resolveTrustedExecutable(profile, tool, { platform, trustedDefaults: defaults });
		if (!resolved.ok) {
			if (resolved.code === "installation-not-configured") continue;
			throw new TrustedInstallationError(
				resolved.code === "installation-inside-target" ? "installation-inside-target" : "unsafe-path",
				resolved.message,
				tool,
			);
		}
		const runningEntry = !!running
			&& (tool === "cli" || tool === "ui")
			&& running.trustedEntries.some((entry) => isSameCanonicalPath(entry, resolved.value.path, platform));
		let source: TrustedToolSource;
		if (resolved.value.source === "profile") source = "profile";
		else if (runningEntry) source = "running-installation";
		else source = "fixed-default";
		tools[tool] = Object.freeze({ path: resolved.value.path, source, runningEntry });
	}
	return Object.freeze({
		version: 1 as const,
		platform,
		...(running ? { runningInstallation: running } : {}),
		tools: Object.freeze(tools),
	});
}

export interface LoadTrustedInstallationOptions {
	/** Operator host profile path; the default is the platform host-policy path. */
	profilePath?: string;
	platform?: NodeJS.Platform;
	running?: RunningInstallationIdentity | null;
	execPath?: string;
}

/**
 * Read the operator's installation overrides and build the descriptor. An
 * absent profile means "no overrides"; an unsafe/malformed profile refuses
 * rather than silently dropping a selected override.
 */
export async function loadTrustedInstallation(options: LoadTrustedInstallationOptions = {}): Promise<TrustedInstallationDescriptor> {
	const installation = await readInstallationOverrides(
		options.profilePath ?? defaultHostProfilePath(),
		options.platform === undefined ? {} : { platform: options.platform },
	);
	return selectInstallation({ ...options, installation });
}

let injectedInstallation: TrustedInstallationDescriptor | undefined;
let cachedInstallation: Promise<TrustedInstallationDescriptor> | undefined;

/**
 * The process installation: an in-process injection from host/test code when
 * present, otherwise the operator profile plus fixed defaults (read once).
 * Injection is host authority, never a weaker validation mode.
 */
export async function currentTrustedInstallation(): Promise<TrustedInstallationDescriptor> {
	if (injectedInstallation) return injectedInstallation;
	cachedInstallation ??= loadTrustedInstallation();
	return await cachedInstallation;
}

/** In-process host-authority injection (tests). Does not bypass per-use validation. */
export function installTrustedInstallationForTests(descriptor: TrustedInstallationDescriptor | undefined): void {
	injectedInstallation = descriptor;
	cachedInstallation = undefined;
}

// ---------------------------------------------------------------------------
// Launch identity (step f): ONE descriptor/argv identity for job launch and
// attached-stop. Pure selection first; validation happens per use below.
// ---------------------------------------------------------------------------

/** How a trusted CLI/UI entry is started (one fixed literal argv prefix). */
export type TrustedLaunchForm = "built" | "source";

/**
 * The fixed literal argv prefix that launches one host entry, derived from the
 * descriptor only. `built` is `[node, dist/cli.js]`/`[node, ui/bin/…js]`;
 * `source` is the documented dev-in-kit `[node, ui tsx loader, src/cli.ts]`
 * form, which is only allowed for the running installation's OWN entry.
 */
export interface TrustedLaunchPrefix {
	readonly tool: "cli" | "ui";
	readonly form: TrustedLaunchForm;
	/** Absolute interpreter selected from the descriptor (`node`). */
	readonly node: string;
	/** Absolute selected entry (`cli`/`ui`). */
	readonly entry: string;
	/** Absolute tsx loader for the source form; absent for a built entry. */
	readonly loader?: string;
	/** Exactly `[node, ...(loader), entry]`. Never resolved through PATH/cwd. */
	readonly argv: readonly string[];
	readonly source: TrustedToolSource;
	/** The proven running installation root (recorded with every job identity). */
	readonly installationRoot: string;
}

export type TrustedLaunchSelection =
	| { ok: true; value: TrustedLaunchPrefix }
	| { ok: false; code: "not-configured" | "unsupported-entry"; message: string };

function isJavaScriptEntry(path: string): boolean {
	return /\.(c|m)?js$/i.test(path);
}

function isTypeScriptEntry(path: string): boolean {
	return /\.(c|m)?ts$/i.test(path);
}

/**
 * Select the launch prefix for the CLI or UI entry. This is pure: no PATH, cwd,
 * target, project config/env or `KIT_*` input exists, and no other candidate is
 * considered when the selected entry has no supported form.
 */
export function selectLaunchPrefix(descriptor: TrustedInstallationDescriptor, tool: "cli" | "ui"): TrustedLaunchSelection {
	const running = descriptor.runningInstallation;
	const node = descriptor.tools["node"];
	if (!node) {
		return {
			ok: false,
			code: "not-configured",
			message: "no trusted node interpreter is selected; set installation.node in the operator host profile or run from the trusted installation",
		};
	}
	const selected = descriptor.tools[tool];
	if (!selected) {
		return {
			ok: false,
			code: "not-configured",
			message: `no trusted installation for ${tool}; set installation.${tool} in the operator host profile or run from the trusted installation`,
		};
	}
	if (!running) {
		return {
			ok: false,
			code: "not-configured",
			message: `the running kit installation could not be proven from the loaded module, so a ${tool} launch cannot record its installation identity`,
		};
	}
	const api = pathApi(descriptor.platform);
	const entry = selected.path;
	if (isJavaScriptEntry(entry)) {
		return {
			ok: true,
			value: Object.freeze({
				tool,
				form: "built" as const,
				node: node.path,
				entry,
				argv: Object.freeze([node.path, entry]),
				source: selected.source,
				installationRoot: running.root,
			}),
		};
	}
	if (!isTypeScriptEntry(entry)) {
		return {
			ok: false,
			code: "unsupported-entry",
			message: `the selected ${tool} entry ${entry} is not a JavaScript or TypeScript entry, so there is no fixed argv form to launch it with`,
		};
	}
	// The documented dev-in-kit source form: the running installation's own entry
	// through the ui package's tsx loader. A `.ts` copy elsewhere is not launchable.
	const ownEntry = selected.runningEntry
		&& running.trustedEntries.some((candidate) => isSameCanonicalPath(candidate, entry, descriptor.platform));
	if (!ownEntry) {
		return {
			ok: false,
			code: "unsupported-entry",
			message: `the TypeScript ${tool} entry ${entry} is not the running installation's own entry; build the kit (npm run build) or select its built JavaScript entry`,
		};
	}
	const loader = api.join(running.root, "ui", "node_modules", "tsx", "dist", "cli.mjs");
	return {
		ok: true,
		value: Object.freeze({
			tool,
			form: "source" as const,
			node: node.path,
			entry,
			loader,
			argv: Object.freeze([node.path, loader, entry]),
			source: selected.source,
			installationRoot: running.root,
		}),
	};
}

/**
 * Resolve AND validate the one selected launch identity: interpreter, entry,
 * and (for the source form) the installation's own tsx loader. A missing or
 * invalid selected entry refuses; there is no fallback, no PATH lookup and no
 * alternate candidate.
 */
export async function requireLaunchPrefix(
	descriptor: TrustedInstallationDescriptor,
	tool: "cli" | "ui",
	options: TrustedToolUseOptions,
): Promise<TrustedLaunchPrefix> {
	const selected = selectLaunchPrefix(descriptor, tool);
	if (!selected.ok) throw new TrustedInstallationError(selected.code, selected.message, tool);
	const prefix = selected.value;
	const platform = options.platform ?? descriptor.platform;
	try {
		await requireTrustedTool(descriptor, "node", options);
		await requireTrustedTool(descriptor, tool, options);
		if (prefix.loader !== undefined) {
			// Installation-owned loader: the dev-in-kit exception is proven
			// structurally (it lives under the recorded installation root) and all
			// non-containment checks still apply.
			await validateTrustedExecutableFile(prefix.loader, `${tool} loader`, {
				targetRoot: options.targetRoot,
				platform,
				...(options.uid !== undefined ? { uid: options.uid } : {}),
				allowRunningInstallationEntry: true,
			});
		}
	} catch (error) {
		throw mapProfileError(error, tool);
	}
	return prefix;
}

/**
 * Canonical digest of the descriptor's SELECTED tool paths (identity for job
 * state, never authority). Recorded with each job so its launch provenance is
 * auditable without storing the descriptor or any environment value.
 */
export function installationDescriptorDigest(descriptor: TrustedInstallationDescriptor): string {
	const tools: Record<string, string | null> = {};
	for (const tool of INSTALL_TOOLS) tools[tool] = descriptor.tools[tool]?.path ?? null;
	const canonical = JSON.stringify({
		version: descriptor.version,
		platform: descriptor.platform,
		runningRoot: descriptor.runningInstallation?.root ?? null,
		tools,
	});
	return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Per-use selection + validation (the launch gate)
// ---------------------------------------------------------------------------

export interface TrustedToolUseOptions {
	/** Canonical project root used only for the outside-the-target decision. */
	targetRoot: string;
	uid?: number;
	platform?: NodeJS.Platform;
}

function mapProfileError(error: unknown, tool: InstallTool): TrustedInstallationError {
	if (error instanceof TrustedInstallationError) return error;
	if (error instanceof HostProfileError) {
		const code: TrustedInstallationErrorCode = error.code === "unsafe-permissions"
			? "unsafe-permissions"
			: error.code;
		return new TrustedInstallationError(code, error.message, tool);
	}
	return new TrustedInstallationError("unsafe-file", (error as Error).message, tool);
}

/**
 * Resolve AND validate one tool at the operation that uses it. The selected
 * path is the only candidate: a missing/invalid selection refuses and never
 * falls back to a default or a PATH lookup. The dev-in-kit exception applies
 * only when the selected path is one of the running installation's own entries
 * (structural equality recorded at selection).
 */
export async function requireTrustedTool(
	descriptor: TrustedInstallationDescriptor,
	tool: InstallTool,
	options: TrustedToolUseOptions,
): Promise<{ path: string; source: TrustedToolSource }> {
	const selected = descriptor.tools[tool];
	if (!selected) {
		throw new TrustedInstallationError(
			"not-configured",
			`no trusted installation for ${tool}; set installation.${tool} in the operator host profile or run from the trusted installation`,
			tool,
		);
	}
	const platform = options.platform ?? descriptor.platform;
	try {
		const target = assertCanonicalAbsolutePath(options.targetRoot, "target root", platform);
		const inside = isInsideOrEqual(target, selected.path, platform);
		const running = descriptor.runningInstallation;
		const runningEntry = !!running
			&& (tool === "cli" || tool === "ui")
			&& selected.runningEntry
			&& running.trustedEntries.some((entry) => isSameCanonicalPath(entry, selected.path, platform));
		if (inside && !runningEntry) {
			throw new TrustedInstallationError(
				"installation-inside-target",
				`trusted ${tool} executable ${selected.path} is inside the target checkout ${target}; trusted binaries must live outside the project`,
				tool,
			);
		}
		await validateTrustedExecutableFile(selected.path, tool, {
			targetRoot: options.targetRoot,
			platform,
			...(options.uid !== undefined ? { uid: options.uid } : {}),
			...(runningEntry ? { allowRunningInstallationEntry: true } : {}),
		});
	} catch (error) {
		throw mapProfileError(error, tool);
	}
	return { path: selected.path, source: selected.source };
}

// ---------------------------------------------------------------------------
// Host-built environments (no inherited process env)
// ---------------------------------------------------------------------------

const DEV_NULL = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * Fixed callback-free Git configuration. Hooks, the filesystem monitor,
 * attributes (global), external diff, signing helpers, protocol-ext transports,
 * proxies and credential helpers are disabled/cleared; the caller adds explicit
 * plumbing (`--no-filters`, `--no-ext-diff`, `--no-textconv`) where applicable.
 * Repository config is never given a way to run an executable for these calls.
 */
export function gitHardeningArgs(): readonly string[] {
	return [
		"-c", "core.hooksPath=/dev/null",
		"-c", "core.fsmonitor=false",
		"-c", "core.attributesFile=/dev/null",
		"-c", "core.autocrlf=false",
		"-c", "core.safecrlf=false",
		"-c", "core.fileMode=true",
		"-c", "commit.gpgsign=false",
		"-c", "tag.gpgsign=false",
		"-c", "credential.helper=",
		"-c", "diff.external=",
		"-c", "protocol.ext.allow=never",
		"-c", "http.proxy=",
		"-c", "https.proxy=",
		"-c", "core.pager=cat",
	];
}

/** Exactly the env overrides plumbing may add; everything else refuses. */
const GIT_OVERRIDE_KEYS = new Set([
	"GIT_INDEX_FILE",
	"GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE",
	"GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE",
]);

function hostHome(): string | undefined {
	const home = process.env["HOME"];
	return typeof home === "string" && isAbsolute(home) && !home.includes("\0") ? home : undefined;
}

/**
 * Host-built Git environment: no `process.env` spread, no inherited `GIT_*`,
 * `SSH_*`, proxy, `BASH_ENV` or `NODE_OPTIONS`. Only fixed host values plus the
 * few plumbing overrides in `GIT_OVERRIDE_KEYS` (index path and commit identity).
 */
export function buildGitEnvironment(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
	for (const key of Object.keys(overrides)) {
		if (!GIT_OVERRIDE_KEYS.has(key)) {
			throw new TrustedInstallationError("environment-invalid", `Git environment override ${JSON.stringify(key)} is not an allowed plumbing value`);
		}
		const value = overrides[key]!;
		if (typeof value !== "string" || value.includes("\0")) {
			throw new TrustedInstallationError("environment-invalid", `Git environment override ${JSON.stringify(key)} is invalid`);
		}
	}
	const home = hostHome();
	return {
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: DEV_NULL,
		GIT_CONFIG_SYSTEM: DEV_NULL,
		GIT_ATTR_NOSYSTEM: "1",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
		GIT_PAGER: "cat",
		PAGER: "cat",
		LC_ALL: "C",
		LANG: "C",
		TZ: "UTC",
		// Fixed system search path for Git's own subprocesses; it never selects
		// the Git/gh executable and contains no target/project entry.
		PATH: "/usr/bin:/bin",
		...(home ? { HOME: home } : {}),
		...overrides,
	};
}

/** Explicit, destination-pinned gh invocation environment. */
export interface GhEnvironmentInput {
	/** Host-resolved GitHub token (never from project config/env). */
	gitHubToken?: string;
}

function assertGitHubToken(token: string): void {
	if (token.length === 0 || /[\0\r\n]/.test(token)) {
		throw new TrustedInstallationError("environment-invalid", "a GitHub token must be a non-empty single-line value");
	}
}

export function buildGhEnvironment(input: GhEnvironmentInput = {}): Record<string, string> {
	if (input.gitHubToken !== undefined) assertGitHubToken(input.gitHubToken);
	const home = hostHome();
	return {
		GH_HOST: "github.com",
		GH_PROMPT_DISABLED: "1",
		GH_NO_UPDATE_NOTIFIER: "1",
		GH_PAGER: "cat",
		PAGER: "cat",
		NO_COLOR: "1",
		LC_ALL: "C",
		LANG: "C",
		TZ: "UTC",
		PATH: "/usr/bin:/bin",
		...(home ? { HOME: home } : {}),
		...(input.gitHubToken !== undefined ? { GH_TOKEN: input.gitHubToken } : {}),
	};
}

// ---------------------------------------------------------------------------
// Trusted spawn (resolver + literal argv + host-built env)
// ---------------------------------------------------------------------------

export interface TrustedToolRunOptions {
	targetRoot: string;
	timeoutMs: number;
	/** Allowed Git plumbing overrides only; refused for other tools. */
	env?: Readonly<Record<string, string>>;
	input?: Buffer | string;
	maxOutputBytes?: number;
	overflow?: "tail" | "head" | "refuse";
	/** Add the absolute resolved gh credential helper to a Git invocation. */
	credentialHelper?: boolean;
	/** Host-resolved GitHub token for `gh`. */
	gitHubToken?: string;
	signal?: AbortSignal;
	installation?: TrustedInstallationDescriptor;
	uid?: number;
}

function refusedOutcome(error: unknown): TrustedExecOutcome {
	const message = error instanceof Error ? error.message : String(error);
	return {
		code: null,
		stdout: "",
		stderr: `trusted installation refused: ${message}`,
		signaledBy: "trusted-installation",
		refused: "argv",
	};
}

/**
 * Resolve + validate the requested tool, then spawn EXACTLY the selected
 * absolute path with the host-built environment. A refusal happens before any
 * spawn and is reported as a failed outcome (no partial result, no fallback).
 */
export async function runTrustedTool(
	tool: InstallTool,
	args: readonly string[],
	options: TrustedToolRunOptions,
): Promise<TrustedExecOutcome> {
	let descriptor: TrustedInstallationDescriptor;
	let selected: { path: string; source: TrustedToolSource };
	try {
		descriptor = options.installation ?? await currentTrustedInstallation();
		selected = await requireTrustedTool(descriptor, tool, {
			targetRoot: options.targetRoot,
			...(options.uid !== undefined ? { uid: options.uid } : {}),
		});
	} catch (error) {
		return refusedOutcome(error);
	}
	const useOptions = {
		targetRoot: options.targetRoot,
		...(options.uid !== undefined ? { uid: options.uid } : {}),
	};
	try {
		if (tool === "git") {
			const prefix = [...gitHardeningArgs()];
			if (options.credentialHelper) {
				const gh = await requireTrustedTool(descriptor, "gh", useOptions);
				prefix.push("-c", `credential.helper=!${gh.path} auth git-credential`);
			}
			const env = buildGitEnvironment(options.env ?? {});
			if (options.credentialHelper) {
				// The helper is the resolved absolute gh; it receives only the
				// host-resolved token and the pinned destination host.
				env["GH_HOST"] = "github.com";
				env["GH_PROMPT_DISABLED"] = "1";
				if (options.gitHubToken !== undefined) {
					assertGitHubToken(options.gitHubToken);
					env["GH_TOKEN"] = options.gitHubToken;
				}
			}
			return await execTrusted([selected.path, ...prefix, ...args], {
				cwd: options.targetRoot,
				timeoutMs: options.timeoutMs,
				env,
				binary: true,
				...(options.input !== undefined ? { input: options.input } : {}),
				...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
				...(options.overflow !== undefined ? { overflow: options.overflow } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			});
		}
		if (tool === "gh") {
			if (options.env && Object.keys(options.env).length > 0) {
				throw new TrustedInstallationError("environment-invalid", "gh does not accept environment overrides");
			}
			const env = buildGhEnvironment({ ...(options.gitHubToken !== undefined ? { gitHubToken: options.gitHubToken } : {}) });
			return await execTrusted([selected.path, ...args], {
				cwd: options.targetRoot,
				timeoutMs: options.timeoutMs,
				env,
				...(options.input !== undefined ? { input: options.input } : {}),
				...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
				...(options.overflow !== undefined ? { overflow: options.overflow } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			});
		}
		throw new TrustedInstallationError("not-configured", `no trusted host runner exists for ${tool}`, tool);
	} catch (error) {
		return refusedOutcome(error);
	}
}

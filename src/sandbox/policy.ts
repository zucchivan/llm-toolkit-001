/**
 * M1-P01 pure host-policy decisions.
 *
 * Everything here is a pure function over the strict `HostProfile` plus the
 * current canonical target root. There is no PATH/cwd lookup, no `process.env`
 * spread, no filesystem read and no implicit tier fallback. CLI/UI wiring is a
 * separate internal step; callers must treat a refusal as final.
 */
import {
	assertCanonicalAbsolutePath,
	isInsideOrEqual,
	validateInstallationPath,
} from "./host-profile.ts";
import type { HostProfileError } from "./host-profile.ts";
import type {
	Backend,
	HostProfile,
	InstallTool,
	ProjectGrant,
	ResolvedToolchain,
} from "./types.ts";

export type PolicyDenialCode =
	| "target-path-unsafe"
	| "project-not-enrolled"
	| "project-duplicate"
	| "backend-not-allowed"
	| "remote-consent-required"
	| "remote-project-missing"
	| "toolchain-missing"
	| "toolchain-incomplete"
	| "public-env-name-invalid"
	| "public-env-reserved"
	| "public-env-not-granted"
	| "public-env-duplicate"
	| "public-env-too-many"
	| "installation-not-configured"
	| "installation-unsafe-path"
	| "installation-inside-target";

export type PolicyDenial = { ok: false; code: PolicyDenialCode; message: string };
export type PolicyResult<T> = { ok: true; value: T } | PolicyDenial;

function deny<T>(code: PolicyDenialCode, message: string): PolicyResult<T> {
	return { ok: false, code, message };
}

function fold(value: string, platform: NodeJS.Platform): string {
	return platform === "win32" ? value.toLowerCase() : value;
}

export interface PolicyOptions {
	platform?: NodeJS.Platform;
}

/**
 * Resolve the one exact-root project grant. With no entry, only a provisioned
 * `toolchains.default` may supply a local, no-extra-env, no-upload default —
 * never microvm/remote, never public env, never delivery.
 */
export function resolveProjectGrant(
	profile: HostProfile,
	canonicalRoot: string,
	options: PolicyOptions = {},
): PolicyResult<ProjectGrant> {
	const platform = options.platform ?? process.platform;
	let root: string;
	try {
		root = assertCanonicalAbsolutePath(canonicalRoot, "target root", platform);
	} catch (error) {
		return deny("target-path-unsafe", (error as Error).message);
	}
	const matches = profile.projects.filter((project) => fold(project.root, platform) === fold(root, platform));
	if (matches.length > 1) {
		return deny("project-duplicate", `host profile has ${matches.length} entries for ${root}; exactly one is allowed`);
	}
	const entry = matches[0];
	if (!entry) {
		if (!profile.toolchains["default"]) {
			return deny(
				"project-not-enrolled",
				`host profile has no project entry for ${root}; enroll the canonical root and its allowed backends`,
			);
		}
		return {
			ok: true,
			value: {
				root,
				backends: ["local"],
				toolchainId: "default",
				publicValues: {},
				implicitDefault: true,
			},
		};
	}
	const grant: ProjectGrant = {
		root: entry.root,
		backends: entry.backends,
		toolchainId: entry.toolchainId,
		publicValues: { ...entry.publicValues },
		implicitDefault: false,
	};
	if (entry.remoteProject !== undefined) grant.remoteProject = entry.remoteProject;
	if (entry.deliveryOrigin !== undefined) grant.deliveryOrigin = entry.deliveryOrigin;
	return { ok: true, value: grant };
}

/** Resolve the tier-specific immutable toolchain fields; missing tier data refuses. */
export function resolveToolchain(
	profile: HostProfile,
	grant: ProjectGrant,
	backend: Backend,
): PolicyResult<ResolvedToolchain> {
	const toolchain = profile.toolchains[grant.toolchainId];
	if (!toolchain) {
		return deny("toolchain-missing", `host profile has no toolchains entry named ${JSON.stringify(grant.toolchainId)}`);
	}
	const required: Record<Backend, "rootfs" | "gondolinImage" | "daytonaSnapshot"> = {
		local: "rootfs",
		microvm: "gondolinImage",
		remote: "daytonaSnapshot",
	};
	const field = required[backend];
	const value = toolchain[field];
	if (typeof value !== "string" || value.length === 0) {
		return deny(
			"toolchain-incomplete",
			`toolchain ${JSON.stringify(grant.toolchainId)} has no ${field} for the ${backend} backend`,
		);
	}
	const resolved: ResolvedToolchain = { id: grant.toolchainId, manifestSha256: toolchain.manifestSha256 };
	if (toolchain.rootfs !== undefined) resolved.rootfs = toolchain.rootfs;
	if (toolchain.gondolinImage !== undefined) resolved.gondolinImage = toolchain.gondolinImage;
	if (toolchain.daytonaSnapshot !== undefined) resolved.daytonaSnapshot = toolchain.daytonaSnapshot;
	if (toolchain.deps !== undefined) resolved.deps = toolchain.deps;
	return { ok: true, value: resolved };
}

export interface BackendAdmission {
	backend: Backend;
	grant: ProjectGrant;
	toolchain: ResolvedToolchain;
}

export interface AdmitBackendOptions extends PolicyOptions {
	backend: Backend;
	/** Per-invocation `--allow-remote` consent; approval alone is not consent. */
	remoteConsent?: boolean;
}

/**
 * Admit a backend against the exact-root grant. A refusal never falls back to
 * a different tier, and remote needs host allow + consent + an approved
 * remote project name.
 */
export function admitBackend(
	profile: HostProfile,
	grant: ProjectGrant,
	options: AdmitBackendOptions,
): PolicyResult<BackendAdmission> {
	const { backend } = options;
	if (!grant.backends.includes(backend)) {
		return deny(
			"backend-not-allowed",
			`host policy does not allow the ${backend} backend for ${grant.root}; allowed: ${grant.backends.join(", ") || "none"}`,
		);
	}
	if (backend === "remote") {
		if (options.remoteConsent !== true) {
			return deny(
				"remote-consent-required",
				"remote execution transfers project bytes; rerun with explicit --allow-remote consent on this invocation",
			);
		}
		if (!grant.remoteProject) {
			return deny("remote-project-missing", `host policy entry for ${grant.root} does not name an approved remoteProject`);
		}
	}
	const toolchain = resolveToolchain(profile, grant, backend);
	if (!toolchain.ok) return toolchain;
	return { ok: true, value: { backend, grant, toolchain: toolchain.value } };
}

// ---------------------------------------------------------------------------
// Guest environment projection
// ---------------------------------------------------------------------------

/** The fixed guest environment; never inherited from the host process. */
export const BASE_GUEST_ENV: Readonly<Record<string, string>> = Object.freeze({
	PATH: "/opt/kit/bin:/usr/bin:/bin",
	HOME: "/home/worker",
	TMPDIR: "/tmp",
	LANG: "C.UTF-8",
	TZ: "UTC",
	CI: "1",
});

const RESERVED_ENV = new Set([
	"PATH", "HOME", "TMPDIR", "LANG", "TZ", "CI", "NODE_OPTIONS", "BASH_ENV",
]);
const RESERVED_PREFIXES = ["KIT_", "PI_", "T3_", "LD_", "DYLD_", "GIT_", "SSH_", "OTEL_"];
const PUBLIC_ENV_KEY = /^PROJECT_PUBLIC_[A-Z0-9_]+$/;
const MAX_PUBLIC_VALUES = 16;

/** True for every host/runtime name that must never be project-grantable. */
export function isReservedEnvName(name: string): boolean {
	if (RESERVED_ENV.has(name)) return true;
	if (name.endsWith("_PROXY")) return true;
	return RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Return exactly the requested names that the host profile granted. Unknown,
 * reserved, duplicated, malformed or excess names refuse; nothing is echoed
 * from `process.env`.
 */
export function resolvePublicEnv(
	grant: ProjectGrant,
	requested: readonly string[],
): PolicyResult<Record<string, string>> {
	if (!Array.isArray(requested)) return deny("public-env-name-invalid", "publicEnv names must be an array");
	if (requested.length > MAX_PUBLIC_VALUES) {
		return deny("public-env-too-many", `at most ${MAX_PUBLIC_VALUES} publicEnv names may be requested`);
	}
	const seen = new Set<string>();
	const out: Record<string, string> = {};
	for (const name of requested) {
		if (typeof name !== "string" || name.length === 0 || name.length > 128) {
			return deny("public-env-name-invalid", `publicEnv name ${JSON.stringify(name)} is not a valid name`);
		}
		if (isReservedEnvName(name)) {
			return deny("public-env-reserved", `publicEnv name ${JSON.stringify(name)} is reserved for the trusted host`);
		}
		if (!PUBLIC_ENV_KEY.test(name)) {
			return deny("public-env-name-invalid", `publicEnv name ${JSON.stringify(name)} must match PROJECT_PUBLIC_[A-Z0-9_]+`);
		}
		if (seen.has(name)) return deny("public-env-duplicate", `publicEnv name ${JSON.stringify(name)} is requested twice`);
		seen.add(name);
		if (!Object.hasOwn(grant.publicValues, name)) {
			return deny(
				"public-env-not-granted",
				`host policy did not grant publicEnv name ${JSON.stringify(name)} for ${grant.root}`,
			);
		}
		out[name] = grant.publicValues[name]!;
	}
	return { ok: true, value: out };
}

/** Fixed guest env + exactly the granted public literals. */
export function projectEnvironment(
	grant: ProjectGrant,
	requested: readonly string[],
): PolicyResult<Record<string, string>> {
	const selected = resolvePublicEnv(grant, requested);
	if (!selected.ok) return selected;
	for (const name of Object.keys(selected.value)) {
		if (Object.hasOwn(BASE_GUEST_ENV, name)) {
			return deny("public-env-reserved", `publicEnv name ${JSON.stringify(name)} would shadow a fixed guest variable`);
		}
	}
	return { ok: true, value: { ...BASE_GUEST_ENV, ...selected.value } };
}

// ---------------------------------------------------------------------------
// Trusted executable resolution
// ---------------------------------------------------------------------------

export interface TrustedExecutableOptions extends PolicyOptions {
	targetRoot: string;
	/**
	 * Paths supplied by the already-running trusted installation (for example
	 * `process.execPath` for Node). The policy never derives these from PATH,
	 * cwd, the target or project env.
	 */
	trustedDefaults?: Partial<Record<InstallTool, string>>;
}

export interface TrustedExecutable {
	path: string;
	source: "profile" | "trusted-installation";
}

/**
 * Resolve one host executable without consulting the target. A profile
 * override wins; otherwise only an explicit trusted-installation default is
 * considered. No candidate means refusal, not a PATH search.
 */
export function resolveTrustedExecutable(
	profile: HostProfile,
	tool: InstallTool,
	options: TrustedExecutableOptions,
): PolicyResult<TrustedExecutable> {
	const configured = profile.installation?.[tool];
	const candidate = configured ?? options.trustedDefaults?.[tool];
	if (candidate === undefined) {
		return deny(
			"installation-not-configured",
			`no trusted installation for ${tool}; set installation.${tool} in the operator host profile or run from the trusted installation`,
		);
	}
	const platform = options.platform ?? process.platform;
	let path: string;
	try {
		path = validateInstallationPath(candidate, { targetRoot: options.targetRoot, platform });
	} catch (error) {
		const profileError = error as HostProfileError;
		if (profileError.code === "installation-inside-target") {
			return deny("installation-inside-target", profileError.message);
		}
		return deny("installation-unsafe-path", (error as Error).message);
	}
	return { ok: true, value: { path, source: configured !== undefined ? "profile" : "trusted-installation" } };
}

/** Small helper for wiring steps: path equality under one platform's folding. */
export function isSameCanonicalPath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
	return fold(a, platform) === fold(b, platform);
}

/** Re-exported so callers can keep the containment check beside admission. */
export { isInsideOrEqual };

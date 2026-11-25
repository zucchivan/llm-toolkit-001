/**
 * M1 host-owned types shared by the strict host-profile reader and the pure
 * lease policy. These are binding shapes from engineering-plan README §3;
 * they are not sandbox runtime types (those arrive with the guest transport
 * and lease lifecycle packets).
 */

export type Backend = "local" | "microvm" | "remote";
export const BACKENDS: readonly Backend[] = ["local", "microvm", "remote"];

/** Host executables that must resolve from the operator-selected installation. */
export const INSTALL_TOOLS = ["cli", "ui", "node", "git", "gh", "helper", "bwrap"] as const;
export type InstallTool = (typeof INSTALL_TOOLS)[number];

export type Purpose = "plan" | "implement" | "verify" | "gate" | "probe";

/**
 * Optional absolute overrides. They live only in the operator host policy;
 * project config, project env, target cwd and PATH can never supply them.
 */
export interface InstallationPaths {
	cli?: string;
	ui?: string;
	node?: string;
	git?: string;
	gh?: string;
	helper?: string;
	bwrap?: string;
}

/** Where one selected host tool came from (never a PATH/cwd lookup). */
export type TrustedToolSource = "profile" | "fixed-default" | "running-installation";

/**
 * The running operator-selected kit installation, proven from the resolved
 * module URL of `src/sandbox/trusted-exec.ts` — never from cwd, `argv[0]`, a
 * target path or the presence of a kit copy in the target.
 */
export interface RunningInstallationIdentity {
	/** The resolved `file:` module URL the identity was derived from. */
	readonly moduleUrl: string;
	readonly root: string;
	readonly runtimeKind: "source" | "built";
	/** The default CLI/UI entry for this runtime kind. */
	readonly entries: Readonly<{ cli: string; ui: string }>;
	/**
	 * Every entry the proven installation may trust under the narrow
	 * dev-in-kit exception (`src/cli.ts`, `dist/cli.js` and the UI bin).
	 */
	readonly trustedEntries: readonly string[];
}

/** One selected tool: the canonical path plus its provenance. */
export interface TrustedToolSelection {
	readonly path: string;
	readonly source: TrustedToolSource;
	/**
	 * True only when `path` is one of the running installation's own trusted
	 * entries (see `RunningInstallationIdentity.trustedEntries`). The dev-in-kit
	 * exception is granted from this structural equality at use time.
	 */
	readonly runningEntry: boolean;
}

/**
 * The host-owned installation descriptor. Built once from the operator profile
 * plus fixed defaults; a tool that is absent is refused on use, never resolved
 * through PATH. Production callers must never accept one from project input.
 */
export interface TrustedInstallationDescriptor {
	readonly version: 1;
	readonly platform: NodeJS.Platform;
	readonly runningInstallation?: RunningInstallationIdentity;
	readonly tools: Readonly<Partial<Record<InstallTool, TrustedToolSelection>>>;
}

export interface HostToolchain {
	rootfs?: string;
	manifestSha256: string;
	gondolinImage?: string;
	daytonaSnapshot?: string;
	deps?: string;
}

export interface HostProjectEntry {
	root: string;
	backends: Backend[];
	toolchainId: string;
	publicValues: Record<string, string>;
	remoteProject?: string;
	deliveryOrigin?: string;
	otlpLoopback?: boolean;
}

export interface HostProfile {
	version: 1;
	installation?: InstallationPaths;
	projects: HostProjectEntry[];
	toolchains: Record<string, HostToolchain>;
}

/** The exact-root grant (or the provisioned implicit local default). */
export interface ProjectGrant {
	root: string;
	backends: readonly Backend[];
	toolchainId: string;
	publicValues: Readonly<Record<string, string>>;
	remoteProject?: string;
	deliveryOrigin?: string;
	implicitDefault: boolean;
}

export interface ResolvedToolchain {
	id: string;
	manifestSha256: string;
	rootfs?: string;
	gondolinImage?: string;
	daytonaSnapshot?: string;
	deps?: string;
}

/**
 * Binding shape for a future lease. P01 step (a) defines it so the host
 * profile and env decisions have one vocabulary; no lease is launched here.
 */
export interface LeaseSpec {
	id: string;
	purpose: Purpose;
	tree: string;
	controlsSha256: string;
	toolchainId: string;
	targets: readonly string[];
	publicValues: Readonly<Record<string, string>>;
	timeoutMs: number;
}

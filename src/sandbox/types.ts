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

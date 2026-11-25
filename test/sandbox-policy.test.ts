/**
 * M1-P01 step (a) — pure host policy decisions.
 *
 * The policy is a private module proven here before any CLI/UI wiring. Every
 * refusal must name a reason and must not fall back to a weaker backend,
 * target-local binary, or inherited environment.
 */
import { describe, expect, it } from "vitest";
import {
	BASE_GUEST_ENV,
	admitBackend,
	projectEnvironment,
	resolveProjectGrant,
	resolvePublicEnv,
	resolveToolchain,
	resolveTrustedExecutable,
} from "../src/sandbox/policy.ts";
import type { HostProfile, ProjectGrant } from "../src/sandbox/types.ts";

const DIGEST = "a".repeat(64);
const ROOT = "/srv/project";

function profile(overrides: Partial<HostProfile> = {}): HostProfile {
	return {
		version: 1,
		installation: {
			cli: "/opt/kit/dist/cli.js",
			node: "/usr/bin/node",
			git: "/usr/bin/git",
			gh: "/usr/bin/gh",
		},
		projects: [{
			root: ROOT,
			backends: ["local", "microvm", "remote"],
			toolchainId: "toolchain-1",
			publicValues: { PROJECT_PUBLIC_FEATURE: "on", PROJECT_PUBLIC_MODE: "safe" },
			remoteProject: "daytona-project",
			deliveryOrigin: "https://github.com/acme/widget.git",
			otlpLoopback: true,
		}],
		toolchains: {
			"toolchain-1": {
				rootfs: "/opt/kit/rootfs",
				manifestSha256: DIGEST,
				gondolinImage: "/opt/kit/gondolin.img",
				daytonaSnapshot: "snap-1",
				deps: "/opt/kit/deps",
			},
		},
		...overrides,
	};
}

function okGrant(host: HostProfile = profile()): ProjectGrant {
	const result = resolveProjectGrant(host, ROOT);
	if (!result.ok) throw new Error(result.message);
	return result.value;
}

describe("project enrollment", () => {
	it("resolves exactly one canonical-root entry", () => {
		const grant = okGrant();
		expect(grant).toMatchObject({
			root: ROOT,
			backends: ["local", "microvm", "remote"],
			toolchainId: "toolchain-1",
			publicValues: { PROJECT_PUBLIC_FEATURE: "on", PROJECT_PUBLIC_MODE: "safe" },
			remoteProject: "daytona-project",
			deliveryOrigin: "https://github.com/acme/widget.git",
			implicitDefault: false,
		});
	});

	it("refuses an unlisted project unless a provisioned default toolchain exists", () => {
		const withoutDefault = resolveProjectGrant(profile(), "/srv/other");
		expect(withoutDefault).toMatchObject({ ok: false, code: "project-not-enrolled" });

		const withDefault = profile({
			projects: [],
			toolchains: { default: { rootfs: "/opt/kit/rootfs-default", manifestSha256: DIGEST } },
		});
		const grant = resolveProjectGrant(withDefault, "/srv/other");
		expect(grant).toMatchObject({
			ok: true,
			value: {
				root: "/srv/other",
				backends: ["local"],
				toolchainId: "default",
				publicValues: {},
				implicitDefault: true,
			},
		});
	});

	it("refuses a non-canonical target root instead of normalizing it", () => {
		for (const root of ["srv/project", "/srv/../project", "/srv//project", "/srv/project/"]) {
			expect(resolveProjectGrant(profile(), root)).toMatchObject({ ok: false, code: "target-path-unsafe" });
		}
	});

	it("refuses a duplicate exact-root entry", () => {
		const base = profile().projects[0]!;
		const host = profile({ projects: [base, { ...base }] });
		expect(resolveProjectGrant(host, ROOT)).toMatchObject({ ok: false, code: "project-duplicate" });
	});
});

describe("backend and toolchain admission", () => {
	it("admits a listed backend and never falls back to another tier", () => {
		const grant = okGrant();
		expect(admitBackend(profile(), grant, { backend: "local" })).toMatchObject({ ok: true });
		expect(admitBackend(profile(), grant, { backend: "microvm" })).toMatchObject({ ok: true });
		expect(admitBackend(profile(), grant, { backend: "remote", remoteConsent: true })).toMatchObject({ ok: true });

		const localOnly = { ...grant, backends: ["local"] as const };
		const refused = admitBackend(profile(), localOnly, { backend: "microvm" });
		expect(refused).toMatchObject({ ok: false, code: "backend-not-allowed" });
		expect(JSON.stringify(refused)).not.toMatch(/rootfs|manifestSha256|"ok":true/);
	});

	it("requires both host allow and per-invocation remote consent", () => {
		const grant = okGrant();
		expect(admitBackend(profile(), grant, { backend: "remote" })).toMatchObject({ ok: false, code: "remote-consent-required" });
		expect(admitBackend(profile(), grant, { backend: "remote", remoteConsent: false }))
			.toMatchObject({ ok: false, code: "remote-consent-required" });

		const noRemoteProject = { ...grant, remoteProject: undefined };
		expect(admitBackend(profile(), noRemoteProject, { backend: "remote", remoteConsent: true }))
			.toMatchObject({ ok: false, code: "remote-project-missing" });
	});

	it("refuses an implicit default grant for microvm/remote and for public env", () => {
		const host = profile({
			projects: [],
			toolchains: { default: { rootfs: "/opt/kit/rootfs-default", manifestSha256: DIGEST } },
		});
		const result = resolveProjectGrant(host, "/srv/other");
		if (!result.ok) throw new Error(result.message);
		expect(admitBackend(host, result.value, { backend: "microvm" })).toMatchObject({ ok: false, code: "backend-not-allowed" });
		expect(admitBackend(host, result.value, { backend: "remote", remoteConsent: true }))
			.toMatchObject({ ok: false, code: "backend-not-allowed" });
		expect(resolvePublicEnv(result.value, ["PROJECT_PUBLIC_FEATURE"]))
			.toMatchObject({ ok: false, code: "public-env-not-granted" });
	});

	it("requires the tier-specific immutable image field", () => {
		const host = profile({
			toolchains: {
				"toolchain-1": { manifestSha256: DIGEST, rootfs: "/opt/kit/rootfs", gondolinImage: "/opt/kit/vm.img" },
			},
		});
		const grant = okGrant(host);
		expect(resolveToolchain(host, grant, "local")).toMatchObject({ ok: true });
		expect(resolveToolchain(host, grant, "microvm")).toMatchObject({ ok: true });
		expect(resolveToolchain(host, grant, "remote")).toMatchObject({ ok: false, code: "toolchain-incomplete" });

		const noRootfs = profile({
			toolchains: { "toolchain-1": { manifestSha256: DIGEST, gondolinImage: "/opt/kit/vm.img" } },
		});
		expect(resolveToolchain(noRootfs, okGrant(noRootfs), "local")).toMatchObject({ ok: false, code: "toolchain-incomplete" });
	});

	it("refuses a project entry naming a missing toolchain", () => {
		const host = profile({ toolchains: {} });
		const grant = okGrant(host);
		expect(admitBackend(host, grant, { backend: "local" })).toMatchObject({ ok: false, code: "toolchain-missing" });
	});
});

describe("public environment projection", () => {
	it("returns only the exact granted subset", () => {
		expect(resolvePublicEnv(okGrant(), ["PROJECT_PUBLIC_FEATURE"])).toEqual({
			ok: true,
			value: { PROJECT_PUBLIC_FEATURE: "on" },
		});
	});

	it("refuses undeclared, reserved, duplicate, malformed, or oversized requests", () => {
		const grant = okGrant();
		expect(resolvePublicEnv(grant, ["PROJECT_PUBLIC_UNDECLARED"])).toMatchObject({ ok: false, code: "public-env-not-granted" });
		expect(resolvePublicEnv(grant, ["PATH"])).toMatchObject({ ok: false, code: "public-env-reserved" });
		expect(resolvePublicEnv(grant, ["HOME"])).toMatchObject({ ok: false, code: "public-env-reserved" });
		expect(resolvePublicEnv(grant, ["NODE_OPTIONS"])).toMatchObject({ ok: false, code: "public-env-reserved" });
		expect(resolvePublicEnv(grant, ["KIT_FAUX"])).toMatchObject({ ok: false, code: "public-env-reserved" });
		expect(resolvePublicEnv(grant, ["PROJECT_PUBLIC_FEATURE", "PROJECT_PUBLIC_FEATURE"]))
			.toMatchObject({ ok: false, code: "public-env-duplicate" });
		expect(resolvePublicEnv(grant, ["project_public_feature"])).toMatchObject({ ok: false, code: "public-env-name-invalid" });
		expect(resolvePublicEnv(grant, Array.from({ length: 17 }, (_, i) => `PROJECT_PUBLIC_K${i}`)))
			.toMatchObject({ ok: false, code: "public-env-too-many" });
	});

	it("builds the fixed guest environment plus grants, never the host environment", () => {
		const saved = { PATH: process.env["PATH"], PROJECT_PUBLIC_FEATURE: process.env["PROJECT_PUBLIC_FEATURE"], KIT_FAUX: process.env["KIT_FAUX"] };
		process.env["PATH"] = "/srv/project/node_modules/.bin:/usr/bin";
		process.env["PROJECT_PUBLIC_FEATURE"] = "host-value";
		process.env["KIT_FAUX"] = "1";
		try {
			const result = projectEnvironment(okGrant(), ["PROJECT_PUBLIC_FEATURE"]);
			expect(result).toEqual({
				ok: true,
				value: {
					...BASE_GUEST_ENV,
					PROJECT_PUBLIC_FEATURE: "on",
				},
			});
			if (!result.ok) throw new Error("unreachable");
			expect(Object.keys(result.value).sort()).toEqual(
				["CI", "HOME", "LANG", "PATH", "PROJECT_PUBLIC_FEATURE", "TMPDIR", "TZ"].sort(),
			);
			expect(result.value.PATH).toBe("/opt/kit/bin:/usr/bin:/bin");
			expect(result.value.HOME).toBe("/home/worker");
			expect(result.value.TMPDIR).toBe("/tmp");
			expect(result.value.LANG).toBe("C.UTF-8");
			expect(result.value.TZ).toBe("UTC");
			expect(result.value.CI).toBe("1");
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});

describe("trusted executable resolution", () => {
	it("uses the host-policy override and never target cwd or PATH", () => {
		const result = resolveTrustedExecutable(profile(), "git", {
			targetRoot: ROOT,
			trustedDefaults: { git: "/srv/project/node_modules/.bin/git" },
		});
		expect(result).toEqual({ ok: true, value: { path: "/usr/bin/git", source: "profile" } });
	});

	it("uses only an explicitly supplied trusted installation default", () => {
		const host = profile({ installation: { node: "/usr/bin/node" } });
		expect(resolveTrustedExecutable(host, "cli", {
			targetRoot: ROOT,
			trustedDefaults: { cli: "/opt/kit/dist/cli.js" },
		})).toEqual({ ok: true, value: { path: "/opt/kit/dist/cli.js", source: "trusted-installation" } });
		expect(resolveTrustedExecutable(host, "git", { targetRoot: ROOT }))
			.toMatchObject({ ok: false, code: "installation-not-configured" });
	});

	it("refuses a target-local override or trusted default", () => {
		const host = profile({ installation: { cli: "/srv/project/node_modules/.bin/llm-toolkit-001" } });
		expect(resolveTrustedExecutable(host, "cli", { targetRoot: ROOT }))
			.toMatchObject({ ok: false, code: "installation-inside-target" });
		expect(resolveTrustedExecutable(profile({ installation: {} }), "cli", {
			targetRoot: ROOT,
			trustedDefaults: { cli: "/srv/project/dist/cli.js" },
		})).toMatchObject({ ok: false, code: "installation-inside-target" });
	});

	it("refuses relative or traversing installation entries even when supplied as a default", () => {
		expect(resolveTrustedExecutable(profile({ installation: {} }), "git", {
			targetRoot: ROOT,
			trustedDefaults: { git: "usr/bin/git" },
		})).toMatchObject({ ok: false, code: "installation-unsafe-path" });
		expect(resolveTrustedExecutable(profile({ installation: {} }), "git", {
			targetRoot: ROOT,
			trustedDefaults: { git: "/usr/../bin/git" },
		})).toMatchObject({ ok: false, code: "installation-unsafe-path" });
	});

	it("never lets project env select a target-local CLI", () => {
		const saved = { KIT_UI_CLI_BIN: process.env["KIT_UI_CLI_BIN"], PATH: process.env["PATH"] };
		process.env["KIT_UI_CLI_BIN"] = "/srv/project/node_modules/.bin/llm-toolkit-001";
		process.env["PATH"] = "/srv/project/node_modules/.bin:/usr/bin";
		try {
			expect(resolveTrustedExecutable(profile(), "cli", { targetRoot: ROOT })).toEqual({
				ok: true,
				value: { path: "/opt/kit/dist/cli.js", source: "profile" },
			});
			expect(resolveTrustedExecutable(profile({ installation: {} }), "cli", { targetRoot: ROOT }))
				.toMatchObject({ ok: false, code: "installation-not-configured" });
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});

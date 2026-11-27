/**
 * M1-P01 step (e) — host-owned trusted installation resolver.
 *
 * Every case asserts the forbidden effect as well as the refusal: a refusal
 * must happen BEFORE a spawn, must keep the selected path (never fall back to a
 * default/PATH candidate), and must leave unrelated tools usable (on-demand
 * resolution). Injection below is host authority, not a weaker validation mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const spawned = vi.hoisted(() => [] as { file: string; args: string[]; env?: NodeJS.ProcessEnv }[]);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (file: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
			spawned.push({ file, args: [...args], ...(options?.env ? { env: options.env } : {}) });
			return (actual.spawn as typeof import("node:child_process").spawn)(file, args, options as never);
		},
	};
});

import {
	TrustedInstallationError,
	buildGhEnvironment,
	buildGitEnvironment,
	currentTrustedInstallation,
	gitHardeningArgs,
	installTrustedInstallationForTests,
	installationDescriptorDigest,
	loadTrustedInstallation,
	requireLaunchPrefix,
	requireTrustedTool,
	runningInstallationFrom,
	runTrustedTool,
	selectInstallation,
	selectLaunchPrefix,
} from "../src/sandbox/trusted-exec.ts";
import { execTrusted } from "../src/util/exec.ts";
import { validateTrustedExecutableFile } from "../src/sandbox/host-profile.ts";
import type { TrustedInstallationDescriptor } from "../src/sandbox/types.ts";

const roots: string[] = [];

afterEach(async () => {
	installTrustedInstallationForTests(undefined);
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
	spawned.length = 0;
});

async function tempDir(prefix: string, mode = 0o755): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	await chmod(root, mode);
	return root;
}

async function installExecutable(root: string, rel: string, content = "#!/bin/sh\nexit 0\n"): Promise<string> {
	const parts = rel.split("/");
	let current = root;
	for (const part of parts.slice(0, -1)) {
		current = join(current, part);
		await mkdir(current, { recursive: true });
		await chmod(current, 0o755);
	}
	const path = join(current, parts.at(-1)!);
	await writeFile(path, content, "utf8");
	await chmod(path, 0o755);
	return path;
}

async function fixtureKit(root: string): Promise<void> {
	await installExecutable(root, "src/cli.ts", "// cli\n");
	await installExecutable(root, "dist/cli.js", "// built cli\n");
	await installExecutable(root, "ui/bin/llm-toolkit-ui.js", "// ui\n");
}

function runningFrom(root: string) {
	return runningInstallationFrom(pathToFileURL(join(root, "src", "sandbox", "trusted-exec.ts")).href, "linux");
}

describe("installation selection", () => {
	it("uses fixed Linux defaults plus the running installation's own entries", () => {
		const running = runningInstallationFrom("file:///srv/kit/src/sandbox/trusted-exec.ts", "linux");
		const descriptor = selectInstallation({ platform: "linux", running, execPath: "/usr/bin/node" });
		expect(descriptor.tools["node"]).toMatchObject({ path: "/usr/bin/node", source: "fixed-default" });
		expect(descriptor.tools["git"]).toMatchObject({ path: "/usr/bin/git", source: "fixed-default" });
		expect(descriptor.tools["gh"]).toMatchObject({ path: "/usr/bin/gh", source: "fixed-default" });
		expect(descriptor.tools["cli"]).toMatchObject({ path: "/srv/kit/src/cli.ts", source: "running-installation", runningEntry: true });
		expect(descriptor.tools["ui"]).toMatchObject({ path: "/srv/kit/ui/bin/llm-toolkit-ui.js", source: "running-installation", runningEntry: true });
		expect(descriptor.tools["helper"]).toBeUndefined();
		expect(descriptor.tools["bwrap"]).toBeUndefined();

		const built = selectInstallation({
			platform: "linux",
			running: runningInstallationFrom("file:///srv/kit/dist/sandbox/trusted-exec.js", "linux"),
			execPath: "/usr/bin/node",
		});
		expect(built.tools["cli"]).toMatchObject({ path: "/srv/kit/dist/cli.js", source: "running-installation" });
		// The proven installation's OTHER own entry is still trusted by identity.
		expect(built.runningInstallation!.trustedEntries).toContain("/srv/kit/src/cli.ts");
	});

	it("lets an explicit installation override win and refuses to fall back after it", async () => {
		const running = runningInstallationFrom("file:///srv/kit/src/sandbox/trusted-exec.ts", "linux");
		const descriptor = selectInstallation({
			platform: "linux",
			running,
			execPath: "/usr/bin/node",
			installation: { git: "/nonexistent/operator-git" },
		});
		expect(descriptor.tools["git"]).toMatchObject({ path: "/nonexistent/operator-git", source: "profile" });
		const result = await runTrustedTool("git", ["--version"], {
			targetRoot: await tempDir("kit-te-target-"),
			timeoutMs: 10_000,
			installation: descriptor,
		});
		expect(result.code).toBeNull();
		expect(result.signaledBy).toBe("trusted-installation");
		expect(result.stderr).toContain("refused");
		expect(spawned).toHaveLength(0);
		// Selection never replaced the invalid override with the /usr/bin/git default.
		expect(descriptor.tools["git"]!.path).not.toBe("/usr/bin/git");
	});

	it("requires an explicitly selected local launcher on use and binds it into identity", async () => {
		const target = await tempDir("kit-te-target-");
		const absent = selectInstallation({ platform: "linux", running: null, execPath: "/usr/bin/node" });
		const before = installationDescriptorDigest(absent);
		await expect(requireTrustedTool(absent, "localLauncher", { targetRoot: target }))
			.rejects.toMatchObject({ code: "not-configured" });
		expect(spawned).toHaveLength(0);
		const selected = selectInstallation({ platform: "linux", running: null, execPath: "/usr/bin/node", installation: { localLauncher: "/usr/bin/false" } });
		expect(selected.tools.localLauncher).toMatchObject({ path: "/usr/bin/false", source: "profile", runningEntry: false });
		expect(installationDescriptorDigest(selected)).not.toBe(before);
		await expect(requireTrustedTool(selected, "localLauncher", { targetRoot: target })).resolves.toMatchObject({ path: "/usr/bin/false" });
		expect(spawned).toHaveLength(0);
	});

	it("refuses in-target and symlinked local launcher selections without fallback or project execution", async () => {
		const target = await tempDir("kit-te-target-");
		const selected = selectInstallation({ platform: "linux", running: null, execPath: "/usr/bin/node", installation: { localLauncher: join(target, "launcher") } });
		await installExecutable(target, "launcher");
		await expect(requireTrustedTool(selected, "localLauncher", { targetRoot: target })).rejects.toMatchObject({ code: "installation-inside-target" });
		const installRoot = await tempDir("kit-te-launcher-");
		const real = await installExecutable(installRoot, "bin/launcher");
		const link = join(installRoot, "bin", "launcher-link");
		await symlink(real, link);
		const symlinked = selectInstallation({ platform: "linux", running: null, execPath: "/usr/bin/node", installation: { localLauncher: link } });
		await expect(requireTrustedTool(symlinked, "localLauncher", { targetRoot: target })).rejects.toMatchObject({ code: "unsafe-path" });
		expect(spawned).toHaveLength(0);
	});

	it("never consults PATH, target .bin, cwd or a KIT_* value", () => {
		const saved = {
			PATH: process.env["PATH"],
			KIT_UI_CLI_BIN: process.env["KIT_UI_CLI_BIN"],
			KIT_CLI_BIN: process.env["KIT_CLI_BIN"],
		};
		process.env["PATH"] = "/srv/project/node_modules/.bin:/usr/bin";
		process.env["KIT_UI_CLI_BIN"] = "/srv/project/node_modules/.bin/llm-toolkit-001";
		process.env["KIT_CLI_BIN"] = "/srv/project/dist/cli.js";
		try {
			const descriptor = selectInstallation({
				platform: "linux",
				running: runningInstallationFrom("file:///srv/kit/src/sandbox/trusted-exec.ts", "linux"),
				execPath: "/usr/bin/node",
			});
			expect(descriptor.tools["git"]!.path).toBe("/usr/bin/git");
			expect(descriptor.tools["cli"]!.path).toBe("/srv/kit/src/cli.ts");
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("reads operator overrides only from the host profile and refuses a malformed one", async () => {
		const home = await tempDir("kit-te-profile-");
		const absent = await loadTrustedInstallation({
			profilePath: join(home, "absent.json"),
			platform: "linux",
			running: null,
			execPath: "/usr/bin/node",
		});
		expect(absent.tools["git"]?.path).toBe("/usr/bin/git");
		expect(absent.tools["cli"]).toBeUndefined();

		const profile = join(home, "host-v1.json");
		await writeFile(profile, JSON.stringify({ version: 1, installation: { git: "relative/git" } }), "utf8");
		await chmod(profile, 0o600);
		await expect(loadTrustedInstallation({ profilePath: profile, platform: "linux", running: null, execPath: "/usr/bin/node" }))
			.rejects.toMatchObject({ code: "unsafe-path" });

		await writeFile(profile, "{not json", "utf8");
		await expect(loadTrustedInstallation({ profilePath: profile, platform: "linux", running: null, execPath: "/usr/bin/node" }))
			.rejects.toMatchObject({ code: "invalid-json" });
		await chmod(profile, 0o644);
		await expect(loadTrustedInstallation({ profilePath: profile, platform: "linux", running: null, execPath: "/usr/bin/node" }))
			.rejects.toMatchObject({ code: "unsafe-permissions" });
	});

	it("has no Git/gh default on a non-Linux host and refuses only the needing operation", async () => {
		const running = runningInstallationFrom("file:///srv/kit/src/sandbox/trusted-exec.ts", "darwin");
		const descriptor = selectInstallation({ platform: "darwin", running, execPath: "/usr/local/bin/node" });
		expect(descriptor.tools["git"]).toBeUndefined();
		expect(descriptor.tools["gh"]).toBeUndefined();
		expect(descriptor.tools["node"]).toMatchObject({ path: "/usr/local/bin/node" });
		await expect(requireTrustedTool(descriptor, "git", { targetRoot: "/srv/project", platform: "darwin" }))
			.rejects.toMatchObject({ code: "not-configured" });
		expect(spawned).toHaveLength(0);
	});
});

describe("per-use validation", () => {
	it("validates the selected tool on use; the running entry is trusted inside its own checkout", async () => {
		const kit = await tempDir("kit-te-kit-");
		await fixtureKit(kit);
		const project = await tempDir("kit-te-project-");
		const running = runningFrom(kit);
		const descriptor = selectInstallation({ platform: "linux", running, execPath: "/usr/bin/node" });

		await expect(requireTrustedTool(descriptor, "git", { targetRoot: project })).resolves.toMatchObject({
			path: "/usr/bin/git", source: "fixed-default",
		});
		// Dev-in-kit: the target IS the running installation checkout.
		await expect(requireTrustedTool(descriptor, "cli", { targetRoot: kit })).resolves.toMatchObject({
			path: join(kit, "src", "cli.ts"), source: "running-installation",
		});
		await expect(requireTrustedTool(descriptor, "ui", { targetRoot: kit })).resolves.toMatchObject({
			path: join(kit, "ui", "bin", "llm-toolkit-ui.js"),
		});
		expect(spawned).toHaveLength(0);
	});

	it("still applies symlink/mode checks to the dev-in-kit entry", async () => {
		const kit = await tempDir("kit-te-kit-");
		await fixtureKit(kit);
		const running = runningFrom(kit);
		const descriptor = selectInstallation({ platform: "linux", running, execPath: "/usr/bin/node" });
		await chmod(join(kit, "ui", "bin", "llm-toolkit-ui.js"), 0o775);
		await expect(requireTrustedTool(descriptor, "ui", { targetRoot: kit })).rejects.toMatchObject({ code: "unsafe-file" });

		await chmod(join(kit, "ui", "bin", "llm-toolkit-ui.js"), 0o755);
		const link = join(kit, "dist", "cli-link.js");
		await symlink(join(kit, "dist", "cli.js"), link);
		const linked = selectInstallation({
			platform: "linux",
			running,
			execPath: "/usr/bin/node",
			installation: { cli: link },
		});
		// Checked from OUTSIDE the kit: the same installation identity, but the
		// symlinked selected path must refuse rather than realpath to its target.
		await expect(requireTrustedTool(linked, "cli", { targetRoot: await tempDir("kit-te-target-") }))
			.rejects.toMatchObject({ code: "unsafe-path" });
	});

	it("never trusts a kit copy that merely sits inside the target", async () => {
		const kit = await tempDir("kit-te-kit-");
		await fixtureKit(kit);
		const target = await tempDir("kit-te-target-");
		const copy = join(target, "kit-copy");
		await installExecutable(copy, "dist/cli.js", "// copied cli\n");
		const running = runningFrom(kit);
		const descriptor = selectInstallation({
			platform: "linux",
			running,
			execPath: "/usr/bin/node",
			installation: { cli: join(copy, "dist", "cli.js") },
		});
		await expect(requireTrustedTool(descriptor, "cli", { targetRoot: target }))
			.rejects.toMatchObject({ code: "installation-inside-target" });

		// Even a forged "runningEntry" flag cannot grant the exception: the path
		// must equal an entry proven from the running module URL.
		const forged: TrustedInstallationDescriptor = {
			version: 1,
			platform: "linux",
			runningInstallation: running,
			tools: {
				cli: { path: join(copy, "dist", "cli.js"), source: "running-installation", runningEntry: true },
			},
		};
		await expect(requireTrustedTool(forged, "cli", { targetRoot: target }))
			.rejects.toMatchObject({ code: "installation-inside-target" });
	});

	it("refuses a profile-selected path inside the target without trying a default", async () => {
		const target = await tempDir("kit-te-target-");
		await installExecutable(target, "node_modules/.bin/llm-toolkit-001");
		const running = runningInstallationFrom("file:///srv/kit/src/sandbox/trusted-exec.ts", "linux");
		const descriptor = selectInstallation({
			platform: "linux",
			running,
			execPath: "/usr/bin/node",
			installation: { cli: join(target, "node_modules", ".bin", "llm-toolkit-001") },
		});
		await expect(requireTrustedTool(descriptor, "cli", { targetRoot: target }))
			.rejects.toMatchObject({ code: "installation-inside-target" });
		// The other tools are unaffected: resolution is per use.
		await expect(requireTrustedTool(descriptor, "git", { targetRoot: target })).resolves.toMatchObject({ path: "/usr/bin/git" });
	});

	it("refuses a missing selected path, symlinked ancestry and writable ancestors", async () => {
		const root = await tempDir("kit-te-anc-");
		const target = await tempDir("kit-te-target-");
		const bin = join(root, "bin");
		await mkdir(bin);
		await chmod(bin, 0o755);
		const tool = await installExecutable(root, "bin/git");
		await expect(validateTrustedExecutableFile(tool, "git", { targetRoot: target })).resolves.toBe(tool);
		await expect(validateTrustedExecutableFile(join(bin, "absent"), "git", { targetRoot: target }))
			.rejects.toMatchObject({ code: "not-found" });

		// A symlinked ancestor refuses even when the resolved leaf is the same file.
		const alias = join(root, "bin-alias");
		await symlink(bin, alias);
		await expect(validateTrustedExecutableFile(join(alias, "git"), "git", { targetRoot: target }))
			.rejects.toMatchObject({ code: "unsafe-path" });

		// Group/world-writable non-sticky ancestor refuses; 0755 is accepted.
		const groupDir = join(root, "group");
		await mkdir(groupDir);
		await installExecutable(root, "group/git");
		await chmod(groupDir, 0o775);
		await expect(validateTrustedExecutableFile(join(groupDir, "git"), "git", { targetRoot: target }))
			.rejects.toMatchObject({ code: "unsafe-file" });
		await chmod(groupDir, 0o755);
		await expect(validateTrustedExecutableFile(join(groupDir, "git"), "git", { targetRoot: target })).resolves.toBeTruthy();
	});

	it("accepts a sticky world-writable ancestor only because entries cannot be replaced there", async () => {
		// /tmp (01777) is on every fixture path above; prove the rule explicitly.
		const root = await tempDir("kit-te-sticky-", 0o1777);
		const target = await tempDir("kit-te-target-");
		await installExecutable(root, "git");
		await expect(validateTrustedExecutableFile(join(root, "git"), "git", { targetRoot: target })).resolves.toBeTruthy();
	});
});

describe("launch identity (step f)", () => {
	it("selects a built entry as exactly [node, entry] — with no PATH/cwd/target/env input", () => {
		const saved = { PATH: process.env["PATH"], KIT_UI_CLI_BIN: process.env["KIT_UI_CLI_BIN"] };
		process.env["PATH"] = "/target/node_modules/.bin:/usr/bin";
		process.env["KIT_UI_CLI_BIN"] = "/target/node_modules/.bin/llm-toolkit-001";
		try {
			const running = runningInstallationFrom("file:///srv/kit/dist/sandbox/trusted-exec.js", "linux");
			const descriptor = selectInstallation({ platform: "linux", running, execPath: "/usr/bin/node" });
			const selected = selectLaunchPrefix(descriptor, "cli");
			expect(selected.ok).toBe(true);
			if (!selected.ok) return;
			expect(selected.value).toMatchObject({
				tool: "cli",
				form: "built",
				node: "/usr/bin/node",
				entry: "/srv/kit/dist/cli.js",
				argv: ["/usr/bin/node", "/srv/kit/dist/cli.js"],
				installationRoot: "/srv/kit",
			});
			expect(selected.value.loader).toBeUndefined();
			// the UI launch identity is the installation's own bin, through the same node
			const ui = selectLaunchPrefix(descriptor, "ui");
			expect(ui.ok && ui.value.argv).toEqual(["/usr/bin/node", "/srv/kit/ui/bin/llm-toolkit-ui.js"]);
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("uses the documented dev-in-kit source form [node, ui tsx loader, src/cli.ts]", async () => {
		const kit = await tempDir("kit-te-kit-");
		await fixtureKit(kit);
		const runtime = await tempDir("kit-te-runtime-");
		const node = await installExecutable(runtime, "bin/node", "// node\n");
		const loader = await installExecutable(kit, "ui/node_modules/tsx/dist/cli.mjs", "// tsx\n");
		const target = await tempDir("kit-te-target-");
		const descriptor = selectInstallation({ platform: "linux", running: runningFrom(kit), execPath: node });
		const prefix = await requireLaunchPrefix(descriptor, "cli", { targetRoot: target });
		expect(prefix).toMatchObject({
			form: "source",
			node,
			entry: join(kit, "src", "cli.ts"),
			loader,
			argv: [node, loader, join(kit, "src", "cli.ts")],
			installationRoot: kit,
		});
		// Dev-in-kit: the same launch validates when the project IS the installation.
		await expect(requireLaunchPrefix(descriptor, "ui", { targetRoot: kit })).resolves.toMatchObject({
			form: "built",
			entry: join(kit, "ui", "bin", "llm-toolkit-ui.js"),
		});
		expect(spawned).toHaveLength(0);
	});

	it("refuses a TypeScript entry that is not the running installation's own — never a candidate search", () => {
		const descriptor = selectInstallation({
			platform: "linux",
			running: runningInstallationFrom("file:///srv/kit/src/sandbox/trusted-exec.ts", "linux"),
			execPath: "/usr/bin/node",
			installation: { cli: "/srv/other/cli.ts" },
		});
		expect(selectLaunchPrefix(descriptor, "cli")).toMatchObject({ ok: false, code: "unsupported-entry" });
	});

	it("refuses a missing/in-target selected entry before any spawn (no default fallback)", async () => {
		const kit = await tempDir("kit-te-kit-");
		await fixtureKit(kit);
		const runtime = await tempDir("kit-te-runtime-");
		const node = await installExecutable(runtime, "bin/node", "// node\n");
		const target = await tempDir("kit-te-target-");
		await installExecutable(target, "node_modules/.bin/llm-toolkit-001.js");
		const descriptor = selectInstallation({
			platform: "linux",
			running: runningFrom(kit),
			execPath: node,
			installation: { cli: join(target, "node_modules", ".bin", "llm-toolkit-001.js") },
		});
		await expect(requireLaunchPrefix(descriptor, "cli", { targetRoot: target }))
			.rejects.toMatchObject({ code: "installation-inside-target" });

		const missing = selectInstallation({
			platform: "linux",
			running: runningFrom(kit),
			execPath: node,
			installation: { cli: join(kit, "dist", "absent-cli.js") },
		});
		await expect(requireLaunchPrefix(missing, "cli", { targetRoot: target })).rejects.toMatchObject({ code: "not-found" });
		expect(spawned).toHaveLength(0);
	});

	it("has one canonical descriptor digest and refuses a tool it never selected", async () => {
		const kit = await tempDir("kit-te-kit-");
		await fixtureKit(kit);
		const descriptor = selectInstallation({ platform: "linux", running: runningFrom(kit), execPath: process.execPath });
		const digest = installationDescriptorDigest(descriptor);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(installationDescriptorDigest(selectInstallation({ platform: "linux", running: runningFrom(kit), execPath: process.execPath }))).toBe(digest);
		const helpers = { version: 1 as const, platform: "linux" as const, tools: { node: { path: process.execPath, source: "fixed-default" as const, runningEntry: false } } };
		expect(selectLaunchPrefix(helpers, "cli")).toMatchObject({ ok: false, code: "not-configured" });
	});
});

describe("host-built environments", () => {
	it("builds a callback-free Git environment that strips inherited hostile values", () => {
		const saved = {
			GIT_DIR: process.env["GIT_DIR"],
			GIT_CONFIG_GLOBAL: process.env["GIT_CONFIG_GLOBAL"],
			GIT_SSH_COMMAND: process.env["GIT_SSH_COMMAND"],
			SSH_AUTH_SOCK: process.env["SSH_AUTH_SOCK"],
			HTTPS_PROXY: process.env["HTTPS_PROXY"],
			BASH_ENV: process.env["BASH_ENV"],
			NODE_OPTIONS: process.env["NODE_OPTIONS"],
		};
		Object.assign(process.env, {
			GIT_DIR: "/target/.git",
			GIT_CONFIG_GLOBAL: "/target/.gitconfig",
			GIT_SSH_COMMAND: "/target/evil",
			SSH_AUTH_SOCK: "/target/agent.sock",
			HTTPS_PROXY: "http://127.0.0.1:9",
			BASH_ENV: "/target/env",
			NODE_OPTIONS: "--require /target/evil.cjs",
		});
		try {
			const env = buildGitEnvironment({ GIT_INDEX_FILE: "/tmp/index" });
			for (const key of ["GIT_DIR", "GIT_SSH_COMMAND", "SSH_AUTH_SOCK", "HTTPS_PROXY", "BASH_ENV", "NODE_OPTIONS"]) {
				expect(env[key]).toBeUndefined();
			}
			expect(env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
			// The inherited value never becomes the effective config source.
			expect(env["GIT_CONFIG_GLOBAL"]).not.toBe("/target/.gitconfig");
			expect(env).toMatchObject({
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
				GIT_INDEX_FILE: "/tmp/index",
			});
			expect(() => buildGitEnvironment({ GIT_DIR: "/target/.git" })).toThrow(TrustedInstallationError);
			expect(() => buildGitEnvironment({ GH_TOKEN: "x" })).toThrow(TrustedInstallationError);
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("disables callbacks in the fixed Git argv prefix", () => {
		const args = gitHardeningArgs().join(" ");
		for (const expected of [
			"core.hooksPath=/dev/null",
			"core.fsmonitor=false",
			"core.attributesFile=/dev/null",
			"credential.helper=",
			"diff.external=",
			"protocol.ext.allow=never",
			"commit.gpgsign=false",
			"http.proxy=",
		]) {
			expect(args).toContain(expected);
		}
	});

	it("builds a noninteractive, destination-pinned gh environment", () => {
		const env = buildGhEnvironment({ gitHubToken: "token-123" });
		expect(env).toMatchObject({ GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_TOKEN: "token-123" });
		expect(env["SSH_AUTH_SOCK"]).toBeUndefined();
		expect(env["HTTPS_PROXY"]).toBeUndefined();
		expect(() => buildGhEnvironment({ gitHubToken: "a\nb" })).toThrow(TrustedInstallationError);
	});
});

describe("trusted spawn seam", () => {
	it("refuses a relative/bare program name before spawning anything", async () => {
		const outcome = await execTrusted(["git", "--version"], {
			cwd: process.cwd(),
			timeoutMs: 10_000,
			env: buildGitEnvironment(),
		});
		expect(outcome.refused).toBe("argv");
		expect(outcome.code).toBeNull();
		expect(spawned).toHaveLength(0);
	});

	it("spawns with EXACTLY the supplied env (no inherited process env)", async () => {
		const saved = process.env["PROBE_HOST_ONLY"];
		process.env["PROBE_HOST_ONLY"] = "host";
		try {
			const outcome = await execTrusted([process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"], {
				cwd: process.cwd(),
				timeoutMs: 15_000,
				env: { PROBE_EXACT: "1" },
			});
			expect(outcome.code).toBe(0);
			expect(JSON.parse(outcome.stdout)).toEqual({ PROBE_EXACT: "1" });
			expect(spawned).toHaveLength(1);
			expect(spawned[0]!.env).toEqual({ PROBE_EXACT: "1" });
		} finally {
			if (saved === undefined) delete process.env["PROBE_HOST_ONLY"];
			else process.env["PROBE_HOST_ONLY"] = saved;
		}
	});

	it("runs the resolved absolute Git with the host env and reports a zero-spawn refusal", async () => {
		const project = await tempDir("kit-te-project-");
		const valid = selectInstallation({
			platform: "linux",
			running: runningInstallationFrom("file:///srv/kit/src/sandbox/trusted-exec.ts", "linux"),
			execPath: "/usr/bin/node",
		});
		installTrustedInstallationForTests(valid);
		const ok = await runTrustedTool("git", ["--version"], { targetRoot: project, timeoutMs: 15_000 });
		expect(ok.code).toBe(0);
		expect(ok.stdout).toContain("git version");
		expect(spawned).toHaveLength(1);
		expect(spawned[0]!.file).toBe("/usr/bin/git");
		expect(spawned[0]!.args).not.toContain("git");
		expect(spawned[0]!.env?.["GIT_DIR"]).toBeUndefined();

		spawned.length = 0;
		installTrustedInstallationForTests(selectInstallation({
			platform: "linux",
			running: runningInstallationFrom("file:///srv/kit/src/sandbox/trusted-exec.ts", "linux"),
			execPath: "/usr/bin/node",
			installation: { git: join(project, ".bin", "git") },
		}));
		const refused = await runTrustedTool("git", ["--version"], { targetRoot: project, timeoutMs: 15_000 });
		expect(refused.code).toBeNull();
		expect(refused.signaledBy).toBe("trusted-installation");
		expect(refused.stderr).toContain("refused");
		expect(spawned).toHaveLength(0);
	});

	it("never resolves gh for a non-delivery run and refuses a broken selected gh", async () => {
		const project = await tempDir("kit-te-project-");
		const descriptor = selectInstallation({
			platform: "linux",
			running: runningInstallationFrom("file:///srv/kit/src/sandbox/trusted-exec.ts", "linux"),
			execPath: "/usr/bin/node",
			installation: { gh: join(project, ".bin", "gh") },
		});
		installTrustedInstallationForTests(descriptor);
		// Git still works: the broken gh selection is only touched on use.
		expect((await runTrustedTool("git", ["--version"], { targetRoot: project, timeoutMs: 15_000 })).code).toBe(0);
		const before = spawned.length;
		const gh = await runTrustedTool("gh", ["pr", "list", "--repo", "acme/widget"], { targetRoot: project, timeoutMs: 15_000 });
		expect(gh.code).toBeNull();
		expect(gh.stderr).toContain("refused");
		expect(spawned).toHaveLength(before);
	});

	it("uses the resolved credential helper as a literal path with spaces and quotes", async () => {
		const project = await tempDir("kit-te-project-");
		const install = await tempDir("kit-te-helper-");
		const gh = join(install, "host's gh");
		await writeFile(gh, "#!/bin/sh\n[ \"$1 $2 $3\" = 'auth git-credential get' ] || exit 1\nprintf 'username=fixture\\npassword=%s\\n' \"$GH_TOKEN\"\n", { mode: 0o700 });
		const descriptor = selectInstallation({ platform: "linux", installation: { gh } });
		const result = await runTrustedTool("git", ["credential", "fill"], {
			targetRoot: project, timeoutMs: 5_000, installation: descriptor,
			credentialHelper: true, gitHubToken: "fixture-token", input: "protocol=https\nhost=github.com\n\n",
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("username=fixture\npassword=fixture-token");
		expect(spawned).toHaveLength(1);
	});

	it("exposes the process installation only through the host-owned accessor", async () => {
		const project = await tempDir("kit-te-project-");
		const descriptor = selectInstallation({
			platform: "linux",
			running: runningInstallationFrom("file:///srv/kit/src/sandbox/trusted-exec.ts", "linux"),
			execPath: "/usr/bin/node",
			installation: { git: join(project, "node_modules", ".bin", "git") },
		});
		installTrustedInstallationForTests(descriptor);
		await expect(currentTrustedInstallation()).resolves.toBe(descriptor);
		installTrustedInstallationForTests(undefined);
		const loaded = await currentTrustedInstallation();
		expect(loaded.tools["git"]?.path === join(project, "node_modules", ".bin", "git")).toBe(false);
	});
});

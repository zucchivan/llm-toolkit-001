/**
 * M1-P01 step (a) — strict host policy and trusted installation contract.
 *
 * These are contract tests for the private policy module only. No CLI/UI
 * wiring is exercised here; production callers are wired in later internal
 * steps. Each test names the obligation it protects so the evidence map in
 * docs/engineering-plan/evidence/M1-P01.md can point at it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import {
	appendFile,
	chmod,
	link,
	mkdir,
	mkdtemp,
	open as openFileHandle,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	SAFE_READ_LIMITS,
	SafeReadBudget,
	listSafeDirectory,
	openSafeDirectory,
	openSafeFile,
	readSafeFile,
	readSafeText,
	safeReadPrimitiveStatus,
	walkSafeFiles,
} from "../src/util/safe-read.ts";
import type { SafeReadResult } from "../src/util/safe-read.ts";
import {
	HostProfileError,
	defaultHostProfilePath,
	parseHostProfile,
	readApprovedDeliveryOrigin,
	readHostProfile,
	resolveCanonicalProjectRoot,
	validateInstallationPath,
	validateTrustedExecutableFile,
	validateTrustedInstallation,
} from "../src/sandbox/host-profile.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
	// tmpdir() itself may traverse a symlink (macOS /var); the trusted-install
	// ancestry rule requires canonical roots, so canonicalize once here.
	const base = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	roots.push(base);
	return base;
}

const DIGEST = "a".repeat(64);

function hostProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		installation: {
			cli: "/opt/kit/dist/cli.js",
			ui: "/opt/kit/ui/bin/llm-toolkit-ui.js",
			node: "/usr/bin/node",
			git: "/usr/bin/git",
			gh: "/usr/bin/gh",
			helper: "/opt/kit/bin/kit-guest-helper",
			bwrap: "/usr/bin/bwrap",
		},
		projects: [
			{
				root: "/srv/project",
				backends: ["local", "microvm", "remote"],
				toolchainId: "toolchain-1",
				publicValues: { PROJECT_PUBLIC_FEATURE: "on" },
				remoteProject: "daytona-project",
				deliveryOrigin: "https://github.com/acme/widget",
				otlpLoopback: true,
			},
		],
		toolchains: {
			"toolchain-1": {
				rootfs: "/opt/kit/rootfs",
				manifestSha256: DIGEST,
				gondolinImage: "/opt/kit/gondolin.img",
				daytonaSnapshot: "snap-1",
				deps: "/opt/kit/deps",
			},
			default: { rootfs: "/opt/kit/rootfs-default", manifestSha256: DIGEST },
		},
		...overrides,
	};
}

function parseError(value: unknown): HostProfileError {
	try {
		parseHostProfile(value);
	} catch (error) {
		if (error instanceof HostProfileError) return error;
		throw error;
	}
	throw new Error("expected HostProfileError, but parsing succeeded");
}

describe("strict host profile schema", () => {
	it("parses the documented profile and canonicalizes the approved delivery origin", () => {
		const parsed = parseHostProfile(hostProfile());
		expect(parsed.version).toBe(1);
		expect(parsed.projects).toHaveLength(1);
		expect(parsed.projects[0]).toMatchObject({
			root: "/srv/project",
			backends: ["local", "microvm", "remote"],
			toolchainId: "toolchain-1",
			publicValues: { PROJECT_PUBLIC_FEATURE: "on" },
			remoteProject: "daytona-project",
			deliveryOrigin: "https://github.com/acme/widget.git",
			otlpLoopback: true,
		});
		expect(parsed.toolchains["toolchain-1"]).toMatchObject({ manifestSha256: DIGEST, rootfs: "/opt/kit/rootfs" });
		expect(parsed.installation?.node).toBe("/usr/bin/node");
	});

	it("rejects an absent, non-object, or non-v1 profile", () => {
		for (const value of [undefined, null, [], "profile", 1]) {
			expect(parseError(value).code).toBe("invalid-schema");
		}
		expect(parseError({ ...hostProfile(), version: 2 }).code).toBe("invalid-schema");
		expect(parseError({ ...hostProfile(), version: "1" }).code).toBe("invalid-schema");
	});

	it("rejects unknown keys at every recognized level", () => {
		expect(parseError(hostProfile({ secretToken: "x" })).message).toMatch(/unknown top-level key/);
		expect(parseError(hostProfile({ installation: { ...(hostProfile()["installation"] as object), shell: "/bin/sh" } })).message)
			.toMatch(/unknown installation key/);
		const project = { ...((hostProfile()["projects"] as Record<string, unknown>[])[0]!), apiKey: "x" };
		expect(parseError(hostProfile({ projects: [project] })).message).toMatch(/unknown project key/);
		const toolchain = { ...((hostProfile()["toolchains"] as Record<string, object>)["toolchain-1"]!), token: "x" };
		expect(parseError(hostProfile({ toolchains: { "toolchain-1": toolchain } })).message).toMatch(/unknown toolchain key/);
	});

	it("requires canonical absolute project roots and rejects duplicates", () => {
		for (const root of ["srv/project", "/srv/../project", "/srv//project", "/srv/project/", "/srv/\0project", "."]) {
			const project = { ...((hostProfile()["projects"] as Record<string, unknown>[])[0]!), root };
			expect(parseError(hostProfile({ projects: [project] })).code).toBe("unsafe-path");
		}
		const project = (hostProfile()["projects"] as Record<string, unknown>[])[0]!;
		expect(parseError(hostProfile({ projects: [project, { ...project }] })).message).toMatch(/duplicate project root/);
		expect(parseError(hostProfile({ projects: {} })).code).toBe("invalid-schema");
	});

	it("rejects empty, duplicate, or unknown backends", () => {
		for (const backends of [[], ["local", "local"], ["local", "host"], ["docker"], "local"]) {
			const project = { ...((hostProfile()["projects"] as Record<string, unknown>[])[0]!), backends };
			expect(parseError(hostProfile({ projects: [project] })).code).toBe("invalid-schema");
		}
	});

	it("requires a toolchainId and rejects a missing one", () => {
		const project = { ...((hostProfile()["projects"] as Record<string, unknown>[])[0]!) };
		delete (project as Record<string, unknown>)["toolchainId"];
		expect(parseError(hostProfile({ projects: [project] })).message).toMatch(/toolchainId/);
		expect(parseError(hostProfile({ projects: [{ ...project, toolchainId: "" }] })).code).toBe("invalid-schema");
	});

	it("rejects public env names outside the documented positive list", () => {
		const base = (hostProfile()["projects"] as Record<string, unknown>[])[0]!;
		for (const name of ["API_KEY", "PATH", "HOME", "project_public_feature", "PROJECT_PUBLIC_", "PROJECT_PUBLIC-A"]) {
			const project = { ...base, publicValues: { [name]: "on" } };
			expect(parseError(hostProfile({ projects: [project] })).code).toBe("invalid-schema");
		}
	});

	it("rejects oversized, multi-line, NUL, or non-string public values", () => {
		const base = (hostProfile()["projects"] as Record<string, unknown>[])[0]!;
		const cases: unknown[] = [
			{ PROJECT_PUBLIC_A: "x".repeat(129) },
			{ PROJECT_PUBLIC_A: "line\nbreak" },
			{ PROJECT_PUBLIC_A: "NUL\0byte" },
			{ PROJECT_PUBLIC_A: 1 },
			{ PROJECT_PUBLIC_A: true },
			{ PROJECT_PUBLIC_A: " leading" },
			{ PROJECT_PUBLIC_A: "trailing " },
		];
		for (const publicValues of cases) {
			expect(parseError(hostProfile({ projects: [{ ...base, publicValues }] })).code).toBe("invalid-schema");
		}
		const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`PROJECT_PUBLIC_K${i}`, "on"]));
		expect(parseError(hostProfile({ projects: [{ ...base, publicValues: tooMany }] })).code).toBe("invalid-schema");
	});

	it("requires a full lowercase SHA-256 manifest and canonical toolchain paths", () => {
		for (const manifestSha256 of ["", "abc", "A".repeat(64), "g".repeat(64)]) {
			const toolchains = { t: { rootfs: "/opt/kit/rootfs", manifestSha256 } };
			expect(parseError(hostProfile({ toolchains })).code).toBe("invalid-schema");
		}
		for (const rootfs of ["opt/kit/rootfs", "/opt/../rootfs", "/opt//rootfs", "/opt/rootfs/"]) {
			const toolchains = { t: { rootfs, manifestSha256: DIGEST } };
			expect(parseError(hostProfile({ toolchains })).code).toBe("unsafe-path");
		}
	});

	it("rejects a project that references an unknown toolchain", () => {
		expect(parseError(hostProfile({ toolchains: {} })).message).toMatch(/references unknown toolchain/);
	});

	it("validates an optional deliveryOrigin with the shared GitHub parser", () => {
		const base = (hostProfile()["projects"] as Record<string, unknown>[])[0]!;
		for (const deliveryOrigin of ["https://gitlab.com/acme/widget", "http://github.com/acme/widget", "https://github.com/acme/widget?x=1"]) {
			expect(() => parseHostProfile(hostProfile({ projects: [{ ...base, deliveryOrigin }] }))).toThrow();
		}
	});

	it("rejects installation paths that are relative, traversing, UNC, or non-canonical", () => {
		for (const node of ["usr/bin/node", "/usr/../bin/node", "//server/share/node", "/usr//bin/node", "/usr/bin/node/"]) {
			expect(parseError(hostProfile({ installation: { node } })).code).toBe("unsafe-path");
		}
	});
});

describe("host profile file trust", () => {
	async function writeProfile(text: string, mode = 0o600): Promise<string> {
		const root = await tempRoot("kit-host-paths-");
		const path = join(root, "host-v1.json");
		await writeFile(path, text, "utf8");
		await chmod(path, mode);
		return path;
	}

	it("reads a canonical, user-owned, private profile", async () => {
		const path = await writeProfile(JSON.stringify(hostProfile()));
		const parsed = await readHostProfile(path);
		expect(parsed.projects[0]?.root).toBe("/srv/project");
	});

	it("refuses a missing profile rather than treating it as empty", async () => {
		const root = await tempRoot("kit-host-paths-");
		await expect(readHostProfile(join(root, "absent.json"))).rejects.toMatchObject({ code: "not-found" });
	});

	it("refuses a symlinked profile or symlinked ancestor", async () => {
		const path = await writeProfile(JSON.stringify(hostProfile()));
		const link = join(path, "..", "link.json");
		await symlink(path, link);
		await expect(readHostProfile(link)).rejects.toMatchObject({ code: "unsafe-file" });

		const moved = join(await tempRoot("kit-host-paths-"), "real.json");
		await writeFile(moved, JSON.stringify(hostProfile()));
		await chmod(moved, 0o600);
		const dir = await tempRoot("kit-host-paths-");
		const through = join(dir, "parent-link");
		await symlink(join(moved, ".."), through);
		await expect(readHostProfile(join(through, "real.json"))).rejects.toMatchObject({ code: "unsafe-file" });
	});

	it("refuses group/world-readable permissions and oversized files", async () => {
		const loose = await writeProfile(JSON.stringify(hostProfile()), 0o644);
		await expect(readHostProfile(loose)).rejects.toMatchObject({ code: "unsafe-permissions" });

		const big = await writeProfile(`${JSON.stringify(hostProfile())}${" ".repeat(1024 * 1024)}`);
		await expect(readHostProfile(big)).rejects.toMatchObject({ code: "unsafe-file" });
	});

	it("refuses malformed JSON instead of degrading to an empty profile", async () => {
		const path = await writeProfile("{ not json");
		await expect(readHostProfile(path)).rejects.toMatchObject({ code: "invalid-json" });
	});

	it("keeps the M0 delivery-only profile shape working (no silent narrowing)", async () => {
		const root = await tempRoot("kit-host-paths-");
		const projectRoot = join(root, "project");
		await mkdir(projectRoot);
		const path = join(root, "host-v1.json");
		await writeFile(path, JSON.stringify({
			version: 1,
			projects: [{ root: await realpath(projectRoot), deliveryOrigin: "https://github.com/acme/widget" }],
			toolchains: {},
		}), "utf8");
		await chmod(path, 0o600);
		await expect(readApprovedDeliveryOrigin(projectRoot, path)).resolves.toEqual({
			origin: "https://github.com/acme/widget.git",
			repository: "acme/widget",
		});
	});
});

describe("trusted installation policy", () => {
	it("rejects a target-local binary by string containment before any launch", () => {
		expect(() => validateInstallationPath("/srv/project/node_modules/.bin/llm-toolkit-001", {
			targetRoot: "/srv/project",
		})).toThrow(HostProfileError);
		expect(() => validateInstallationPath("/srv/project", { targetRoot: "/srv/project" })).toThrow(HostProfileError);
		expect(() => validateInstallationPath("/srv/project-other/cli.js", { targetRoot: "/srv/project" })).not.toThrow();
	});

	it("accepts a canonical executable and refuses symlinks, writable binaries, and missing paths", async () => {
		const root = await tempRoot("kit-install-");
		const target = join(root, "project");
		await mkdir(target);
		const bin = join(root, "bin");
		await mkdir(bin);
		// Trusted-installation ancestry must not be group/world writable (the
		// process umask can make a fresh directory 0775).
		await chmod(bin, 0o755);
		await chmod(root, 0o755);
		const real = join(bin, "tool");
		await writeFile(real, "#!/bin/sh\nexit 0\n");
		await chmod(real, 0o755);

		await expect(validateTrustedInstallation({ version: 1, installation: { node: real }, projects: [], toolchains: {} }, {
			targetRoot: target,
		})).resolves.toBeUndefined();

		if (typeof process.getuid === "function" && process.getuid() !== 0) {
			await expect(validateTrustedInstallation({ version: 1, installation: { node: real }, projects: [], toolchains: {} }, {
				targetRoot: target,
				uid: process.getuid() + 1,
			})).rejects.toMatchObject({ code: "unsafe-file" });
		}

		const link = join(bin, "link");
		await symlink(real, link);
		await expect(validateTrustedInstallation({ version: 1, installation: { node: link }, projects: [], toolchains: {} }, {
			targetRoot: target,
		})).rejects.toMatchObject({ code: "unsafe-path" });

		await chmod(real, 0o775);
		await expect(validateTrustedInstallation({ version: 1, installation: { node: real }, projects: [], toolchains: {} }, {
			targetRoot: target,
		})).rejects.toMatchObject({ code: "unsafe-file" });

		await expect(validateTrustedInstallation({ version: 1, installation: { node: join(bin, "absent") }, projects: [], toolchains: {} }, {
			targetRoot: target,
		})).rejects.toMatchObject({ code: "not-found" });
	});

	it("refuses a symlinked or writable ancestor and an in-target executable", async () => {
		const root = await tempRoot("kit-install-ancestry-");
		await chmod(root, 0o755);
		const target = join(root, "project");
		await mkdir(target);
		const bin = join(root, "bin");
		await mkdir(bin);
		await chmod(bin, 0o755);
		const real = join(bin, "tool");
		await writeFile(real, "#!/bin/sh\nexit 0\n");
		await chmod(real, 0o755);

		await expect(validateTrustedExecutableFile(real, "node", { targetRoot: target })).resolves.toBe(real);

		const alias = join(root, "bin-alias");
		await symlink(bin, alias);
		await expect(validateTrustedExecutableFile(join(alias, "tool"), "node", { targetRoot: target }))
			.rejects.toMatchObject({ code: "unsafe-path" });

		const group = join(root, "group");
		await mkdir(group);
		await writeFile(join(group, "tool"), "#!/bin/sh\nexit 0\n");
		await chmod(join(group, "tool"), 0o755);
		await chmod(group, 0o775);
		await expect(validateTrustedExecutableFile(join(group, "tool"), "node", { targetRoot: target }))
			.rejects.toMatchObject({ code: "unsafe-file" });

		// The only in-target allowance is the explicit running-entry flag; the
		// plain file validator refuses an in-target path without it.
		await expect(validateTrustedExecutableFile(real, "node", { targetRoot: root }))
			.rejects.toMatchObject({ code: "installation-inside-target" });
		await expect(validateTrustedExecutableFile(real, "node", { targetRoot: root, allowRunningInstallationEntry: true }))
			.resolves.toBe(real);
	});

	it("uses the platform default host profile path, not the target cwd", () => {
		const path = defaultHostProfilePath();
		expect(path).not.toContain("node_modules/.bin");
		if (process.platform === "win32") expect(path).toMatch(/host-v1\.json$/);
		else expect(path).toMatch(/\.config\/llm-toolkit-001\/host-v1\.json$/);
	});
});

// ---------------------------------------------------------------------------
// M1-P01 step (b) — capped, no-follow host reads
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

type Refusal = {
	kind: "refused";
	code: string;
	path: string;
	message: string;
	bytesRead?: number;
};

function refusal(result: SafeReadResult<unknown>): Refusal {
	if (result.kind !== "refused") {
		throw new Error(`expected a refusal, got ${result.kind}: ${JSON.stringify(result).slice(0, 200)}`);
	}
	return result;
}

function okValue<T>(result: SafeReadResult<T>): T {
	if (result.kind !== "ok") {
		throw new Error(`expected ok, got ${result.kind}: ${JSON.stringify(result).slice(0, 200)}`);
	}
	return result.value;
}

async function writeAt(root: string, rel: string, content: string | Uint8Array): Promise<string> {
	const file = join(root, rel);
	await mkdir(join(file, ".."), { recursive: true });
	await writeFile(file, content);
	return file;
}

function deadline<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`operation did not return within ${ms}ms; it may be blocking`)), ms);
		promise.then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error) => { clearTimeout(timer); reject(error); },
		);
	});
}

describe("safe host read path policy", () => {
	it("rejects unsafe relative names and non-canonical roots before opening anything", async () => {
		const root = await tempRoot("kit-safe-read-paths-");
		const unsafePaths = [
			"",
			"/etc/passwd",
			"../outside.txt",
			"docs/../../outside.txt",
			"docs//prd.md",
			"docs/./prd.md",
			"docs/",
			"docs\\prd.md",
			"C:/prd.md",
			"C:\\prd.md",
			"\\\\server\\share\\prd.md",
			"docs/prd.md\0",
			"CON",
			"con.txt",
			"docs/NUL.txt",
			"docs/prd.md.",
			"docs/prd.md ",
			"a/".repeat(2_048) + "x",
		];
		for (const path of unsafePaths) {
			const result = await readSafeFile({ root, path });
			expect(refusal(result).code, `path ${JSON.stringify(path)}`).toBe("unsafe-path");
		}

		for (const badRoot of ["relative/root", `${root}/`, `${root}/../${root.split("/").at(-1)}`, `${root}\0`]) {
			const result = await readSafeFile({ root: badRoot, path: "prd.md" });
			expect(refusal(result).code, `root ${JSON.stringify(badRoot)}`).toBe("unsafe-root");
		}
	});

	it("names the race-safe primitive and refuses on platforms that cannot prove it", () => {
		expect(safeReadPrimitiveStatus("linux")).toMatchObject({ supported: true });
		expect(safeReadPrimitiveStatus("darwin")).toMatchObject({ supported: false });
		expect(safeReadPrimitiveStatus("win32")).toMatchObject({ supported: false });
		if (process.platform === "linux") {
			expect(safeReadPrimitiveStatus()).toMatchObject({ supported: true });
		}
	});
});

describe.skipIf(process.platform !== "linux")("capped no-follow host reads", () => {
	it("reads an ordinary regular file and reports genuine ENOENT as absent", async () => {
		const root = await tempRoot("kit-safe-read-");
		await writeAt(root, "docs/prd.md", "hello world\n");

		expect(okValue(await readSafeFile({ root, path: "docs/prd.md" })).toString("utf8")).toBe("hello world\n");
		expect(okValue(await readSafeText({ root, path: "docs/prd.md" }))).toBe("hello world\n");

		expect(await readSafeFile({ root, path: "docs/missing.md" })).toMatchObject({ kind: "absent" });
		expect(await readSafeFile({ root, path: "missing/prd.md" })).toMatchObject({ kind: "absent" });
		expect(await readSafeFile({ root: join(root, "missing"), path: "prd.md" })).toMatchObject({ kind: "absent" });
		expect(await readSafeText({ root, path: "docs/missing.md" })).toMatchObject({ kind: "absent" });
	});

	it("refuses leaf, ancestor and dangling symlinks without disclosing target bytes", async () => {
		const outside = await tempRoot("kit-safe-outside-");
		await writeFile(join(outside, "secret.txt"), "HOST-SECRET-BYTES");
		const parent = await tempRoot("kit-safe-parent-");
		const root = join(parent, "project");
		await mkdir(root);
		await writeAt(root, "real/inside.txt", "inside-bytes");
		await symlink(join(outside, "secret.txt"), join(root, "leaf.txt"));
		await symlink(outside, join(root, "anc"));
		await symlink(join(root, "missing-target"), join(root, "dangling"));

		for (const path of ["leaf.txt", "anc/secret.txt", "dangling"]) {
			const result = await readSafeFile({ root, path });
			const rejected = refusal(result);
			expect(rejected.code, `path ${path}`).toBe("symlink");
			expect(JSON.stringify(result)).not.toContain("HOST-SECRET-BYTES");
		}

		const ancestor = await openSafeDirectory({ root, path: "anc" });
		expect(refusal(ancestor).code).toBe("symlink");

		// The root itself must be the canonical operator-selected directory, not a
		// symlink alias: a walk from `/` refuses the link component.
		const linkRoot = join(parent, "project-link");
		await symlink(root, linkRoot);
		const viaRootLink = await readSafeFile({ root: linkRoot, path: "real/inside.txt" });
		expect(refusal(viaRootLink).code).toBe("symlink");
		expect(JSON.stringify(viaRootLink)).not.toContain("HOST-SECRET-BYTES");
	});

	it("refuses hard-linked regular files instead of reading an alias (M1-P01 step d)", async () => {
		const outside = await tempRoot("kit-safe-outside-");
		const secret = join(outside, "host-secret.txt");
		await writeFile(secret, "HOST-SECRET-BYTES");
		const root = await tempRoot("kit-safe-read-");
		// A same-owner hard link inside the project path aliases the host file; a
		// symlink would be refused already, so the alias is the only way to reach
		// it without closing the leaf.
		await link(secret, join(root, "aliased.txt"));
		const result = await readSafeFile({ root, path: "aliased.txt" });
		expect(refusal(result).code).toBe("hardlink");
		expect(JSON.stringify(result)).not.toContain("HOST-SECRET-BYTES");

		// An ordinary single-link file is still read normally.
		await writeAt(root, "plain.txt", "plain-bytes");
		expect(okValue(await readSafeText({ root, path: "plain.txt" }))).toBe("plain-bytes");
	});

	it("keeps reading the pinned directory after an ancestor is swapped for a symlink", async () => {
		const root = await tempRoot("kit-safe-read-");
		await writeAt(root, "a/file.txt", "INSIDE-A");
		const outside = await tempRoot("kit-safe-outside-");
		await writeFile(join(outside, "file.txt"), "OUTSIDE-BYTES");

		const pinned = await openSafeDirectory({ root, path: "a" });
		const dir = okValue(pinned);
		try {
			await rename(join(root, "a"), join(root, "a-old"));
			await symlink(outside, join(root, "a"));

			const viaPinnedDir = await dir.openFile("file.txt");
			const file = okValue(viaPinnedDir);
			try {
				expect(okValue(await file.readText())).toBe("INSIDE-A");
			} finally {
				await file.close();
			}

			const fresh = await readSafeFile({ root, path: "a/file.txt" });
			expect(refusal(fresh).code).toBe("symlink");
			expect(JSON.stringify(fresh)).not.toContain("OUTSIDE-BYTES");
		} finally {
			await dir.close();
		}
	});

	it("serves bytes from the pinned leaf FD when the path is replaced mid-read", async () => {
		const root = await tempRoot("kit-safe-read-");
		const longOriginal = "ORIGINAL-CONTENT-1234567890";
		const victim = await writeAt(root, "victim.txt", longOriginal);

		const first = okValue(await openSafeFile({ root, path: "victim.txt" }));
		try {
			await rm(victim);
			await writeFile(victim, "SHORT");
			const read = okValue(await first.readText());
			expect(read).toBe(longOriginal);
			expect(read.length).toBe(longOriginal.length);
			expect(read).not.toBe("SHORT");
		} finally {
			await first.close();
		}

		const shortVictim = await writeAt(root, "victim2.txt", "ORIG");
		const second = okValue(await openSafeFile({ root, path: "victim2.txt" }));
		const replacement = "REPLACEMENT-".repeat(200);
		try {
			await rm(shortVictim);
			await writeFile(shortVictim, replacement);
			const read = okValue(await second.readText());
			expect(read).toBe("ORIG");
			expect(replacement.includes(read)).toBe(false);
			expect(read.length).not.toBe(replacement.length);
		} finally {
			await second.close();
		}

		// The path itself really was replaced: a fresh open sees the new bytes.
		expect(okValue(await readSafeText({ root, path: "victim2.txt" }))).toBe(replacement);
	});

	it("refuses directories, FIFOs, sockets and devices without blocking or reading", async () => {
		const root = await tempRoot("kit-safe-read-");
		await mkdir(join(root, "folder"));
		expect(refusal(await readSafeFile({ root, path: "folder" })).code).toBe("not-regular");

		const fifo = join(root, "pipe");
		await execFileAsync("mkfifo", [fifo]);
		expect(refusal(await deadline(readSafeFile({ root, path: "pipe" }))).code).toBe("not-regular");

		const socketPath = join(root, "sock");
		const server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		try {
			expect(refusal(await deadline(readSafeFile({ root, path: "sock" }))).code).toBe("not-regular");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}

		expect(refusal(await readSafeFile({ root: "/dev", path: "null" })).code).toBe("not-regular");
	});

	it("refuses EACCES and ENOTDIR but never turns them into absence", async () => {
		const root = await tempRoot("kit-safe-read-");
		await writeAt(root, "plain.txt", "plain");
		expect(refusal(await readSafeFile({ root, path: "plain.txt/child" })).code).toBe("not-directory");

		if (typeof process.getuid === "function" && process.getuid() !== 0) {
			const locked = await writeAt(root, "locked.txt", "locked");
			await chmod(locked, 0o000);
			expect(refusal(await readSafeFile({ root, path: "locked.txt" })).code).toBe("unreadable");

			const lockedDir = join(root, "locked-dir");
			await writeAt(root, "locked-dir/inside.txt", "inside");
			await chmod(lockedDir, 0o000);
			try {
				expect(refusal(await readSafeFile({ root, path: "locked-dir/inside.txt" })).code).toBe("unreadable");
			} finally {
				await chmod(lockedDir, 0o700);
			}
		}
	});

	it("refuses malformed text (invalid UTF-8 or NUL) but returns the raw bytes", async () => {
		const root = await tempRoot("kit-safe-read-");
		const invalid = Uint8Array.from([0x66, 0x6f, 0x80, 0x6f]);
		await writeAt(root, "invalid.bin", invalid);
		expect([...okValue(await readSafeFile({ root, path: "invalid.bin" }))]).toEqual([...invalid]);
		expect(refusal(await readSafeText({ root, path: "invalid.bin" })).code).toBe("malformed");

		await writeAt(root, "nul-bytes.txt", "a\0b");
		expect(refusal(await readSafeText({ root, path: "nul-bytes.txt" })).code).toBe("malformed");
		expect(okValue(await readSafeFile({ root, path: "nul-bytes.txt" })).length).toBe(3);
	});

	it("enforces the per-file cap while reading, not after a full-file load", async () => {
		expect(SAFE_READ_LIMITS.maxFileBytes).toBe(32 * 1024 * 1024);
		expect(SAFE_READ_LIMITS.maxContentBytes).toBe(512 * 1024 * 1024);
		expect(SAFE_READ_LIMITS.maxDirectoryEntries).toBe(100_000);

		const root = await tempRoot("kit-safe-read-");
		const sparse = join(root, "huge.bin");
		const handle = await openFileHandle(sparse, "w");
		await handle.truncate(SAFE_READ_LIMITS.maxFileBytes + 1);
		await handle.close();
		const oversize = refusal(await readSafeFile({ root, path: "huge.bin" }));
		expect(oversize.code).toBe("too-large");
		expect(oversize.bytesRead).toBe(0);

		await writeAt(root, "at-cap.bin", Buffer.alloc(1_024, 0x61));
		expect(okValue(await readSafeFile({ root, path: "at-cap.bin", maxBytes: 1_024 })).length).toBe(1_024);
		expect(refusal(await readSafeFile({ root, path: "at-cap.bin", maxBytes: 1_023 })).code).toBe("too-large");

		// The file is small when opened and grows before the read: the cap must be
		// enforced by the read loop rather than by the fstat snapshot.
		await writeAt(root, "grow.bin", "12345678");
		const grow = okValue(await openSafeFile({ root, path: "grow.bin" }));
		try {
			await appendFile(join(root, "grow.bin"), Buffer.alloc(1024 * 1024, 0x62));
			const grown = refusal(await grow.readBytes({ maxBytes: 4_096 }));
			expect(grown.code).toBe("too-large");
			expect(grown.bytesRead).toBeGreaterThan(4_096);
			expect(grown.bytesRead).toBeLessThanOrEqual(4_096 + 64 * 1024);
		} finally {
			await grow.close();
		}
	});

	it("enforces the shared content budget during reads", async () => {
		const root = await tempRoot("kit-safe-read-");
		expect(new SafeReadBudget().maxContentBytes).toBe(SAFE_READ_LIMITS.maxContentBytes);
		expect(() => new SafeReadBudget(SAFE_READ_LIMITS.maxContentBytes + 1)).toThrow();

		const budget = new SafeReadBudget(1_024);
		await writeAt(root, "a.bin", Buffer.alloc(800, 0x61));
		await writeAt(root, "b.bin", Buffer.alloc(800, 0x62));
		expect(okValue(await readSafeFile({ root, path: "a.bin", budget })).length).toBe(800);
		expect(budget.used).toBe(800);

		const second = refusal(await readSafeFile({ root, path: "b.bin", budget }));
		expect(second.code).toBe("content-capped");
		expect(second.bytesRead).toBe(0);
		expect(budget.used).toBe(800);

		await writeAt(root, "grow-budget.bin", "12345678");
		const grow = okValue(await openSafeFile({ root, path: "grow-budget.bin" }));
		try {
			await appendFile(join(root, "grow-budget.bin"), Buffer.alloc(4_096, 0x63));
			const midRead = refusal(await grow.readBytes({ budget }));
			expect(midRead.code).toBe("content-capped");
			expect(midRead.bytesRead).toBeGreaterThan(224);
			expect(budget.used).toBe(800);
		} finally {
			await grow.close();
		}
	});

	it("counts directory entries while walking and refuses past the cap", async () => {
		const root = await tempRoot("kit-safe-read-");
		await writeAt(root, "docs/a.txt", "a");
		await writeAt(root, "docs/b.txt", "b");
		await writeAt(root, "docs/sub/c.txt", "c");
		await writeAt(root, "TOP.md", "top");

		const listing = okValue(await listSafeDirectory({ root, path: "docs" }));
		expect(listing.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(["file:a.txt", "file:b.txt", "directory:sub"]);

		const walk = okValue(await walkSafeFiles({ root, path: "docs" }));
		expect(walk.files).toEqual(["docs/a.txt", "docs/b.txt", "docs/sub/c.txt"]);
		expect(walk.directories).toEqual(["docs/sub"]);

		// The tree has four entries under `docs` (three files plus `sub`). Exactly
		// at the cap is admitted; one past it is a refusal, not a truncation.
		expect(okValue(await walkSafeFiles({ root, path: "docs", maxEntries: 4 })).files).toHaveLength(3);
		expect(refusal(await walkSafeFiles({ root, path: "docs", maxEntries: 3 })).code).toBe("entry-capped");
		expect(refusal(await listSafeDirectory({ root, path: "docs", maxEntries: 2 })).code).toBe("entry-capped");

		await symlink("/etc/passwd", join(root, "docs", "link.txt"));
		const linked = refusal(await walkSafeFiles({ root, path: "docs" }));
		expect(linked.code).toBe("symlink");
		expect(JSON.stringify(linked)).not.toContain("root:");
	});

	it("refuses a non-UTF-8 directory entry name instead of rewriting it", async () => {
		const root = await tempRoot("kit-safe-read-");
		const rawName = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff])]);
		await writeFile(rawName, "bytes");
		expect(refusal(await listSafeDirectory({ root })).code).toBe("unsafe-path");
	});

	it("returns a typed unsupported result when the proc-fd primitive is absent", async () => {
		const root = await tempRoot("kit-safe-read-");
		await writeAt(root, "prd.md", "prd");
		const result = await readSafeFile({ root, path: "prd.md", procFdBase: "/nonexistent-kit/proc/self/fd" });
		expect(refusal(result).code).toBe("unsupported-platform");
	});
});

describe("canonical project root boundary", () => {
	it("resolves an operator-selected root alias once and keeps the canonical directory", async () => {
		const root = await tempRoot("kit-root-boundary-");
		await writeAt(root, "docs/prd.md", "prd");
		const alias = join(root, "alias");
		await symlink(root, alias);
		const resolved = await resolveCanonicalProjectRoot(alias);
		expect(resolved).toBe(root);
		expect(resolved).toBe(await realpath(alias));
		// The canonical root feeds the same no-follow reader: the alias is not
		// re-resolved per read, so a later replacement of the alias cannot matter.
		expect(okValue(await readSafeText({ root: resolved, path: "docs/prd.md" }))).toBe("prd");
	});

	it("refuses a missing, relative or non-normalized root instead of guessing one", async () => {
		const root = await tempRoot("kit-root-boundary-");
		await expect(resolveCanonicalProjectRoot(join(root, "absent"))).rejects.toMatchObject({ code: "not-found" });
		await expect(resolveCanonicalProjectRoot("relative/root")).rejects.toMatchObject({ code: "unsafe-path" });
		await expect(resolveCanonicalProjectRoot(`${root}/`)).rejects.toMatchObject({ code: "unsafe-path" });
	});
});

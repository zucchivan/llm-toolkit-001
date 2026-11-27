import { spawnSync } from "node:child_process";
import archiveFs from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, readFile, writeFile, rm, utimes } from "node:fs/promises";
import stagingFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LeaseLifecycle, type CgroupOps } from "../src/sandbox/lease-lifecycle.ts";
import { prepareLocalBundle, prepareLocalBundleArchive, sealedManifestDigest, validateSealedManifest, validateManifestDelta, validateLocalBundle } from "../src/sandbox/manifest.ts";
import { createTaskControls } from "../src/engine/controls.ts";
import { createGuestStdioStream, parseGuestHelperArgs } from "../src/sandbox/guest-helper-main.ts";
import { PassThrough } from "node:stream";

const leaseId = "b29e52e3-e584-4f14-917c-a1e07c92e754";

describe("standalone guest helper ABI", () => {
	it("admits only the fixed protocol, host lease identity, role, and workspace flags", () => {
		expect(parseGuestHelperArgs(["--protocol=1", `--lease-id=${leaseId}`, "--role=implementer", "--cwd=/work"])).toEqual({
			protocol: 1, leaseId, role: "implementer", cwd: "/work",
		});
		for (const args of [
			["--protocol=2", `--lease-id=${leaseId}`, "--role=implementer", "--cwd=/work"],
			["--protocol=1", `--lease-id=${leaseId}`, "--role=implementer", "--cwd=/tmp"],
			["--protocol=1", `--lease-id=${leaseId}`, "--role=implementer", "--cwd=/work", "--extra=x"],
			["--protocol=1", "--lease-id=not-a-uuid", "--role=implementer", "--cwd=/work"],
		]) expect(() => parseGuestHelperArgs(args)).toThrow();
	});

	it("adapts fragmented stdin and stdout as bounded framed byte streams", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const stream = createGuestStdioStream(input, output);
		await expect(stream.read(Number.MAX_SAFE_INTEGER)).rejects.toThrow(/bounded read/);
		input.write(Buffer.from([1, 2, 3, 4]));
		expect(await stream.read(2)).toEqual(new Uint8Array([1, 2]));
		expect(await stream.read(8)).toEqual(new Uint8Array([3, 4]));
		const receivedPromise = new Promise<Buffer>((resolve) => output.once("data", resolve));
		await stream.write(new Uint8Array([5, 6]));
		const received = await receivedPromise;
		expect(received).toEqual(Buffer.from([5, 6]));
		input.end(); output.destroy();
	});
});

function manifest(path = "src/main.ts", bytes = new TextEncoder().encode("export {}\n")) {
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const files = [{ path, mode: 0o100644 as 0o100644 | 0o100755, bytes, sha256 }];
	const digest = sealedManifestDigest(leaseId, files);
	return { version: 1, leaseId, files, digest };
}

describe("sealed lease manifest", () => {
	it("validates the complete lease-bound file set and copies its bytes", () => {
		const input = manifest();
		const validated = validateSealedManifest(input, leaseId);
		expect(validated.files[0]?.path).toBe("src/main.ts");
		input.files[0]!.bytes[0] = 0;
		expect(validated.files[0]?.bytes[0]).toBe("e".charCodeAt(0));
	});
	it.each(["../outside", "/absolute", "src/../outside", "src/.orch/lock", "src/.git/config", "a\\b"])("refuses unsafe path %s before import", (path) => {
		expect(() => validateSealedManifest(manifest(path), leaseId)).toThrow();
	});
	it("refuses wrong lease, changed bytes, unsupported modes and aggregate limits", () => {
		const value = manifest();
		expect(() => validateSealedManifest(value, "00000000-0000-4000-8000-000000000000")).toThrow(/identity/);
		value.files[0]!.bytes[0] = 0;
		expect(() => validateSealedManifest(value, leaseId)).toThrow(/digest/);
		const mode = manifest() as any; mode.files[0].mode = 0o120777;
		expect(() => validateSealedManifest(mode, leaseId)).toThrow(/mode/);
		const over = manifest("x", new Uint8Array(2));
		expect(() => validateSealedManifest(over, leaseId, { maxTotalBytes: 1 })).toThrow(/limit/);
	});
});

describe("complete manifest inventory and delta", () => {
	function inventory(paths: string[]) {
		const files = paths.map((path) => manifest(path).files[0]!);
		return { version: 1, leaseId, files, digest: sealedManifestDigest(leaseId, files) };
	}
	it("canonicalizes file order with locale-independent ordering", () => {
		const value = inventory(["z.ts", "a.ts", "B.ts"]);
		const result = validateSealedManifest(value, leaseId);
		expect(result.files.map((file) => file.path)).toEqual(["B.ts", "a.ts", "z.ts"]);
		expect(result.digest).toBe(sealedManifestDigest(leaseId, [...value.files].reverse()));
	});
	it.each([
		["src", "src/main.ts"], ["src/main.ts", "src"], ["Src/a.ts", "src/b.ts"],
		["src/Foo", "src/foo/bar.ts"], ["con.txt"], ["a."], ["a".repeat(256)],
	])("rejects impossible or unsafe complete file set %j", (...paths) => {
		expect(() => validateSealedManifest(inventory(paths), leaseId)).toThrow();
	});
	it.each([NaN, -1, Infinity, 0.5, 100_001])("rejects invalid or raised entry cap %s", (maxEntries) => {
		expect(() => validateSealedManifest(inventory([]), leaseId, { maxEntries })).toThrow(/limit/);
	});
	it("accepts exact byte/entry limits and refuses overflow, including implicit directories", () => {
		const value = inventory(["a"]);
		const size = value.files[0]!.bytes.byteLength;
		expect(validateSealedManifest(value, leaseId, { maxEntries: 1, maxFileBytes: size, maxTotalBytes: size }).files).toHaveLength(1);
		expect(() => validateSealedManifest(value, leaseId, { maxFileBytes: size - 1 })).toThrow(/size/);
		expect(() => validateSealedManifest(value, leaseId, { maxTotalBytes: size - 1 })).toThrow(/size/);
		expect(() => validateSealedManifest(inventory(["a", "b"]), leaseId, { maxEntries: 1 })).toThrow(/entry/);
		expect(() => validateSealedManifest(inventory(["a/b"]), leaseId, { maxEntries: 1 })).toThrow(/entry/);
		for (const limits of [{ maxFileBytes: NaN }, { maxFileBytes: 32 * 1024 * 1024 + 1 }, { maxTotalBytes: Infinity }, { maxTotalBytes: 512 * 1024 * 1024 + 1 }]) {
			expect(() => validateSealedManifest(value, leaseId, limits)).toThrow(/limit/);
		}
	});
	it("validates all additions, deletions and mode/content changes using shared controls", () => {
		const controls = createTaskControls({ root: "/project", targetPaths: ["src/"], prdPath: "docs/prd.md" });
		const base = inventory(["src/deleted.ts", "src/mode.ts", "src/content.ts", "docs/prd.md"]);
		const candidate = inventory(["src/added.ts", "src/mode.ts", "src/content.ts", "docs/prd.md"]);
		candidate.files[1]!.mode = 0o100755;
		candidate.files[2] = manifest("src/content.ts", new TextEncoder().encode("changed")).files[0]!;
		candidate.digest = sealedManifestDigest(leaseId, candidate.files);
		expect(validateManifestDelta(base, candidate, leaseId, controls)).toEqual([
			{ path: "src/added.ts", kind: "add" }, { path: "src/content.ts", kind: "modify" },
			{ path: "src/deleted.ts", kind: "delete" }, { path: "src/mode.ts", kind: "modify" },
		]);
		// Hidden paths are not in the projection; absence is not a deletion.
		expect(validateManifestDelta(inventory([]), inventory([]), leaseId, controls)).toEqual([]);
	});
	it.each(["docs/prd.md", "evals/check.sh", "outside.ts"])("refuses protected/out-of-scope deletion of %s", (path) => {
		const controls = createTaskControls({ root: "/project", targetPaths: ["src/"], prdPath: "docs/prd.md" });
		expect(() => validateManifestDelta(inventory([path]), inventory([]), leaseId, controls)).toThrow(/read-only|outside targetPaths/);
	});
	it.each(["docs/prd.md", "evals/check.sh", "outside.ts"])("refuses protected/out-of-scope add and mode changes to %s", (path) => {
		const controls = createTaskControls({ root: "/project", targetPaths: ["src/"], prdPath: "docs/prd.md" });
		const changed = inventory([path]);
		changed.files[0]!.mode = 0o100755;
		changed.digest = sealedManifestDigest(leaseId, changed.files);
		expect(() => validateManifestDelta(inventory([]), changed, leaseId, controls)).toThrow(/read-only|outside targetPaths/);
		expect(() => validateManifestDelta(inventory([path]), changed, leaseId, controls)).toThrow(/read-only|outside targetPaths/);
	});
});

describe("durable lease lifecycle", () => {
	async function fixture() {
		const root = await mkdtemp(join(tmpdir(), "kit-lease-lifecycle-"));
		let exists = false;
		let occupied = false;
		const seen: string[] = [];
		const cgroups: CgroupOps = {
			create: async (path) => { exists = true; seen.push(`create:${path}`); },
			writePid: async (_path, pid) => { occupied = true; seen.push(`attach:${pid}`); },
			kill: async () => { seen.push("kill"); occupied = false; },
			populated: async () => occupied,
			remove: async () => { exists = false; seen.push("remove"); },
		};
		return { root, cgroups, seen, exists: () => exists, cleanup: () => rm(root, { recursive: true, force: true }) };
	}
	const digest = "a".repeat(64);
	async function changeRecord(root: string, id: string, extra: Record<string, unknown>) {
		const file = join(root, `${id}.json`);
		await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), ...extra }));
	}
	it("resumes a kill interrupted in durable fencing without a second launch", async () => {
		const f = await fixture();
		try {
			const lease = await LeaseLifecycle.create(f.root, "implementer", "/delegated", f.cgroups);
			await lease.createCgroup(); await lease.beginLaunch();
			await changeRecord(f.root, lease.record.id, { phase: "fencing" });
			const reopened = await LeaseLifecycle.reopen(f.root, lease.record.id, f.cgroups);
			await reopened.reconcile();
			expect(reopened.record.phase).toBe("fenced");
			expect(f.seen.filter((event) => event === "kill")).toHaveLength(1);
		} finally { await f.cleanup(); }
	});
	it.each(["kill-failed", "still-populated"])("interrupted fencing remains recovery-required when %s", async (failure) => {
		const f = await fixture();
		try {
			const lease = await LeaseLifecycle.create(f.root, "implementer", "/delegated", f.cgroups);
			await lease.createCgroup(); await lease.beginLaunch();
			await changeRecord(f.root, lease.record.id, { phase: "fencing" });
			f.cgroups.kill = async () => { if (failure === "kill-failed") throw new Error("kill failed"); };
			f.cgroups.populated = async () => true;
			const reopened = await LeaseLifecycle.reopen(f.root, lease.record.id, f.cgroups);
			await expect(reopened.fence(0)).rejects.toThrow(/kill|populated/);
			expect(reopened.record.phase).toBe("recovery-required");
			await expect(reopened.beginImport()).rejects.toThrow(/phase/);
			expect((await LeaseLifecycle.reopen(f.root, lease.record.id, f.cgroups)).record.phase).toBe("recovery-required");
		} finally { await f.cleanup(); }
	});
	it.each(["reconcile", "beginImport"] as const)("%s refuses a stale fence and durably blocks import", async (operation) => {
		const f = await fixture();
		try {
			const lease = await LeaseLifecycle.create(f.root, "gate", "/delegated", f.cgroups);
			await lease.createCgroup(); await lease.beginLaunch(); await lease.fence();
			await f.cgroups.writePid(lease.record.cgroupPath, 7777);
			const reopened = await LeaseLifecycle.reopen(f.root, lease.record.id, f.cgroups);
			await expect(reopened[operation]()).rejects.toThrow(/populated/);
			expect(reopened.record.phase).toBe("recovery-required");
			expect((await LeaseLifecycle.reopen(f.root, lease.record.id, f.cgroups)).record.phase).toBe("recovery-required");
		} finally { await f.cleanup(); }
	});
	it.each(["reconcile", "beginImport"] as const)("%s blocks on a missing/unreadable fenced cgroup", async (operation) => {
		const f = await fixture();
		try {
			const lease = await LeaseLifecycle.create(f.root, "gate", "/delegated", f.cgroups);
			await lease.createCgroup(); await lease.beginLaunch(); await lease.fence();
			f.cgroups.populated = async () => { throw new Error("missing cgroup identity"); };
			const reopened = await LeaseLifecycle.reopen(f.root, lease.record.id, f.cgroups);
			await expect(reopened[operation]()).rejects.toThrow(/missing cgroup/);
			expect(reopened.record.phase).toBe("recovery-required");
		} finally { await f.cleanup(); }
	});
	it.each([
		{ cgroupPath: "/delegated/kit-00000000-0000-4000-8000-000000000000" },
		{ cgroupPath: "relative/child" }, { phase: "toString" }, { sequence: -1 },
		{ createdAt: -1 }, { phase: "imported" }, { phase: "imported", manifestDigest: "invalid", resultDigest: digest },
	])("rejects malformed recovery identity before cgroup effects: %j", async (extra) => {
		const f = await fixture();
		try {
			const lease = await LeaseLifecycle.create(f.root, "implementer", "/delegated", f.cgroups);
			await changeRecord(f.root, lease.record.id, extra);
			await expect(LeaseLifecycle.reopen(f.root, lease.record.id, f.cgroups)).rejects.toThrow(/journal/);
			expect(f.seen).toEqual([]);
		} finally { await f.cleanup(); }
	});
	it("reopen after durable intent but before launch proves no cgroup and records not-launched", async () => {
		const f = await fixture();
		try {
			const lease = await LeaseLifecycle.create(f.root, "implementer", "/delegated", f.cgroups);
			const reopened = await LeaseLifecycle.reopen(f.root, lease.record.id, f.cgroups);
			await reopened.reconcile();
			expect(reopened.record.phase).toBe("not-launched");
			expect(f.seen).toEqual([]);
		} finally { await f.cleanup(); }
	});
	it("journals intent before launch and fences an unacknowledged launch after reopen", async () => {
		const f = await fixture();
		try {
			const lease = await LeaseLifecycle.create(f.root, "implementer", "/delegated", f.cgroups);
			expect(lease.record.phase).toBe("intent");
			await lease.createCgroup();
			await lease.beginLaunch();
			const reopened = await LeaseLifecycle.reopen(f.root, lease.record.id, f.cgroups);
			await reopened.reconcile();
			expect(reopened.record.phase).toBe("fenced");
			expect(f.seen).toContain("kill");
		} finally { await f.cleanup(); }
	});
	it("requires an observed empty cgroup before import and never trusts a guest fence claim", async () => {
		const f = await fixture();
		try {
			const lease = await LeaseLifecycle.create(f.root, "gate", "/delegated", f.cgroups);
			await lease.createCgroup(); await lease.beginLaunch(); await lease.attach(4321);
			expect(lease.record.phase).toBe("attached");
			await expect(lease.beginImport()).rejects.toThrow(/phase/);
			await lease.fence();
			expect(lease.record.phase).toBe("fenced");
			await lease.beginImport();
			expect(lease.record.phase).toBe("importing");
		} finally { await f.cleanup(); }
	});
	it("reopen after verified fence preserves the fence and does not import", async () => {
		const f = await fixture();
		try {
			const lease = await LeaseLifecycle.create(f.root, "gate", "/delegated", f.cgroups);
			await lease.createCgroup(); await lease.beginLaunch(); await lease.attach(4324); await lease.fence();
			const reopened = await LeaseLifecycle.reopen(f.root, lease.record.id, f.cgroups);
			await reopened.reconcile();
			expect(reopened.record.phase).toBe("fenced");
			expect(reopened.record.manifestDigest).toBeUndefined();
		} finally { await f.cleanup(); }
	});
	it("keeps import-without-result-receipt recovery-required after reopen", async () => {
		const f = await fixture();
		try {
			const lease = await LeaseLifecycle.create(f.root, "implementer", "/delegated", f.cgroups);
			await lease.createCgroup(); await lease.beginLaunch(); await lease.attach(4322); await lease.fence(); await lease.beginImport();
			const killsBeforeReopen = f.seen.filter((item) => item === "kill").length;
			const reopened = await LeaseLifecycle.reopen(f.root, lease.record.id, f.cgroups);
			await reopened.reconcile();
			expect(reopened.record.phase).toBe("recovery-required");
			expect(reopened.record.recoveryReason).toMatch(/same sealed bytes/);
			expect(f.seen.filter((item) => item === "kill").length).toBe(killsBeforeReopen);
		} finally { await f.cleanup(); }
	});
	it("reconciles the same imported result receipt without launching again", async () => {
		const f = await fixture();
		try {
			const lease = await LeaseLifecycle.create(f.root, "implementer", "/delegated", f.cgroups);
			await lease.createCgroup(); await lease.beginLaunch(); await lease.attach(4323); await lease.fence(); await lease.beginImport(); await lease.recordImported(digest, digest);
			const reopened = await LeaseLifecycle.reopen(f.root, lease.record.id, f.cgroups);
			await reopened.reconcile();
			expect(reopened.record.phase).toBe("complete");
			expect(f.seen.filter((item) => item.startsWith("attach:")).length).toBe(1);
		} finally { await f.cleanup(); }
	});
});

function testBundle() {
	// These are synthetic identities and payloads. No entry is a usable asset pin.
	const roles = [
		["guest/bin/node", "node", 0o755],
		["guest/bin/sh", "shell", 0o755],
		["guest/bin/test-tool", "utility", 0o755],
		["guest/etc/test-config", "rootfs", 0o644],
		["guest/lib/ld-test.so", "loader", 0o755],
		["guest/lib/libtest.so", "library", 0o644],
		["guest/opt/helper/main.js", "helper", 0o644],
		["guest/opt/helper/support.js", "helper-import", 0o644],
		["host/bwrap", "bwrap", 0o755],
		["host/launcher", "launcher", 0o755],
	] as const;
	const assets = roles.map(([path, , mode]) => ({
		path, kind: "file" as const, mode, bytes: Buffer.from(`synthetic ${path}`),
	}));
	const manifest = {
		abi: { guest: "gnu", guestGlibc: "2.38", guestProtocol: 1, host: "gnu", hostMinGlibc: "2.37", launcherProtocol: 1 },
		bundleVersion: "0.0.1",
		files: roles.map(([path, role, mode], index) => ({
			mode, path, role, sha256: bundleSha256(assets[index]!.bytes),
			size: assets[index]!.bytes.byteLength, source: "test-source",
		})),
		platform: "linux-x64",
		releaseSource: "test-source",
		schemaVersion: 1,
		sources: [{
			evidence: {
				method: "signed-release", sha256: bundleSha256("synthetic evidence"),
				signer: "test-only-key", uri: "https://bundle.example.invalid/test-0.0.1.sig",
			},
			id: "test-source", sha256: bundleSha256("synthetic source"),
			uri: "https://bundle.example.invalid/test-0.0.1.tar", version: "0.0.1",
		}],
	};
	return { manifest, assets };
}

function bundleSha256(bytes: string | Uint8Array) {
	return createHash("sha256").update(bytes).digest("hex");
}

function admitTestBundle(bytes: Uint8Array, assets: ReturnType<typeof testBundle>["assets"], pin = bundleSha256(bytes)) {
	return validateLocalBundle(bytes, assets, { bundleVersion: "0.0.1", manifestSha256: pin });
}

describe("offline local bundle validator", () => {
	it("admits exact canonical bytes and refuses a different manifest anchor", () => {
		const { manifest, assets } = testBundle();
		const canonical = Buffer.from(JSON.stringify(manifest) + "\n");
		const pin = bundleSha256(canonical);
		expect(admitTestBundle(canonical, [...assets].reverse(), pin)).toEqual(manifest);
		expect(() => admitTestBundle(canonical, assets, "0".repeat(64))).toThrow(/manifestSha256/);
		expect(() => admitTestBundle(Buffer.concat([canonical, Buffer.from(" ")]), assets, pin)).toThrow(/manifestSha256/);
	});
});

function bundleBytes(manifest: unknown) {
	return Buffer.from(JSON.stringify(manifest, (_key, value) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
			: value,
	) + "\n");
}

describe("local bundle manifest admission", () => {
	it("rejects alternate encodings even when their digest is pinned", () => {
		const { manifest, assets } = testBundle();
		const json = JSON.stringify(manifest);
		for (const alternate of [
			json, json + "\r\n", JSON.stringify(manifest, null, 2) + "\n",
			json.replace('"platform":', '"platform":"linux-x64","platform":') + "\n",
			json.replace('"schemaVersion":1', '"schemaVersion":1e0') + "\n",
			json.replace('"platform"', '"plat\\u0066orm"') + "\n",
			JSON.stringify({ ...manifest, unexpected: 0 }) + "\n",
		]) expect(() => admitTestBundle(Buffer.from(alternate), assets)).toThrow(/canonical|fields/);
		const { abi, ...rest } = manifest;
		expect(() => admitTestBundle(Buffer.from(JSON.stringify({ ...rest, abi }) + "\n"), assets)).toThrow(/canonical/);
	});

	it("refuses invalid or unsupported schema, selection, platform and ABI before consulting assets", () => {
		const { manifest, assets } = testBundle();
		const untouched = new Proxy(assets, {
			get() { throw new Error("asset inventory was consulted"); },
		});
		for (const [change, message] of [
			[{ schemaVersion: 2 }, /schema version/],
			[{ bundleVersion: "latest" }, /explicit selection/],
			[{ platform: "linux-arm64" }, /platform/],
			[{ abi: { ...manifest.abi, guest: "musl" } }, /ABI/],
			[{ abi: { ...manifest.abi, hostMinGlibc: "latest" } }, /ABI/],
			[{ abi: { ...manifest.abi, launcherProtocol: 2 } }, /ABI/],
			[{ abi: { ...manifest.abi, guestProtocol: 2 } }, /ABI/],
			[{ unexpected: true }, /fields/],
		] as const) {
			expect(() => admitTestBundle(bundleBytes({ ...manifest, ...change }), untouched)).toThrow(message);
		}
		const bytes = bundleBytes(manifest);
		expect(() => validateLocalBundle(bytes, untouched, {
			bundleVersion: "0.0.2", manifestSha256: bundleSha256(bytes),
		})).toThrow(/explicit selection/);
		for (const invalid of [Buffer.from("{"), Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])]) {
			expect(() => admitTestBundle(invalid, untouched)).toThrow(/UTF-8 JSON/);
		}
		expect(() => admitTestBundle(Buffer.alloc(4 * 1024 * 1024 + 1), untouched)).toThrow(/byte limit/);
	});
});

describe("local bundle inventory and provenance", () => {
	it("rejects unsafe paths, collisions, invalid modes, missing closure and host/guest overlap", () => {
		const { manifest, assets } = testBundle();
		const files = manifest.files;
		const sample = files[0]!;
		const expectFilesRefused = (next: unknown[], reason: RegExp) => {
			expect(() => admitTestBundle(bundleBytes({ ...manifest, files: next }), assets)).toThrow(reason);
		};
		for (const path of ["/guest/a", "guest/../outside", "guest//a", "guest/./a", "guest/a/", "guest/a\\b", "guest/" + "a".repeat(256)]) {
			expectFilesRefused([{ ...sample, path }, ...files.slice(1)], /unsafe path/);
		}
		const withExtra = (extra: Record<string, unknown>) => [...files, { ...sample, role: "rootfs", ...extra }]
			.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
		expectFilesRefused(withExtra({ path: sample.path }), /duplicate/);
		expectFilesRefused(withExtra({ path: "guest/bin" }), /colliding paths/);
		expectFilesRefused(withExtra({ path: "guest/Bin/extra" }), /colliding paths/);
		expectFilesRefused(withExtra({ path: "guest/opt/other-node", role: "node" }), /exactly one node/);
		expectFilesRefused([...files].reverse(), /ordered/);
		expectFilesRefused(files.filter((file) => file.role !== "helper-import"), /helper-import/);
		expectFilesRefused(files.filter((file) => file.role !== "bwrap"), /bwrap/);
		expectFilesRefused([{ ...sample, mode: 0o4755 }, ...files.slice(1)], /mode/);
		expectFilesRefused([{ ...sample, mode: 0o644 }, ...files.slice(1)], /mode/);
		expectFilesRefused([{ ...sample, size: "123" }, ...files.slice(1)], /size/);
		expectFilesRefused([{ ...sample, size: 256 * 1024 * 1024 + 1 }, ...files.slice(1)], /size/);
		expectFilesRefused(files.map((file) => ({ ...file, size: 256 * 1024 * 1024 })), /total size/);
		expectFilesRefused(withExtra({ path: "guest/opt/host", role: "launcher" }), /host\/guest/);
		expectFilesRefused(withExtra({ path: "guest/opt/host", sha256: files.at(-1)!.sha256 }), /host-only bytes/);
		expectFilesRefused(withExtra({ path: "guest/opt/deps", role: "dependency", lockfile: "guest/missing.lock" }), /lockfile/);
		expectFilesRefused(Array.from({ length: 16_385 }, () => ({})), /file count/);
		expectFilesRefused([{ ...sample, source: "missing" }, ...files.slice(1)], /source/);
		expectFilesRefused([{ ...sample, sha256: "XYZ" }, ...files.slice(1)], /SHA-256/);
	});

	it("requires a pinned release source and per-asset provenance with independent evidence", () => {
		const { manifest, assets } = testBundle();
		const source = manifest.sources[0]!;
		for (const [change, reason] of [
			[{ releaseSource: "missing" }, /release source/],
			[{ sources: [{ ...source, version: "latest" }] }, /exact source version/],
			[{ sources: [{ ...source, version: "0.0.2" }] }, /release source/],
			[{ sources: [{ ...source, uri: "https://user:pass@bundle.example.invalid/source" }] }, /source URI/],
			[{ sources: [{ ...source, uri: "https://bundle.example.invalid/releases/latest/file.tar" }] }, /source URI/],
			[{ sources: [{ ...source, evidence: { ...source.evidence, uri: "https://bundle.example.invalid/releases/%6catest/signature" } }] }, /authenticity evidence/],
			[{ sources: [{ ...source, evidence: { ...source.evidence, method: "hash-only" } }] }, /authenticity evidence/],
			[{ sources: [{ ...source, evidence: { ...source.evidence, uri: source.uri } }] }, /authenticity evidence/],
			[{ sources: [{ ...source, evidence: undefined }] }, /source fields/],
		] as const) {
			expect(() => admitTestBundle(bundleBytes({ ...manifest, ...change }), assets)).toThrow(reason);
		}
	});
});

describe("local bundle materialized bytes", () => {
	it("refuses missing, extra, duplicate, substituted and incorrectly typed file observations", () => {
		const { manifest, assets } = testBundle();
		const canonical = bundleBytes(manifest);
		const [first, ...rest] = assets;
		const sparse = new Array<(typeof assets)[number]>(assets.length);
		const empty: typeof assets = [];
		sparse[Symbol.iterator] = empty[Symbol.iterator].bind(empty);
		expect(() => admitTestBundle(canonical, sparse)).toThrow(/file observation/);
		for (const [observed, reason] of [
			[rest, /inventory count/],
			[[...assets, { ...first!, path: "guest/extra" }], /inventory count/],
			[[rest[0]!, ...rest], /unexpected or duplicate/],
			[[{ ...first!, path: "guest/extra" }, ...rest], /unexpected or duplicate/],
			[[{ ...first!, mode: 0o644 }, ...rest], /file mode/],
			[[{ ...first!, bytes: Buffer.alloc(0) }, ...rest], /file size/],
			[[{ ...first!, bytes: Buffer.alloc(first!.bytes.length, 0x41) }, ...rest], /file SHA-256/],
		] as const) {
			expect(() => validateLocalBundle(canonical, observed, {
				bundleVersion: manifest.bundleVersion, manifestSha256: bundleSha256(canonical),
			})).toThrow(reason);
		}
		for (const bad of [
			{ ...first!, kind: "symlink" }, { ...first!, kind: "directory" },
			{ ...first!, bytes: first!.bytes.toString() },
			{ ...first!, bytes: new Uint8Array(new SharedArrayBuffer(first!.bytes.length)) },
		]) {
			const untrusted = [bad, ...rest] as unknown as typeof assets;
			expect(() => admitTestBundle(canonical, untrusted)).toThrow(/file observation/);
		}
	});

	it("binds a dependency and its lockfile without changing caller-owned input", () => {
		const { manifest, assets } = testBundle();
		const lockfile = "guest/opt/test.lock";
		const dependencies = [["guest/opt/test-dependency", "dependency"], [lockfile, "lockfile"]] as const;
		const dependencyFiles = dependencies.map(([path, role]) => {
			const bytes = Buffer.from(`synthetic ${role}`);
			assets.push({ path, kind: "file", mode: 0o644, bytes });
			return { mode: 0o644, path, role, sha256: bundleSha256(bytes), size: bytes.length, source: "test-source",
				...(role === "dependency" ? { lockfile } : {}) };
		});
		const files = [...manifest.files, ...dependencyFiles].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
		const withDependencies = { ...manifest, files };
		const canonical = bundleBytes(withDependencies);
		const snapshot = bundleSha256(canonical);
		const assetDigests = assets.map((asset) => bundleSha256(asset.bytes));
		expect(admitTestBundle(canonical, assets, snapshot)).toEqual(withDependencies);
		const originalLock = assets.at(-1)!;
		const wrongBytes = Buffer.from(originalLock.bytes).fill(0);
		const wrongDigest = bundleSha256(wrongBytes);
		expect(() => admitTestBundle(canonical, [...assets.slice(0, -1), { ...originalLock, bytes: wrongBytes }], snapshot))
			.toThrow(/file SHA-256/);
		expect(bundleSha256(wrongBytes)).toBe(wrongDigest);
		expect(bundleSha256(canonical)).toBe(snapshot);
		expect(assets.map((asset) => bundleSha256(asset.bytes))).toEqual(assetDigests);
	});
});

describe("offline local bundle preparation", () => {
	it("retains the exact selected manifest and payload bytes in a private stage", async () => {
		const { manifest, assets } = testBundle();
		const bytes = bundleBytes(manifest);
		const selection = { bundleVersion: manifest.bundleVersion, manifestSha256: bundleSha256(bytes) };
		const expectedSelection = { ...selection };
		const expectedManifest = Buffer.from(bytes);
		const expectedAssets = assets.map((asset) => ({ ...asset, bytes: Buffer.from(asset.bytes) }));
		const preparation = prepareLocalBundle(bytes, [...assets].reverse(), selection);
		bytes.fill(0);
		assets.forEach((asset) => asset.bytes.fill(0));
		selection.bundleVersion = "0.0.2";
		selection.manifestSha256 = "0".repeat(64);
		const stage = await preparation;
		try {
			expect(stage.selection).toEqual(expectedSelection);
			expect((await lstat(stage.directory)).mode & 0o777).toBe(0o700);
			const manifestPath = join(stage.directory, "manifest.json");
			expect((await lstat(manifestPath)).mode & 0o777).toBe(0o600);
			expect(await readFile(manifestPath)).toEqual(expectedManifest);
			for (const asset of expectedAssets) {
				const path = join(stage.directory, asset.path);
				const stat = await lstat(path);
				expect(stat.isFile()).toBe(true);
				expect(stat.nlink).toBe(1);
				expect(stat.mode & 0o7777).toBe(asset.mode);
				expect(await readFile(path)).toEqual(asset.bytes);
			}
		} finally {
			await rm(stage.directory, { recursive: true, force: true });
		}
	});

	it("keeps independently selected versions side by side", async () => {
		const { manifest, assets } = testBundle();
		const firstBytes = bundleBytes(manifest);
		const secondVersion = "0.0.2";
		const secondBytes = bundleBytes({
			...manifest, bundleVersion: secondVersion,
			sources: manifest.sources.map((source) => ({ ...source, version: secondVersion })),
		});
		const first = await prepareLocalBundle(firstBytes, assets, {
			bundleVersion: manifest.bundleVersion, manifestSha256: bundleSha256(firstBytes),
		});
		try {
			const second = await prepareLocalBundle(secondBytes, assets, {
				bundleVersion: secondVersion, manifestSha256: bundleSha256(secondBytes),
			});
			try {
				expect(second.directory).not.toBe(first.directory);
				expect(await readFile(join(first.directory, "manifest.json"))).toEqual(firstBytes);
				expect(await readFile(join(second.directory, "manifest.json"))).toEqual(secondBytes);
			} finally {
				await rm(second.directory, { recursive: true, force: true });
			}
		} finally {
			await rm(first.directory, { recursive: true, force: true });
		}
	});

	it("refuses invalid selection and material before allocating staging", async () => {
		const { manifest, assets } = testBundle();
		const bytes = bundleBytes(manifest);
		const selection = { bundleVersion: manifest.bundleVersion, manifestSha256: bundleSha256(bytes) };
		const [first, ...rest] = assets;
		const createStage = vi.spyOn(stagingFs, "mkdtemp");
		try {
			await expect(prepareLocalBundle(bytes, assets, { ...selection, bundleVersion: "0.0.2" }))
				.rejects.toThrow(/explicit selection/);
			await expect(prepareLocalBundle(bytes, assets, { ...selection, manifestSha256: "0".repeat(64) }))
				.rejects.toThrow(/manifestSha256/);
			for (const [file, reason] of [
				[{ ...manifest.files[0]!, path: "guest/../../outside" }, /unsafe path/],
				[{ ...manifest.files[0]!, size: 256 * 1024 * 1024 + 1 }, /file size/],
			] as const) {
				const changed = bundleBytes({ ...manifest, files: [file, ...manifest.files.slice(1)] });
				await expect(prepareLocalBundle(changed, assets, { ...selection, manifestSha256: bundleSha256(changed) }))
					.rejects.toThrow(reason);
			}
			for (const [observed, reason] of [
				[rest, /inventory count/],
				[[{ ...first!, path: "../outside" }, ...rest], /unexpected/],
				[[{ ...first!, bytes: undefined }, ...rest], /file observation/],
				[[{ ...first!, bytes: Buffer.alloc(first!.bytes.length) }, ...rest], /file SHA-256/],
				...["symlink", "hardlink", "fifo", "directory"].map((kind) =>
					[[{ ...first!, kind }, ...rest], /file observation/] as const),
			] as const) {
				await expect(prepareLocalBundle(bytes, observed as typeof assets, selection)).rejects.toThrow(reason);
			}
			const longerBytes = Buffer.concat([first!.bytes, Buffer.from("x")]);
			Object.defineProperty(longerBytes, "byteLength", { value: first!.bytes.length });
			const wrongSize = bundleBytes({
				...manifest, files: [
					{ ...manifest.files[0]!, sha256: bundleSha256(longerBytes) },
					...manifest.files.slice(1),
				],
			});
			const preparation = prepareLocalBundle(wrongSize, [{ ...first!, bytes: longerBytes }, ...rest], {
				...selection, manifestSha256: bundleSha256(wrongSize),
			});
			await expect(preparation.then(async (stage) => {
				await rm(stage.directory, { recursive: true, force: true });
			})).rejects.toThrow(/file size/);
			expect(createStage).not.toHaveBeenCalled();
		} finally {
			createStage.mockRestore();
		}
	});

	it.each(["guest/bin/sh", "manifest.json"])("discards staging when interrupted while opening %s", async (interruptedPath) => {
		const { manifest, assets } = testBundle();
		const bytes = bundleBytes(manifest);
		const selection = { bundleVersion: manifest.bundleVersion, manifestSha256: bundleSha256(bytes) };
		const interruption = new AbortController();
		const reason = new Error("synthetic staging interruption");
		const originalOpen = stagingFs.open;
		let directory: string | undefined;
		let retained: Buffer | undefined;
		const open = vi.spyOn(stagingFs, "open").mockImplementation(async (path, flags, mode) => {
			if (typeof path === "string" && path.endsWith("/" + interruptedPath)) {
				directory = path.slice(0, -interruptedPath.length - 1);
				retained = await readFile(join(directory, "guest/bin/node"));
				interruption.abort(reason);
			}
			return originalOpen(path, flags, mode);
		});
		try {
			await expect(prepareLocalBundle(bytes, assets, selection, interruption.signal)).rejects.toBe(reason);
			expect(retained).toEqual(assets[0]!.bytes);
			expect(directory).toBeDefined();
			await expect(lstat(directory!)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			open.mockRestore();
			if (directory) await rm(directory, { recursive: true, force: true });
		}
	});
});

const TAR_BLOCK = 512;

function tarHeader(path: string, size: number, mode = 0o644, type = "0") {
	const header = Buffer.alloc(TAR_BLOCK);
	const octal = (value: number, offset: number, width: number) =>
		header.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, width, "ascii");
	const split = path.length > 100 ? path.lastIndexOf("/") : -1;
	if (split !== -1) header.write(path.slice(0, split), 345, 155, "latin1");
	header.write(path.slice(split + 1), 0, 100, "latin1");
	octal(mode, 100, 8);
	octal(0, 108, 8);
	octal(0, 116, 8);
	octal(size, 124, 12);
	octal(0, 136, 12);
	header.write(type, 156, 1, "ascii");
	header.write("ustar\0" + "00", 257, 8, "ascii");
	tarChecksum(header);
	return header;
}

function tarChecksum(header: Buffer) {
	header.fill(0x20, 148, 156);
	const checksum = header.reduce((sum, byte) => sum + byte, 0);
	header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
}

function tarEntry(path: string, bytes: Buffer, mode = 0o644) {
	return Buffer.concat([tarHeader(path, bytes.length, mode), bytes,
		Buffer.alloc((TAR_BLOCK - bytes.length % TAR_BLOCK) % TAR_BLOCK)]);
}

function archiveBundle() {
	const { manifest, assets } = testBundle();
	const bytes = bundleBytes(manifest);
	const selection = { bundleVersion: manifest.bundleVersion, manifestSha256: bundleSha256(bytes) };
	const manifestEntry = tarEntry("manifest.json", bytes);
	const payloads = assets.map(({ path, bytes, mode }) => tarEntry(path, bytes, mode));
	return { bytes, selection, manifestEntry, assets, payloads };
}

function tarArchive(...entries: Buffer[]) {
	return Buffer.concat([...entries, Buffer.alloc(2 * TAR_BLOCK)]);
}

async function withArchive(bytes: Buffer, run: (fd: number, directory: string) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "kit-test-archive-"));
	try {
		const path = join(directory, "bundle.tar");
		await writeFile(path, bytes);
		const archive = await open(path, "r");
		try {
			await run(archive.fd, directory);
		} finally {
			await archive.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe("offline local bundle archive", () => {
	async function refuse(archive: Buffer, reason: RegExp, selection = archiveBundle().selection) {
		await withArchive(archive, async (fd, directory) => {
			const stage = vi.spyOn(stagingFs, "mkdtemp");
			try {
				await expect(prepareLocalBundleArchive(fd, selection)).rejects.toThrow(reason);
				expect(stage).not.toHaveBeenCalled();
				expect(await stagingFs.readdir(directory)).toEqual(["bundle.tar"]);
				expect(await readFile(join(directory, "bundle.tar"))).toEqual(archive);
			} finally {
				stage.mockRestore();
			}
		});
	}

	it.each(["../outside", "/outside", "guest//x", "guest/./x", "guest/.Git/x", "guest/x/", "guest/\\x"])(
		"refuses unsafe paths before staging (%s)", async (path) => {
			await refuse(tarArchive(tarHeader(path, 0)), /unsafe path/);
		},
	);

	it.each([
		["guest/bin/x", "guest/bin/x"],
		["guest/bin/x", "guest/bin/X"],
		["guest/Bin/x", "guest/bin/y"],
		["guest/bin", "guest/bin/x"],
		["guest/bin/x", "guest/bin"],
		["manifest.json", "manifest.json"],
	])("refuses colliding or duplicate paths (%s, %s)", async (first, second) => {
		await refuse(tarArchive(tarHeader(first, 0), tarHeader(second, 0)), /duplicate or colliding/);
	});

	it.each(["1", "2", "3", "4", "5", "6", "7", "x", "g", "L", "S"])(
		"refuses unsupported archive entry type %s", async (kind) => {
			await refuse(tarArchive(tarHeader("guest/file", 0, 0o644, kind)), /entry type or link/);
		},
	);

	it("refuses hidden link data, special modes and invalid header encodings", async () => {
		const link = tarHeader("guest/file", 0);
		link.write("outside", 157);
		tarChecksum(link);
		const numeric = tarHeader("guest/file", 0);
		numeric[124] = 0x80;
		tarChecksum(numeric);
		const text = tarHeader("guest/file", 0);
		text[20] = 0xff;
		tarChecksum(text);
		const checksum = tarHeader("guest/file", 0);
		checksum[0] = 0xff;
		for (const [header, reason] of [
			[link, /entry type or link/],
			[tarHeader("guest/file", 0, 0o4755), /file mode/],
			[numeric, /numeric field/],
			[text, /text field/],
			[checksum, /checksum/],
			[Buffer.alloc(TAR_BLOCK, 1), /ustar header/],
		] as const) await refuse(tarArchive(header), reason);
	});

	it("refuses truncated bodies, incomplete terminators, nonzero padding and trailing data", async () => {
		const body = tarEntry("guest/file", Buffer.from("data"));
		const complete = tarArchive(body);
		const badPadding = Buffer.from(complete);
		badPadding[TAR_BLOCK + 4] = 1;
		for (const [archive, reason] of [
			[complete.subarray(0, -1), /archive length/],
			[tarArchive(tarHeader("guest/file", 1024)), /truncated/],
			[complete.subarray(0, -TAR_BLOCK), /truncated/],
			[badPadding, /padding/],
			[Buffer.concat([complete, Buffer.alloc(TAR_BLOCK)]), /trailing data/],
			[Buffer.concat([complete.subarray(0, -TAR_BLOCK), Buffer.alloc(TAR_BLOCK, 1)]), /terminator/],
		] as const) await refuse(archive, reason);
	});

	it("checks archive, entry, manifest and file caps before materializing payloads", async () => {
		await refuse(tarArchive(tarHeader("manifest.json", 4 * 1024 ** 2 + 1)), /manifest size limit/);
		await refuse(tarArchive(tarHeader("guest/file", 256 * 1024 ** 2 + 1)), /file size limit/);
		const entries = Array.from({ length: 16_385 }, (_, index) => tarHeader("guest/file-" + index, 0));
		await refuse(tarArchive(...entries), /entry limit/);
		const fanout = Array.from({ length: 16_384 }, (_, index) => tarHeader(`guest/a${index}/b/c/d/file`, 0));
		await refuse(tarArchive(...fanout), /path count exceeds/);
	}, 15_000);

	it("refuses sparse archives that overflow aggregate or raw archive bytes", async () => {
		await withArchive(Buffer.alloc(0), async (fd, directory) => {
			const stage = vi.spyOn(stagingFs, "mkdtemp");
			const read = vi.spyOn(archiveFs, "read");
			const file = await open(join(directory, "bundle.tar"), "r+");
			try {
				const maxFile = 256 * 1024 ** 2;
				for (let i = 0; i < 9; i++) {
					await file.write(tarHeader("guest/file-" + i, i === 8 ? 1 : maxFile), 0, TAR_BLOCK, i * (maxFile + TAR_BLOCK));
				}
				await file.truncate(2 * 1024 ** 3 + 12 * TAR_BLOCK);
				await expect(prepareLocalBundleArchive(fd, archiveBundle().selection)).rejects.toThrow(/total size limit/);
				expect(read).toHaveBeenCalledTimes(9);
				read.mockClear();
				await file.truncate(3 * 1024 ** 3);
				await expect(prepareLocalBundleArchive(fd, archiveBundle().selection)).rejects.toThrow(/archive byte limit/);
				expect(read).not.toHaveBeenCalled();
				expect(stage).not.toHaveBeenCalled();
			} finally {
				await file.close();
				read.mockRestore();
				stage.mockRestore();
			}
		});
	});

	it("requires every pinned payload and refuses substituted bytes and selection", async () => {
		const { manifestEntry, payloads, selection, assets } = archiveBundle();
		const good = tarArchive(manifestEntry, ...payloads);
		await refuse(tarArchive(...payloads), /missing manifest/);
		await refuse(tarArchive(manifestEntry, ...payloads.slice(1)), /inventory count/);
		await refuse(tarArchive(manifestEntry, ...payloads, tarHeader("guest/extra", 0)), /inventory count/);
		const first = assets[0]!;
		await refuse(tarArchive(manifestEntry, tarEntry("guest/other", first.bytes, first.mode), ...payloads.slice(1)), /unexpected/);
		await refuse(tarArchive(manifestEntry, tarEntry(first.path, first.bytes), ...payloads.slice(1)), /file mode/);
		await refuse(tarArchive(manifestEntry, tarEntry(first.path, Buffer.alloc(0), first.mode), ...payloads.slice(1)), /file size/);
		const substitute = tarEntry(first.path, Buffer.alloc(first.bytes.length), first.mode);
		await refuse(tarArchive(manifestEntry, substitute, ...payloads.slice(1)), /file SHA-256/);
		await refuse(good, /explicit selection/, { ...selection, bundleVersion: "0.0.2" });
		await refuse(good, /manifestSha256/, { ...selection, manifestSha256: "0".repeat(64) });
	});

	it("interrupts a real archive read before preparing or writing", async () => {
		const { manifestEntry, payloads, selection } = archiveBundle();
		await withArchive(tarArchive(manifestEntry, ...payloads), async (fd, directory) => {
			const cancel = new AbortController();
			const reason = new Error("synthetic archive intake interruption");
			const original = archiveFs.read;
			const read = vi.spyOn(archiveFs, "read").mockImplementation((descriptor, buffer, offset, size, position, callback) =>
				original(descriptor, buffer, offset, size, position, (error, count, bytes) => {
					cancel.abort(reason);
					callback(error, count, bytes);
				}),
			);
			const stage = vi.spyOn(stagingFs, "mkdtemp");
			try {
				await expect(prepareLocalBundleArchive(fd, selection, cancel.signal)).rejects.toBe(reason);
				expect(read).toHaveBeenCalledTimes(1);
				expect(stage).not.toHaveBeenCalled();
				expect(await stagingFs.readdir(directory)).toEqual(["bundle.tar"]);
			} finally {
				read.mockRestore();
				stage.mockRestore();
			}
		});
	});

	it("refuses an archive whose metadata changes after a real read", async () => {
		const { manifestEntry, payloads, selection } = archiveBundle();
		await withArchive(tarArchive(manifestEntry, ...payloads), async (fd, directory) => {
			const original = archiveFs.read;
			const read = vi.spyOn(archiveFs, "read").mockImplementationOnce((descriptor, buffer, offset, size, position, callback) =>
				original(descriptor, buffer, offset, size, position, (error, count, bytes) => {
					utimes(join(directory, "bundle.tar"), 0, 0).then(
						() => callback(error, count, bytes),
						(failure) => callback(failure, count, bytes),
					);
				}),
			);
			const stage = vi.spyOn(stagingFs, "mkdtemp");
			try {
				await expect(prepareLocalBundleArchive(fd, selection)).rejects.toThrow(/changed during intake/);
				expect(stage).not.toHaveBeenCalled();
				expect(await stagingFs.readdir(directory)).toEqual(["bundle.tar"]);
			} finally {
				read.mockRestore();
				stage.mockRestore();
			}
		});
	});

	it("discards a partially written stage when preparation is interrupted after intake", async () => {
		const { manifestEntry, payloads, selection, assets } = archiveBundle();
		await withArchive(tarArchive(manifestEntry, ...payloads), async (fd, directory) => {
			const cancel = new AbortController();
			const reason = new Error("synthetic archive preparation interruption");
			const original = stagingFs.open;
			let stage: string | undefined;
			const handle = vi.spyOn(stagingFs, "open").mockImplementation(async (path, flags, mode) => {
				if (typeof path === "string" && path.endsWith("/manifest.json")) {
					stage = path.slice(0, -"/manifest.json".length);
					expect(await readFile(join(stage, assets[0]!.path))).toEqual(assets[0]!.bytes);
					cancel.abort(reason);
				}
				return original(path, flags, mode);
			});
			try {
				await expect(prepareLocalBundleArchive(fd, selection, cancel.signal)).rejects.toBe(reason);
				expect(stage).toMatch(/^\/tmp\/kit-bundle-stage-/);
				await expect(lstat(stage!)).rejects.toMatchObject({ code: "ENOENT" });
				expect(await stagingFs.readdir(directory)).toEqual(["bundle.tar"]);
			} finally {
				handle.mockRestore();
				if (stage) await rm(stage, { recursive: true, force: true });
			}
		});
	});

	it("stages the exact reviewed selection and bytes through the preparation script", async () => {
		const { manifest, assets } = testBundle();
		const rootfsPath = "guest/etc/" + "a".repeat(100) + "/" + "b".repeat(100);
		const selectedManifest = {
			...manifest, files: manifest.files.map((file, index) => index === 3 ? { ...file, path: rootfsPath } : file),
		};
		const namedAssets = assets.map((asset, index) => index === 3 ? { ...asset, path: rootfsPath } : asset);
		const bytes = bundleBytes(selectedManifest);
		const manifestEntry = tarEntry("manifest.json", bytes);
		const payloads = namedAssets.map(({ path, bytes, mode }) => tarEntry(path, bytes, mode));
		const selection = { bundleVersion: manifest.bundleVersion, manifestSha256: bundleSha256(bytes) };
		const script = fileURLToPath(new URL("../sandbox/local/provision-toolchain.sh", import.meta.url));
		await withArchive(tarArchive(...payloads.reverse(), manifestEntry), async (fd, directory) => {
			const run = (digest: string, input: number | "pipe" = fd, output: number | "pipe" = "pipe") => spawnSync(script,
				[process.execPath, selection.bundleVersion, digest], {
					cwd: directory, encoding: "utf8", stdio: [input, output, "pipe"], timeout: 10_000,
					env: { ...process.env, NODE_OPTIONS: "--require=/nonexistent-node-preload" },
				});
			const wrong = run("0".repeat(64));
			expect(wrong.status).toBe(1);
			expect(wrong.stderr).toMatch(/manifestSha256/);
			expect(wrong.stdout).toBe("");
			const pipe = run(selection.manifestSha256, "pipe");
			expect(pipe.status).toBe(1);
			expect(pipe.stderr).toMatch(/regular file descriptor/);
			expect(pipe.stdout).toBe("");
			const listStages = async () => (await stagingFs.readdir("/tmp")).filter((name) => name.startsWith("kit-bundle-stage-")).sort();
			const before = await listStages();
			const full = await open("/dev/full", "w");
			try {
				const failedReceipt = run(selection.manifestSha256, fd, full.fd);
				expect(failedReceipt.status).toBe(1);
				expect(failedReceipt.stderr).toMatch(/ENOSPC/);
				expect(await listStages()).toEqual(before);
			} finally {
				await full.close();
			}
			const good = run(selection.manifestSha256);
			expect(good.stderr).toBe("");
			expect(good.status).toBe(0);
			const result = JSON.parse(good.stdout);
			expect(result.directory).toMatch(/^\/tmp\/kit-bundle-stage-/);
			try {
				expect(result.selection).toEqual(selection);
				expect((await lstat(result.directory)).mode & 0o777).toBe(0o700);
				expect(await readFile(join(result.directory, "manifest.json"))).toEqual(bytes);
				for (const asset of namedAssets) {
					const path = join(result.directory, asset.path);
					expect(await readFile(path)).toEqual(asset.bytes);
					expect((await lstat(path)).mode & 0o7777).toBe(asset.mode);
				}
				expect(await stagingFs.readdir(directory)).toEqual(["bundle.tar"]);
			} finally {
				await rm(result.directory, { recursive: true, force: true });
			}
		});
	});
});

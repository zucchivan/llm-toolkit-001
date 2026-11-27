import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LeaseLifecycle, type CgroupOps } from "../src/sandbox/lease-lifecycle.ts";
import { sealedManifestDigest, validateSealedManifest, validateManifestDelta, validateLocalBundle } from "../src/sandbox/manifest.ts";
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

import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LeaseLifecycle, type CgroupOps } from "../src/sandbox/lease-lifecycle.ts";
import { sealedManifestDigest, validateSealedManifest, validateManifestDelta } from "../src/sandbox/manifest.ts";
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

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LeaseLifecycle, type CgroupOps } from "../src/sandbox/lease-lifecycle.ts";
import { sealedManifestDigest, validateSealedManifest } from "../src/sandbox/manifest.ts";

const leaseId = "b29e52e3-e584-4f14-917c-a1e07c92e754";
function manifest(path = "src/main.ts", bytes = new TextEncoder().encode("export {}\n")) {
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const files = [{ path, mode: 0o100644 as const, bytes, sha256 }];
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

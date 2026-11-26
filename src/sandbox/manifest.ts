import { createHash } from "node:crypto";
import { assertAdmissiblePath, validateProjectPath, type TaskControls } from "../engine/controls.ts";

export const MANIFEST_MAX_ENTRIES = 100_000;
export const MANIFEST_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MANIFEST_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\0)[A-Za-z0-9._+@/-]+$/;

export interface SealedFile {
	path: string;
	mode: 0o100644 | 0o100755;
	bytes: Uint8Array;
	sha256: string;
}
export interface SealedManifest {
	version: 1;
	leaseId: string;
	files: readonly SealedFile[];
	digest: string;
}
export interface ManifestLimits {
	maxEntries?: number;
	maxFileBytes?: number;
	maxTotalBytes?: number;
}

/** Validate complete bounded file records before the caller makes any destination change. */
export function validateSealedManifest(value: unknown, expectedLeaseId: string, limits: ManifestLimits = {}): SealedManifest {
	if (!UUID_V4.test(expectedLeaseId) || !isRecord(value) || value.version !== 1 || value.leaseId !== expectedLeaseId || !Array.isArray(value.files)) {
		throw new Error("sealed manifest identity or version mismatch");
	}
	const maxEntries = boundedLimit(limits.maxEntries, MANIFEST_MAX_ENTRIES);
	const maxFileBytes = boundedLimit(limits.maxFileBytes, MANIFEST_MAX_FILE_BYTES);
	const maxTotalBytes = boundedLimit(limits.maxTotalBytes, MANIFEST_MAX_TOTAL_BYTES);
	if (value.files.length > maxEntries) throw new Error("sealed manifest entry limit exceeded");
	// Every prefix is a name, even if directories are implicit in file records.
	const names = new Map<string, { path: string; kind: "file" | "directory" }>();
	let total = 0;
	const files: SealedFile[] = [];
	for (const raw of value.files) {
		if (!isRecord(raw) || typeof raw.path !== "string" || !SAFE_PATH.test(raw.path) || raw.path.startsWith("/") || raw.path.includes("\\")) {
			throw new Error("sealed manifest contains an unsafe path");
		}
		validateProjectPath(raw.path);
		const parts = raw.path.split("/");
		if (parts.some((part) => part.length > 255)) throw new Error("sealed manifest path component exceeds its size limit");
		if (parts.some((part) => part.toLowerCase() === ".git" || part.toLowerCase() === ".orch")) throw new Error("sealed manifest contains a reserved path");
		for (let i = 1; i <= parts.length; i++) {
			const path = parts.slice(0, i).join("/");
			const kind = i === parts.length ? "file" : "directory";
			const prior = names.get(path.toLowerCase());
			if (prior && (prior.path !== path || prior.kind !== kind || kind === "file")) throw new Error("sealed manifest contains duplicate, ancestor or case-colliding paths");
			names.set(path.toLowerCase(), { path, kind });
			if (names.size > maxEntries) throw new Error("sealed manifest entry limit exceeded (including directories)");
		}
		if (raw.mode !== 0o100644 && raw.mode !== 0o100755) throw new Error("sealed manifest contains an unsupported file mode");
		if (!(raw.bytes instanceof Uint8Array) || raw.bytes.byteLength > maxFileBytes) throw new Error("sealed manifest file is invalid or exceeds its size limit");
		total += raw.bytes.byteLength;
		if (!Number.isSafeInteger(total) || total > maxTotalBytes) throw new Error("sealed manifest total size limit exceeded");
		const sha256 = createHash("sha256").update(raw.bytes).digest("hex");
		if (typeof raw.sha256 !== "string" || !SHA256.test(raw.sha256) || raw.sha256 !== sha256) throw new Error("sealed manifest file digest mismatch");
		files.push(Object.freeze({ path: raw.path, mode: raw.mode, bytes: Uint8Array.from(raw.bytes), sha256 }));
	}
	files.sort((a, b) => comparePath(a.path, b.path));
	const digest = sealedManifestDigest(expectedLeaseId, files);
	if (value.digest !== digest) throw new Error("sealed manifest digest mismatch");
	return Object.freeze({ version: 1, leaseId: expectedLeaseId, files: Object.freeze(files), digest });
}

export function sealedManifestDigest(leaseId: string, files: readonly SealedFile[]): string {
	const canonical = [...files].sort((a, b) => comparePath(a.path, b.path)).map((file) => `${file.mode}\0${file.path}\0${file.bytes.byteLength}\0${file.sha256}\n`).join("");
	return createHash("sha256").update(`${leaseId}\0${canonical}`).digest("hex");
}
export interface ManifestChange {
	readonly path: string;
	readonly kind: "add" | "modify" | "delete";
}

/**
 * Compare COMPLETE projected inventories, not the full unprojected Git tree.
 * Hidden inputs must never enter `base`; scratch must already be explicitly
 * accounted for by the host scanner. No filtering/delivery or filesystem I/O
 * occurs here. This validator is not a fence, scanner or durable seal.
 */
export function validateManifestDelta(base: unknown, candidate: unknown, leaseId: string, controls: TaskControls): readonly ManifestChange[] {
	const before = new Map(validateSealedManifest(base, leaseId).files.map((file) => [file.path, file]));
	const after = new Map(validateSealedManifest(candidate, leaseId).files.map((file) => [file.path, file]));
	const paths = [...new Set([...before.keys(), ...after.keys()])].sort(comparePath);
	const changes: ManifestChange[] = [];
	for (const path of paths) {
		const oldFile = before.get(path);
		const newFile = after.get(path);
		if (oldFile && newFile && oldFile.mode === newFile.mode && oldFile.sha256 === newFile.sha256) continue;
		assertAdmissiblePath(path, controls);
		changes.push(Object.freeze({ path, kind: !oldFile ? "add" : !newFile ? "delete" : "modify" }));
	}
	return Object.freeze(changes);
}

function comparePath(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function boundedLimit(value: number | undefined, maximum: number): number {
	if (value === undefined) return maximum;
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error("sealed manifest limit must be a non-negative safe integer no greater than the host cap");
	return value;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

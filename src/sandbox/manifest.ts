import { createHash } from "node:crypto";

export const MANIFEST_MAX_ENTRIES = 100_000;
export const MANIFEST_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MANIFEST_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
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
	if (!isRecord(value) || value.version !== 1 || value.leaseId !== expectedLeaseId || !Array.isArray(value.files)) {
		throw new Error("sealed manifest identity or version mismatch");
	}
	const maxEntries = limits.maxEntries ?? MANIFEST_MAX_ENTRIES;
	const maxFileBytes = limits.maxFileBytes ?? MANIFEST_MAX_FILE_BYTES;
	const maxTotalBytes = limits.maxTotalBytes ?? MANIFEST_MAX_TOTAL_BYTES;
	if (value.files.length > maxEntries) throw new Error("sealed manifest entry limit exceeded");
	const seen = new Set<string>();
	const folded = new Set<string>();
	let total = 0;
	const files: SealedFile[] = [];
	for (const raw of value.files) {
		if (!isRecord(raw) || typeof raw.path !== "string" || !SAFE_PATH.test(raw.path) || raw.path.startsWith("/") || raw.path.includes("\\")) {
			throw new Error("sealed manifest contains an unsafe path");
		}
		const parts = raw.path.split("/");
		if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("sealed manifest contains an unsafe path component");
		if (parts.some((part) => part.toLowerCase() === ".git" || part.toLowerCase() === ".orch")) throw new Error("sealed manifest contains a reserved path");
		if (seen.has(raw.path) || folded.has(raw.path.toLowerCase())) throw new Error("sealed manifest contains duplicate or case-colliding paths");
		seen.add(raw.path); folded.add(raw.path.toLowerCase());
		if (raw.mode !== 0o100644 && raw.mode !== 0o100755) throw new Error("sealed manifest contains an unsupported file mode");
		if (!(raw.bytes instanceof Uint8Array) || raw.bytes.byteLength > maxFileBytes) throw new Error("sealed manifest file is invalid or exceeds its size limit");
		total += raw.bytes.byteLength;
		if (!Number.isSafeInteger(total) || total > maxTotalBytes) throw new Error("sealed manifest total size limit exceeded");
		const sha256 = createHash("sha256").update(raw.bytes).digest("hex");
		if (typeof raw.sha256 !== "string" || !SHA256.test(raw.sha256) || raw.sha256 !== sha256) throw new Error("sealed manifest file digest mismatch");
		files.push(Object.freeze({ path: raw.path, mode: raw.mode, bytes: Uint8Array.from(raw.bytes), sha256 }));
	}
	const canonical = files.map((file) => `${file.mode}\0${file.path}\0${file.bytes.byteLength}\0${file.sha256}\n`).join("");
	const digest = createHash("sha256").update(`${expectedLeaseId}\0${canonical}`).digest("hex");
	if (value.digest !== digest) throw new Error("sealed manifest digest mismatch");
	return Object.freeze({ version: 1, leaseId: expectedLeaseId, files: Object.freeze(files), digest });
}

export function sealedManifestDigest(leaseId: string, files: readonly SealedFile[]): string {
	const canonical = [...files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => `${file.mode}\0${file.path}\0${file.bytes.byteLength}\0${file.sha256}\n`).join("");
	return createHash("sha256").update(`${leaseId}\0${canonical}`).digest("hex");
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }

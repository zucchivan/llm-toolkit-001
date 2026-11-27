import { createHash } from "node:crypto";
import archiveFs from "node:fs";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { isArrayBuffer, isUint8Array } from "node:util/types";
import { assertAdmissiblePath, validateProjectPath, type TaskControls } from "../engine/controls.ts";
import { GUEST_PROTOCOL_VERSION } from "./protocol.ts";

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

const BUNDLE_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const BUNDLE_VERSION = /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/;
const TYPED_ARRAY_PROTOTYPE: object = Object.getPrototypeOf(Uint8Array.prototype);

const BUNDLE_MAX_FILES = 16_384;
const BUNDLE_MAX_NAMES = 65_536;
const BUNDLE_MAX_FILE_BYTES = 256 * 1024 * 1024;
const BUNDLE_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const GLIBC_VERSION = /^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){1,2}$/;
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SOURCE_VERSION = /^(?:v?[0-9][a-zA-Z0-9._+~:-]{0,127}|[a-f0-9]{40}|[a-f0-9]{64})$/;
const EVIDENCE_METHODS = ["signed-release", "signed-checksums", "signed-build"] as const;
const SINGLE_FILE_ROLES = ["launcher", "bwrap", "node", "loader", "helper", "shell"] as const;
const REQUIRED_FILE_GROUPS = ["rootfs", "library", "helper-import", "utility"] as const;
type BundleFileRole = typeof SINGLE_FILE_ROLES[number] | typeof REQUIRED_FILE_GROUPS[number] | "dependency" | "lockfile";
const BUNDLE_FILE_ROLES: ReadonlySet<unknown> = new Set([
	...SINGLE_FILE_ROLES, ...REQUIRED_FILE_GROUPS, "dependency", "lockfile",
]);
const EXECUTABLE_BUNDLE_ROLES: ReadonlySet<BundleFileRole> = new Set([
	"launcher", "bwrap", "node", "loader", "shell", "utility",
]);

interface LocalBundleSource {
	readonly id: string;
	readonly version: string;
	readonly uri: string;
	readonly sha256: string;
	readonly evidence: Readonly<{
		method: typeof EVIDENCE_METHODS[number];
		signer: string;
		uri: string;
		sha256: string;
	}>;
}

interface LocalBundleFile {
	readonly path: string;
	readonly role: BundleFileRole;
	readonly source: string;
	readonly size: number;
	readonly mode: 0o644 | 0o755;
	readonly sha256: string;
	readonly lockfile?: string;
}

interface LocalBundleManifest {
	readonly schemaVersion: 1;
	readonly bundleVersion: string;
	readonly platform: "linux-x64";
	readonly abi: Readonly<{
		host: "gnu";
		hostMinGlibc: string;
		guest: "gnu";
		guestGlibc: string;
		launcherProtocol: 1;
		guestProtocol: typeof GUEST_PROTOCOL_VERSION;
	}>;
	readonly releaseSource: string;
	readonly sources: readonly LocalBundleSource[];
	readonly files: readonly LocalBundleFile[];
}

interface LocalBundleSelection {
	readonly bundleVersion: string;
	readonly manifestSha256: string;
}

interface LocalBundleAsset {
	readonly path: string;
	readonly kind: "file";
	readonly mode: number;
	readonly bytes: Uint8Array;
}

/** Validate operator-anchored bytes and a supplied inventory without any I/O. */
export function validateLocalBundle(
	manifestBytes: Uint8Array,
	assets: readonly LocalBundleAsset[],
	selection: LocalBundleSelection,
): LocalBundleManifest {
	assertBundleManifestBytes(manifestBytes);
	const manifest = readLocalBundleManifest(manifestBytes, selection);
	verifyBundleAssets(manifest.files, assets);
	return manifest;
}

/**
 * Prepare caller-materialized observations in private Linux staging. The returned
 * path belongs to the caller. There is no on-disk completion receipt to recover.
 */
export async function prepareLocalBundle(
	manifestBytes: Uint8Array,
	assets: readonly LocalBundleAsset[],
	selection: LocalBundleSelection,
	signal?: AbortSignal,
): Promise<Readonly<{ directory: string; selection: LocalBundleSelection }>> {
	signal?.throwIfAborted();
	assertBundleManifestBytes(manifestBytes);
	const bytes = new Uint8Array(manifestBytes);
	const selected = Object.freeze({
		bundleVersion: selection?.bundleVersion, manifestSha256: selection?.manifestSha256,
	});
	const manifest = readLocalBundleManifest(bytes, selected);
	const files: { file: LocalBundleFile; bytes: Uint8Array }[] = [];
	verifyBundleAssets(manifest.files, assets, (file, snapshot) => files.push({ file, bytes: snapshot }));

	if (process.platform !== "linux") throw new Error("local bundle staging requires Linux");
	// A root-owned sticky parent protects the new directory entry from other users.
	const stageParent = "/tmp";
	const parent = await fs.lstat(stageParent);
	if (!parent.isDirectory() || parent.uid !== 0 || !(parent.mode & 0o1000)) {
		throw new Error("local bundle staging requires a root-owned sticky /tmp directory");
	}
	signal?.throwIfAborted();
	const directory = await fs.mkdtemp(join(stageParent, "kit-bundle-stage-"));
	try {
		await fs.chmod(directory, 0o700);
		for (const { file, bytes: payload } of files) {
			signal?.throwIfAborted();
			const path = join(directory, file.path);
			await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeBundleStageFile(path, payload, file.mode);
		}
		signal?.throwIfAborted();
		await writeBundleStageFile(join(directory, "manifest.json"), bytes, 0o600);
		signal?.throwIfAborted();
		return Object.freeze({ directory, selection: selected });
	} catch (error) {
		try {
			await fs.rm(directory, { recursive: true, force: true });
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], `local bundle staging failed and could not remove ${directory}`);
		}
		throw error;
	}
}

const TAR_BLOCK = 512;
const TAR_MAX_BYTES = BUNDLE_MAX_MANIFEST_BYTES + BUNDLE_MAX_TOTAL_BYTES +
	(BUNDLE_MAX_FILES + 1) * (2 * TAR_BLOCK - 1) + 2 * TAR_BLOCK;

interface BundleArchiveEntry {
	readonly size: number;
	readonly mode: number;
	readonly offset: number;
}

/** Consume an already-open regular file at offset zero. The caller owns the descriptor. */
export async function prepareLocalBundleArchive(fd: number, selection: LocalBundleSelection, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const selected = { bundleVersion: selection?.bundleVersion, manifestSha256: selection?.manifestSha256 };
	const before = await statBundleArchive(fd);
	const length = Number(before.size);
	if (length > TAR_MAX_BYTES) throw new Error("local bundle archive byte limit exceeded");
	if (length < 3 * TAR_BLOCK || length % TAR_BLOCK !== 0) {
		throw new Error("malformed or truncated local bundle archive length");
	}

	const entries = new Map<string, BundleArchiveEntry>();
	const names = new Map<string, string>();
	const block = Buffer.alloc(TAR_BLOCK);
	let offset = 0;
	let total = 0;
	let fileCount = 0;
	for (;;) {
		await readBundleArchive(fd, block, offset, length, signal);
		offset += TAR_BLOCK;
		if (zeroTarBytes(block)) break;
		const { path, mode, size } = readBundleTarHeader(block);
		if (path === "manifest.json") {
			if (entries.has(path)) throw new Error("local bundle archive contains a duplicate or colliding path");
			if (mode !== 0o644) throw new Error("unsupported local bundle archive manifest mode");
			if (size > BUNDLE_MAX_MANIFEST_BYTES) throw new Error("local bundle archive manifest size limit exceeded");
		} else {
			if (++fileCount > BUNDLE_MAX_FILES) throw new Error("local bundle archive entry limit exceeded");
			assertBundlePath(path);
			if (!path.startsWith("host/") && !path.startsWith("guest/")) {
				throw new Error("local bundle archive contains an unsafe path outside host/ and guest/");
			}
			checkBundlePathCollisions(path, names);
			if (size > BUNDLE_MAX_FILE_BYTES) throw new Error("local bundle archive file size limit exceeded");
			total += size;
			if (total > BUNDLE_MAX_TOTAL_BYTES) throw new Error("local bundle archive total size limit exceeded");
		}
		const padding = (TAR_BLOCK - size % TAR_BLOCK) % TAR_BLOCK;
		if (offset + size + padding + 2 * TAR_BLOCK > length) {
			throw new Error("truncated local bundle archive entry");
		}
		entries.set(path, { size, mode, offset });
		offset += size;
		await readBundleArchive(fd, block.subarray(0, padding), offset, length, signal);
		if (!zeroTarBytes(block.subarray(0, padding))) throw new Error("nonzero local bundle archive padding");
		offset += padding;
	}
	await readBundleArchive(fd, block, offset, length, signal);
	if (!zeroTarBytes(block) || offset + TAR_BLOCK !== length) {
		throw new Error("invalid local bundle archive terminator or trailing data");
	}
	const manifestEntry = entries.get("manifest.json");
	if (!manifestEntry) throw new Error("local bundle archive is missing manifest.json");
	const manifestBytes = Buffer.alloc(manifestEntry.size);
	await readBundleArchive(fd, manifestBytes, manifestEntry.offset, length, signal);
	const manifest = readLocalBundleManifest(manifestBytes, selected);
	entries.delete("manifest.json");
	if (entries.size !== manifest.files.length) throw new Error("local bundle archive inventory count mismatch");

	// Check the complete archive layout against the reviewed inventory before
	// allocating payload buffers. The preparation boundary measures the bytes.
	const matching = manifest.files.map(({ path, mode, size }) => {
		const entry = entries.get(path);
		if (!entry) throw new Error("local bundle archive contains missing or unexpected paths");
		if (entry.mode !== mode) throw new Error("local bundle archive file mode mismatch");
		if (entry.size !== size) throw new Error("local bundle archive file size mismatch");
		return { path, ...entry };
	});
	const assets: LocalBundleAsset[] = [];
	for (const { path, mode, size, offset } of matching) {
		const bytes = Buffer.alloc(size);
		await readBundleArchive(fd, bytes, offset, length, signal);
		assets.push({ path, kind: "file", mode, bytes });
	}
	const after = await statBundleArchive(fd);
	if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
		throw new Error("local bundle archive changed during intake");
	}
	return prepareLocalBundle(manifestBytes, assets, selected, signal);
}

function statBundleArchive(fd: number): Promise<archiveFs.BigIntStats> {
	return new Promise((resolve, reject) => {
		archiveFs.fstat(fd, { bigint: true }, (error, stat) => {
			if (error) reject(error);
			else if (!stat.isFile() || stat.nlink !== 1n) reject(new Error("local bundle archive requires a single-link regular file descriptor"));
			else resolve(stat);
		});
	});
}

async function readBundleArchive(fd: number, bytes: Buffer, start: number, length: number, signal?: AbortSignal): Promise<void> {
	if (start + bytes.length > length) throw new Error("truncated local bundle archive");
	let offset = 0;
	while (offset < bytes.length) {
		signal?.throwIfAborted();
		const count = await new Promise<number>((resolve, reject) => {
			const size = Math.min(bytes.length - offset, 64 * 1024);
			archiveFs.read(fd, bytes, offset, size, start + offset, (error, read) => {
				if (error) reject(error);
				else resolve(read);
			});
		});
		signal?.throwIfAborted();
		if (count === 0) throw new Error("truncated local bundle archive");
		offset += count;
	}
}

function zeroTarBytes(bytes: Buffer): boolean {
	return bytes.every((byte) => byte === 0);
}

function readBundleTarHeader(block: Buffer): { path: string; mode: number; size: number } {
	if (block.toString("latin1", 257, 265) !== "ustar\0" + "00") {
		throw new Error("malformed or unsupported local bundle ustar header");
	}
	const checksum = block.toString("latin1", 148, 156);
	const expected = block.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
	if (!/^[0-7]{6}\0 $/.test(checksum) || Number.parseInt(checksum, 8) !== expected) {
		throw new Error("invalid local bundle archive header checksum");
	}
	if (block[156] !== 0x30 || !zeroTarBytes(block.subarray(157, 257))) {
		throw new Error("unsupported local bundle archive entry type or link");
	}
	const mode = readTarOctal(block.subarray(100, 108));
	if (mode !== 0o644 && mode !== 0o755) throw new Error("unsupported local bundle archive file mode");
	const size = readTarOctal(block.subarray(124, 136));
	readTarOctal(block.subarray(108, 116)); // uid
	readTarOctal(block.subarray(116, 124)); // gid
	readTarOctal(block.subarray(136, 148)); // mtime
	readTarText(block.subarray(265, 297)); // uname
	readTarText(block.subarray(297, 329)); // gname
	for (const device of [block.subarray(329, 337), block.subarray(337, 345)]) {
		if (!zeroTarBytes(device) && readTarOctal(device) !== 0) throw new Error("unsupported local bundle archive device fields");
	}
	if (!zeroTarBytes(block.subarray(500))) throw new Error("invalid local bundle archive reserved bytes");

	const name = readTarText(block.subarray(0, 100));
	const prefix = readTarText(block.subarray(345, 500));
	if (!name) throw new Error("local bundle archive contains an unsafe path");
	return { path: prefix ? prefix + "/" + name : name, mode, size };
}

function readTarText(bytes: Buffer): string {
	const end = bytes.indexOf(0);
	const value = bytes.toString("latin1", 0, end === -1 ? bytes.length : end);
	if (!/^[ -~]*$/.test(value) || (end !== -1 && !zeroTarBytes(bytes.subarray(end)))) {
		throw new Error("malformed local bundle archive text field");
	}
	return value;
}

function readTarOctal(bytes: Buffer): number {
	const digits = bytes.toString("latin1", 0, bytes.length - 1);
	if (bytes.at(-1) !== 0 || !/^[0-7]+$/.test(digits)) throw new Error("malformed local bundle archive numeric field");
	return Number.parseInt(digits, 8);
}

async function writeBundleStageFile(path: string, bytes: Uint8Array, mode: number): Promise<void> {
	const handle = await fs.open(path, "wx", 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.chmod(mode);
	} finally {
		await handle.close();
	}
}

function assertBundleManifestBytes(bytes: Uint8Array): void {
	if (!validBundleBytes(bytes) || bundleByteLength(bytes) > BUNDLE_MAX_MANIFEST_BYTES) {
		throw new Error("local bundle manifest exceeds its byte limit or has invalid bytes");
	}
}

function readLocalBundleManifest(manifestBytes: Uint8Array, selection: LocalBundleSelection): LocalBundleManifest {
	if (!selection || !isSha256(selection.manifestSha256) || sha256Bytes(manifestBytes) !== selection.manifestSha256) {
		throw new Error("local bundle manifestSha256 mismatch");
	}
	let manifest: unknown;
	try {
		manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(manifestBytes));
	} catch {
		throw new Error("local bundle manifest is not valid UTF-8 JSON");
	}
	assertLocalBundleManifest(manifest, selection.bundleVersion);
	assertCanonicalBundle(manifestBytes, manifest);
	return manifest;
}

function assertLocalBundleManifest(value: unknown, version: string): asserts value is LocalBundleManifest {
	if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("unsupported local bundle schema version");
	if (typeof version !== "string" || !BUNDLE_VERSION.test(version) || value.bundleVersion !== version) {
		throw new Error("local bundle version does not match explicit selection");
	}
	if (!hasBundleFields(value, ["abi", "bundleVersion", "files", "platform", "releaseSource", "schemaVersion", "sources"])) {
		throw new Error("invalid local bundle manifest fields");
	}
	if (value.platform !== "linux-x64") throw new Error("unsupported local bundle platform");
	const abi = value.abi;
	if (!hasBundleFields(abi, ["guest", "guestGlibc", "guestProtocol", "host", "hostMinGlibc", "launcherProtocol"]) ||
		abi.guest !== "gnu" || abi.host !== "gnu" || abi.guestProtocol !== GUEST_PROTOCOL_VERSION || abi.launcherProtocol !== 1 ||
		typeof abi.guestGlibc !== "string" || !GLIBC_VERSION.test(abi.guestGlibc) ||
		typeof abi.hostMinGlibc !== "string" || !GLIBC_VERSION.test(abi.hostMinGlibc)) {
		throw new Error("unsupported local bundle ABI");
	}
	const sources = validateBundleSources(value.sources);
	if (typeof value.releaseSource !== "string" || sources.get(value.releaseSource) !== version) {
		throw new Error("local bundle release source must pin the selected version");
	}
	validateBundleFiles(value.files, sources);
}

function assertCanonicalBundle(bytes: Uint8Array, manifest: LocalBundleManifest): void {
	const canonical = JSON.stringify(manifest, (_key, value: unknown) =>
		isRecord(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => comparePath(a, b))) : value,
	) + "\n";
	if (!Buffer.from(canonical).equals(bytes)) throw new Error("local bundle manifest is not canonical JSON");
}

function validBundleBytes(value: unknown): value is Uint8Array {
	return isUint8Array(value) && isArrayBuffer(Reflect.get(TYPED_ARRAY_PROTOTYPE, "buffer", value));
}

function bundleByteLength(bytes: Uint8Array): number {
	// Ignore caller-owned properties shadowing the actual typed-array view.
	return Reflect.get(TYPED_ARRAY_PROTOTYPE, "byteLength", bytes) as number;
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && SHA256.test(value);
}

function sha256Bytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function hasBundleFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
	return isRecord(value) && Object.keys(value).length === fields.length &&
		fields.every((field) => Object.hasOwn(value, field));
}

function validateBundleSources(value: unknown): Map<string, string> {
	if (!Array.isArray(value) || value.length === 0 || value.length > 1024) {
		throw new Error("invalid local bundle source count");
	}
	const sources = new Map<string, string>();
	let previous = "";
	for (const source of value) {
		if (!hasBundleFields(source, ["evidence", "id", "sha256", "uri", "version"]) ||
			typeof source.id !== "string" || !SOURCE_ID.test(source.id) || !isSha256(source.sha256)) {
			throw new Error("invalid local bundle source fields");
		}
		if (source.id <= previous) throw new Error("local bundle source IDs must be unique and ordered");
		if (typeof source.version !== "string" || !SOURCE_VERSION.test(source.version)) {
			throw new Error("local bundle requires an exact source version");
		}
		if (!isBundleUri(source.uri)) throw new Error("invalid local bundle source URI");
		const evidence = source.evidence;
		if (!hasBundleFields(evidence, ["method", "sha256", "signer", "uri"]) ||
			!EVIDENCE_METHODS.some((method) => method === evidence.method) ||
			typeof evidence.signer !== "string" || !/^[A-Za-z0-9._:@+/-]{1,256}$/.test(evidence.signer) ||
			!isBundleUri(evidence.uri) || evidence.uri === source.uri ||
			!isSha256(evidence.sha256) || evidence.sha256 === source.sha256) {
			throw new Error("invalid local bundle authenticity evidence");
		}
		previous = source.id;
		sources.set(source.id, source.version);
	}
	return sources;
}

function isBundleUri(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 2048 || !/^[!-~]+$/.test(value)) return false;
	try {
		const uri = new URL(value);
		return uri.protocol === "https:" && uri.href === value && uri.pathname !== "/" &&
			!uri.username && !uri.password && !value.includes("?") && !value.includes("#") &&
			!decodeURIComponent(uri.pathname).toLowerCase().split("/").includes("latest");
	} catch {
		return false;
	}
}

function validateBundleFiles(value: unknown, sources: ReadonlyMap<string, string>): void {
	if (!Array.isArray(value) || value.length === 0 || value.length > BUNDLE_MAX_FILES) {
		throw new Error("invalid local bundle file count");
	}
	const files = new Map<string, LocalBundleFile>();
	const names = new Map<string, string>();
	const counts = new Map<BundleFileRole, number>();
	let total = 0;
	let previous = "";
	for (const raw of value) {
		assertBundleFile(raw, sources);
		if (raw.path <= previous) throw new Error("local bundle paths must be ordered without duplicates");
		checkBundlePathCollisions(raw.path, names);
		previous = raw.path;
		total += raw.size;
		if (total > BUNDLE_MAX_TOTAL_BYTES) throw new Error("local bundle total size limit exceeded");
		files.set(raw.path, raw);
		counts.set(raw.role, (counts.get(raw.role) ?? 0) + 1);
	}
	for (const role of SINGLE_FILE_ROLES) {
		if (counts.get(role) !== 1) throw new Error(`local bundle requires exactly one ${role} file`);
	}
	for (const role of REQUIRED_FILE_GROUPS) {
		if (!counts.has(role)) throw new Error(`local bundle requires at least one ${role} file`);
	}
	const hostDigests = new Set<string>();
	for (const file of files.values()) {
		if (isHostBundleRole(file.role)) hostDigests.add(file.sha256);
	}
	for (const file of files.values()) {
		if (!isHostBundleRole(file.role) && hostDigests.has(file.sha256)) {
			throw new Error("local bundle places host-only bytes in the guest inventory");
		}
		if (file.lockfile !== undefined && files.get(file.lockfile)?.role !== "lockfile") {
			throw new Error("local bundle dependency requires a declared guest lockfile");
		}
	}
}

function isHostBundleRole(role: BundleFileRole): boolean {
	return role === "launcher" || role === "bwrap";
}

function assertBundleFile(value: unknown, sources: ReadonlyMap<string, string>): asserts value is LocalBundleFile {
	const fields = ["path", "mode", "role", "sha256", "size", "source"];
	if (isRecord(value) && value.role === "dependency") fields.push("lockfile");
	if (!hasBundleFields(value, fields) || !isBundleRole(value.role)) throw new Error("invalid local bundle file fields or role");
	assertBundlePath(value.path);
	if (!value.path.startsWith(isHostBundleRole(value.role) ? "host/" : "guest/")) {
		throw new Error("invalid local bundle host/guest path for file role");
	}
	const executable = EXECUTABLE_BUNDLE_ROLES.has(value.role);
	if ((value.mode !== 0o644 && value.mode !== 0o755) || (executable && value.mode !== 0o755)) {
		throw new Error("invalid local bundle file mode");
	}
	if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) ||
		value.size < (executable ? 1 : 0) || value.size > BUNDLE_MAX_FILE_BYTES) {
		throw new Error("invalid local bundle file size");
	}
	if (!isSha256(value.sha256)) throw new Error("invalid local bundle file SHA-256");
	if (typeof value.source !== "string" || !sources.has(value.source)) throw new Error("local bundle file source is missing");
	if (value.role === "dependency") assertBundlePath(value.lockfile);
}

function isBundleRole(value: unknown): value is BundleFileRole {
	return BUNDLE_FILE_ROLES.has(value);
}

function assertBundlePath(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length > 512 || !SAFE_PATH.test(value) || value.endsWith("/") ||
		value.split("/").some((part) => part.length > 255 || [".git", ".orch"].includes(part.toLowerCase()))) {
		throw new Error("local bundle contains an unsafe path");
	}
	try {
		validateProjectPath(value);
	} catch {
		throw new Error("local bundle contains an unsafe path");
	}
}

function checkBundlePathCollisions(path: string, names: Map<string, string>): void {
	const parts = path.split("/");
	let prefix = "";
	for (const [index, part] of parts.entries()) {
		const leaf = index === parts.length - 1;
		const name = prefix + part;
		prefix = name + "/";
		const key = name.toLowerCase();
		const spelling = leaf ? name : prefix;
		const prior = names.get(key);
		if (prior !== undefined && (leaf || prior !== spelling)) {
			throw new Error("local bundle contains duplicate or colliding paths");
		}
		names.set(key, spelling);
		if (names.size > BUNDLE_MAX_NAMES) throw new Error("local bundle path count exceeds its limit");
	}
}

function verifyBundleAssets(
	files: readonly LocalBundleFile[],
	assets: readonly LocalBundleAsset[],
	retain?: (file: LocalBundleFile, snapshot: Uint8Array) => void,
): void {
	if (!Array.isArray(assets) || assets.length !== files.length) {
		throw new Error("local bundle asset inventory count mismatch");
	}
	const remaining = new Map(files.map((file) => [file.path, file]));
	for (let index = 0; index < files.length; index++) {
		const asset = Object.hasOwn(assets, index) ? assets[index] : undefined;
		if (!hasBundleFields(asset, ["path", "kind", "mode", "bytes"])) {
			throw new Error("invalid local bundle file observation");
		}
		const { path, kind, mode, bytes } = asset;
		if (typeof path !== "string" || kind !== "file" || !validBundleBytes(bytes)) {
			throw new Error("invalid local bundle file observation");
		}
		const file = remaining.get(path);
		if (!file) throw new Error("unexpected or duplicate local bundle file observation");
		if (mode !== file.mode) throw new Error(`local bundle file mode mismatch: ${file.path}`);
		if (bundleByteLength(bytes) !== file.size) throw new Error(`local bundle file size mismatch: ${file.path}`);
		const verified = retain ? new Uint8Array(bytes) : bytes;
		if (sha256Bytes(verified) !== file.sha256) throw new Error(`local bundle file SHA-256 mismatch: ${file.path}`);
		retain?.(file, verified);
		remaining.delete(file.path);
	}
}

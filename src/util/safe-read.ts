/**
 * Capped, no-follow host reads (M1-P01 step b).
 *
 * Node has no `openat`. On Linux this module walks one path component at a
 * time with directory file descriptors and opens every child through
 * `/proc/self/fd/<dirfd>/<child>`. The kernel resolves the magic link to the
 * pinned directory inode, so renaming or replacing an already-opened ancestor
 * cannot redirect the next component, and `O_NOFOLLOW` refuses a symlink in
 * the child position. There is deliberately no `lstat`/`realpath`-then-open
 * path: `lstat` is used only to label a refusal after the open already failed.
 *
 * On a host where that primitive cannot be shown to exist the caller gets a
 * typed `unsupported-platform` refusal. There is no fallback to PATH, cwd, a
 * project-controlled environment variable or `readFile`.
 *
 * Caps are enforced while reading/listing, never by slicing a fully loaded
 * file: 32 MiB per file, 512 MiB of admitted content per shared budget, and
 * 100k entries per walk. A refusal never returns partial content.
 */
import { constants } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { lstat, open, opendir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { assertCanonicalAbsolutePath } from "../sandbox/host-profile.ts";

export const SAFE_READ_LIMITS = Object.freeze({
	/** Per regular file. */
	maxFileBytes: 32 * 1024 * 1024,
	/** Shared admission for one control-bundle/walk budget. */
	maxContentBytes: 512 * 1024 * 1024,
	/** Directory entries visited by one list/walk. */
	maxDirectoryEntries: 100_000,
	/** Longest accepted relative path, in UTF-8 bytes. */
	maxPathBytes: 4096,
	/** Longest accepted single path component, in UTF-8 bytes. */
	maxComponentBytes: 255,
});

const CHUNK_BYTES = 64 * 1024;
const DEFAULT_PROC_FD_BASE = "/proc/self/fd";

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// O_NONBLOCK matters only for the final component: opening a FIFO read-only
// without it blocks until a writer appears. For regular files it is inert.
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export type SafeReadRefusalCode =
	| "unsafe-root"
	| "unsafe-path"
	| "unsupported-platform"
	| "symlink"
	| "hardlink"
	| "not-directory"
	| "not-regular"
	| "unreadable"
	| "too-large"
	| "content-capped"
	| "entry-capped"
	| "malformed"
	| "changed";

/**
 * `absent` is reserved for a genuine ENOENT on a non-symlink component.
 * Permission, loop, type, size and capability failures are refusals.
 */
export type SafeReadResult<T> =
	| { kind: "ok"; value: T }
	| { kind: "absent"; path: string }
	| {
		kind: "refused";
		code: SafeReadRefusalCode;
		path: string;
		message: string;
		/** Bytes observed before a cap refusal; 0 means nothing was read. */
		bytesRead?: number;
	};

export type SafeDirEntryKind = "file" | "directory" | "symlink" | "other";

export interface SafeDirEntry {
	name: string;
	kind: SafeDirEntryKind;
}

export interface SafeTreeListing {
	files: string[];
	directories: string[];
}

/** Shared admission counter for one control bundle or walk. Never project-controlled. */
export class SafeReadBudget {
	readonly maxContentBytes: number;
	#used = 0;

	constructor(maxContentBytes: number = SAFE_READ_LIMITS.maxContentBytes) {
		if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 0) {
			throw new RangeError("safe-read budget must be a non-negative safe integer");
		}
		if (maxContentBytes > SAFE_READ_LIMITS.maxContentBytes) {
			throw new RangeError(`safe-read budget may not exceed ${SAFE_READ_LIMITS.maxContentBytes} bytes`);
		}
		this.maxContentBytes = maxContentBytes;
	}

	get used(): number {
		return this.#used;
	}

	get remaining(): number {
		return this.maxContentBytes - this.#used;
	}

	/** Charge bytes; false when the admission would exceed the documented cap. */
	admit(bytes: number): boolean {
		if (!Number.isSafeInteger(bytes) || bytes < 0) {
			throw new RangeError("safe-read admission must be a non-negative safe integer");
		}
		if (this.#used + bytes > this.maxContentBytes) return false;
		this.#used += bytes;
		return true;
	}
}

export interface SafeDirectoryRef {
	/** Canonical absolute root. Callers resolve it once before use. */
	root: string;
	/** Root-relative path; empty/omitted means the root itself. */
	path?: string;
	/**
	 * Diagnostic/test seam for the directory-FD primitive. Production uses
	 * `/proc/self/fd`; project config, env and cwd can never supply this.
	 */
	procFdBase?: string;
}

export interface SafeReadOptions {
	/** Effective cap is min(this, 32 MiB). */
	maxBytes?: number;
	/** Shared 512 MiB admission budget. */
	budget?: SafeReadBudget;
}

export interface SafeListEntriesOptions {
	maxEntries?: number;
}

/** An opened, pinned directory. Close it when finished. */
export interface SafeDirectory {
	/** Root-relative display path (empty for the root). */
	readonly path: string;
	list(options?: SafeListEntriesOptions): Promise<SafeReadResult<readonly SafeDirEntry[]>>;
	openFile(name: string): Promise<SafeReadResult<SafeFile>>;
	openDirectory(name: string): Promise<SafeReadResult<SafeDirectory>>;
	close(): Promise<void>;
}

/** An opened, pinned regular file. Close it when finished. */
export interface SafeFile {
	/** Root-relative display path. */
	readonly path: string;
	/** fstat size at open time; the read loop still caps growth. */
	readonly size: number;
	readBytes(options?: SafeReadOptions): Promise<SafeReadResult<Buffer>>;
	readText(options?: SafeReadOptions): Promise<SafeReadResult<string>>;
	close(): Promise<void>;
}

export interface SafeFileRequest extends SafeDirectoryRef {
	path: string;
	maxBytes?: number;
	budget?: SafeReadBudget;
}

export interface SafeListRequest extends SafeDirectoryRef {
	maxEntries?: number;
}

export interface SafeWalkRequest extends SafeDirectoryRef {
	maxEntries?: number;
}

export interface SafeReadPrimitiveStatus {
	supported: boolean;
	platform: NodeJS.Platform;
	reason: string;
}

/**
 * Pure platform decision. The runtime call additionally proves that the
 * proc-fd base exists and is a directory; a missing mount is a refusal.
 */
export function safeReadPrimitiveStatus(platform: NodeJS.Platform = process.platform): SafeReadPrimitiveStatus {
	if (platform !== "linux") {
		return {
			supported: false,
			platform,
			reason: `no race-safe no-follow component walk is implemented for ${platform}; host reads refuse rather than fall back to realpath/lstat-then-open`,
		};
	}
	if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number") {
		return {
			supported: false,
			platform,
			reason: "the running Node build does not expose O_NOFOLLOW/O_DIRECTORY; a no-follow walk cannot be proven",
		};
	}
	return { supported: true, platform, reason: "linux /proc/self/fd directory-FD component walk" };
}

// ---------------------------------------------------------------------------
// Result helpers and input validation
// ---------------------------------------------------------------------------

function refuse<T>(
	code: SafeReadRefusalCode,
	path: string,
	message: string,
	bytesRead?: number,
): SafeReadResult<T> {
	return bytesRead === undefined
		? { kind: "refused", code, path, message }
		: { kind: "refused", code, path, message, bytesRead };
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\..*)?$/i;

/** One directory-entry name. Rejected names are never opened or returned. */
function validateComponent(name: string): string | undefined {
	if (name.length === 0) return "path component must not be empty";
	if (name === "." || name === "..") return `path component ${JSON.stringify(name)} is not allowed`;
	if (Buffer.byteLength(name, "utf8") > SAFE_READ_LIMITS.maxComponentBytes) {
		return `path component is longer than ${SAFE_READ_LIMITS.maxComponentBytes} UTF-8 bytes`;
	}
	if (CONTROL_CHARACTERS.test(name)) return "path component must not contain control characters";
	if (name.includes("\uFFFD")) return "path component is not valid UTF-8";
	if (name.includes("/") || name.includes("\\")) return "path component must not contain a separator";
	if (name.includes(":")) return "path component must not contain a drive or stream separator";
	if (name.endsWith(".") || name.endsWith(" ")) return "path component must not end with a dot or space";
	if (RESERVED_WINDOWS_NAME.test(name)) return `path component ${JSON.stringify(name)} is a reserved device name`;
	return undefined;
}

function parseRelativePath(
	value: unknown,
	allowEmpty: boolean,
): { ok: true; components: string[] } | { ok: false; message: string } {
	if (typeof value !== "string") return { ok: false, message: "path must be a string" };
	if (value.length === 0) {
		return allowEmpty
			? { ok: true, components: [] }
			: { ok: false, message: "path must name a file inside the root" };
	}
	if (Buffer.byteLength(value, "utf8") > SAFE_READ_LIMITS.maxPathBytes) {
		return { ok: false, message: `path is longer than ${SAFE_READ_LIMITS.maxPathBytes} UTF-8 bytes` };
	}
	if (value.includes("\\")) {
		return { ok: false, message: "path must use '/' separators; backslashes are not accepted" };
	}
	if (value.startsWith("/") || value.startsWith("//")) {
		return { ok: false, message: "path must be relative to the trusted root, not absolute" };
	}
	if (/^[A-Za-z]:/.test(value)) {
		return { ok: false, message: "path must not name a drive or stream" };
	}
	const components = value.split("/");
	for (const component of components) {
		const problem = validateComponent(component);
		if (problem) return { ok: false, message: `${problem}: ${JSON.stringify(component)}` };
	}
	return { ok: true, components };
}

function parseRoot(value: unknown): { ok: true; components: string[] } | { ok: false; message: string } {
	try {
		const root = assertCanonicalAbsolutePath(value, "safe-read root");
		if (root === "/") return { ok: true, components: [] };
		return { ok: true, components: root.slice(1).split("/") };
	} catch (error) {
		return { ok: false, message: (error as Error).message };
	}
}

function effectiveBytes(maxBytes: number | undefined): number {
	if (maxBytes === undefined) return SAFE_READ_LIMITS.maxFileBytes;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new RangeError("safe-read maxBytes must be a non-negative safe integer");
	}
	return Math.min(maxBytes, SAFE_READ_LIMITS.maxFileBytes);
}

function effectiveEntries(maxEntries: number | undefined): number {
	if (maxEntries === undefined) return SAFE_READ_LIMITS.maxDirectoryEntries;
	if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
		throw new RangeError("safe-read maxEntries must be a non-negative safe integer");
	}
	return Math.min(maxEntries, SAFE_READ_LIMITS.maxDirectoryEntries);
}

// ---------------------------------------------------------------------------
// Primitive detection and error classification
// ---------------------------------------------------------------------------

async function resolvePrimitive(
	procFdBase: string | undefined,
): Promise<{ ok: true; base: string } | { ok: false; message: string }> {
	const status = safeReadPrimitiveStatus();
	if (!status.supported) return { ok: false, message: status.reason };
	const base = procFdBase ?? DEFAULT_PROC_FD_BASE;
	if (typeof base !== "string" || !base.startsWith("/") || base.includes("\0")) {
		return { ok: false, message: "proc-fd base must be an absolute, NUL-free path" };
	}
	try {
		const info = await stat(base);
		if (!info.isDirectory()) return { ok: false, message: `${base} is not a directory` };
	} catch (error) {
		return { ok: false, message: `cannot prove the ${base} primitive: ${(error as Error).message}` };
	}
	return { ok: true, base };
}

function describeStats(info: Stats): string {
	if (info.isSymbolicLink()) return "symbolic link";
	if (info.isDirectory()) return "directory";
	if (info.isFile()) return "regular file";
	if (info.isFIFO()) return "FIFO";
	if (info.isSocket()) return "socket";
	if (info.isCharacterDevice()) return "character device";
	if (info.isBlockDevice()) return "block device";
	return "special file";
}

/**
 * Label a failed child open. The open is the security boundary; this lstat is
 * only a diagnostic and can itself fail without changing the refusal.
 */
async function describeCandidate(candidate: string): Promise<string> {
	try {
		return describeStats(await lstat(candidate));
	} catch {
		return "unreadable entry";
	}
}

async function mapChildFailure<T>(
	error: unknown,
	candidate: string,
	display: string,
	want: "file" | "directory",
): Promise<SafeReadResult<T>> {
	const code = (error as NodeJS.ErrnoException)?.code;
	if (code === "ENOENT") return { kind: "absent", path: display };
	if (code === "ELOOP") {
		return refuse("symlink", display, `${display} is a symbolic link; host reads never follow links`);
	}
	if (code === "EACCES" || code === "EPERM") {
		return refuse("unreadable", display, `permission denied while opening ${display}`);
	}
	if (code === "ENAMETOOLONG") {
		return refuse("unsafe-path", display, `${display} is too long for the host filesystem`);
	}
	const kind = await describeCandidate(candidate);
	if (kind === "symbolic link") {
		return refuse("symlink", display, `${display} is a symbolic link; host reads never follow links`);
	}
	if (want === "directory") {
		return refuse("not-directory", display, `${display} is a ${kind}, not a directory`);
	}
	if (code === "ENXIO" || code === "EISDIR" || code === "ENOTDIR" || kind !== "regular file") {
		return refuse("not-regular", display, `${display} is a ${kind}; only regular files are read`);
	}
	return refuse(
		"unreadable",
		display,
		`cannot open ${display}${code ? ` (${code})` : ""}: ${(error as Error).message}`,
	);
}

function classifyDirent(dirent: Dirent): SafeDirEntryKind | undefined {
	if (dirent.isFile()) return "file";
	if (dirent.isDirectory()) return "directory";
	if (dirent.isSymbolicLink()) return "symlink";
	if (dirent.isFIFO() || dirent.isSocket() || dirent.isCharacterDevice() || dirent.isBlockDevice()) return "other";
	return undefined;
}

async function classifyEntry(candidate: string, dirent: Dirent): Promise<SafeDirEntryKind> {
	const direct = classifyDirent(dirent);
	if (direct) return direct;
	try {
		const info = await lstat(candidate);
		if (info.isFile()) return "file";
		if (info.isDirectory()) return "directory";
		if (info.isSymbolicLink()) return "symlink";
		return "other";
	} catch {
		// A vanished/replaced entry is reported as `other`; the walk refuses it
		// rather than inventing a regular file.
		return "other";
	}
}

function decodeText(bytes: Buffer): string | undefined {
	if (bytes.includes(0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Pinned handles
// ---------------------------------------------------------------------------

class PinnedFile implements SafeFile {
	readonly path: string;
	readonly size: number;
	#handle: FileHandle;
	#closed = false;

	constructor(handle: FileHandle, path: string, size: number) {
		this.#handle = handle;
		this.path = path;
		this.size = size;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#handle.close().catch(() => undefined);
	}

	async readBytes(options: SafeReadOptions = {}): Promise<SafeReadResult<Buffer>> {
		if (this.#closed) return refuse("unreadable", this.path, "file handle is closed");
		const maxBytes = effectiveBytes(options.maxBytes);
		if (this.size > maxBytes) {
			return refuse("too-large", this.path, `${this.path} is ${this.size} bytes; the per-file cap is ${maxBytes}`, 0);
		}
		const budget = options.budget;
		if (budget && this.size > budget.remaining) {
			return refuse(
				"content-capped",
				this.path,
				`${this.path} is ${this.size} bytes; only ${budget.remaining} bytes remain in the shared content budget`,
				0,
			);
		}

		const limit = budget ? Math.min(maxBytes, budget.remaining) : maxBytes;
		const chunks: Buffer[] = [];
		let total = 0;
		while (true) {
			const room = limit - total;
			// When the cap is reached, probe one more byte so a file that grew
			// after open is a refusal rather than a silently truncated success.
			const size = room > 0 ? Math.min(CHUNK_BYTES, room) : 1;
			const buffer = Buffer.allocUnsafe(size);
			let bytesRead = 0;
			try {
				({ bytesRead } = await this.#handle.read(buffer, 0, size, total));
			} catch (error) {
				return refuse("unreadable", this.path, `read failed: ${(error as Error).message}`);
			}
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > maxBytes) {
				return refuse("too-large", this.path, `${this.path} grew past the per-file cap of ${maxBytes}`, total);
			}
			if (budget && budget.used + total > budget.maxContentBytes) {
				return refuse(
					"content-capped",
					this.path,
					`${this.path} exceeded the shared content budget of ${budget.maxContentBytes} bytes`,
					total,
				);
			}
			chunks.push(buffer.subarray(0, bytesRead));
		}
		if (budget && !budget.admit(total)) {
			return refuse("content-capped", this.path, "shared content budget refused the completed read", total);
		}
		return { kind: "ok", value: Buffer.concat(chunks, total) };
	}

	async readText(options: SafeReadOptions = {}): Promise<SafeReadResult<string>> {
		const bytes = await this.readBytes(options);
		if (bytes.kind !== "ok") return bytes;
		const text = decodeText(bytes.value);
		if (text === undefined) {
			return refuse("malformed", this.path, `${this.path} is not valid UTF-8 text or contains a NUL byte`);
		}
		return { kind: "ok", value: text };
	}
}

class PinnedDirectory implements SafeDirectory {
	readonly path: string;
	#handle: FileHandle;
	#base: string;
	#closed = false;

	constructor(handle: FileHandle, path: string, base: string) {
		this.#handle = handle;
		this.path = path;
		this.#base = base;
	}

	#childPath(name: string): string {
		return this.path ? `${this.path}/${name}` : name;
	}

	#candidate(name: string): string {
		return `${this.#base}/${this.#handle.fd}/${name}`;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#handle.close().catch(() => undefined);
	}

	async openFile(name: string): Promise<SafeReadResult<SafeFile>> {
		const display = this.#childPath(name);
		if (this.#closed) return refuse("unreadable", display, "directory handle is closed");
		const problem = validateComponent(name);
		if (problem) return refuse("unsafe-path", display, `${problem}: ${JSON.stringify(name)}`);
		const candidate = this.#candidate(name);
		let handle: FileHandle | undefined;
		try {
			handle = await open(candidate, FILE_FLAGS);
			const info = await handle.stat();
			if (!info.isFile()) {
				const kind = describeStats(info);
				await handle.close().catch(() => undefined);
				return refuse("not-regular", display, `${display} is a ${kind}; only regular files are read`);
			}
			if (!Number.isSafeInteger(info.size) || info.size < 0) {
				await handle.close().catch(() => undefined);
				return refuse("not-regular", display, `${display} has no trustworthy regular-file size`);
			}
			if (info.size > SAFE_READ_LIMITS.maxFileBytes) {
				await handle.close().catch(() => undefined);
				return refuse(
					"too-large",
					display,
					`${display} is ${info.size} bytes; the per-file cap is ${SAFE_READ_LIMITS.maxFileBytes}`,
					0,
				);
			}
			// §2 rejects hard-linked regular files for projection/import; M1-P01
			// step (d) applies the same rule to host control reads: an alias could
			// otherwise name a same-owner host file outside the reviewed bundle.
			// The check is on the opened inode; a later link does not redirect the
			// pinned FD and cannot change which bytes this read returns.
			if (info.nlink > 1) {
				await handle.close().catch(() => undefined);
				return refuse(
					"hardlink",
					display,
					`${display} has ${info.nlink} hard links; host reads refuse hard-linked files`,
				);
			}
			return { kind: "ok", value: new PinnedFile(handle, display, info.size) };
		} catch (error) {
			if (handle) await handle.close().catch(() => undefined);
			return mapChildFailure<SafeFile>(error, candidate, display, "file");
		}
	}

	async openDirectory(name: string): Promise<SafeReadResult<SafeDirectory>> {
		const display = this.#childPath(name);
		if (this.#closed) return refuse("unreadable", display, "directory handle is closed");
		const problem = validateComponent(name);
		if (problem) return refuse("unsafe-path", display, `${problem}: ${JSON.stringify(name)}`);
		const candidate = this.#candidate(name);
		let handle: FileHandle | undefined;
		try {
			handle = await open(candidate, DIRECTORY_FLAGS);
			const info = await handle.stat();
			if (!info.isDirectory()) {
				const kind = describeStats(info);
				await handle.close().catch(() => undefined);
				return refuse("not-directory", display, `${display} is a ${kind}, not a directory`);
			}
			return { kind: "ok", value: new PinnedDirectory(handle, display, this.#base) };
		} catch (error) {
			if (handle) await handle.close().catch(() => undefined);
			return mapChildFailure<SafeDirectory>(error, candidate, display, "directory");
		}
	}

	async list(options: SafeListEntriesOptions = {}): Promise<SafeReadResult<readonly SafeDirEntry[]>> {
		const display = this.path || "/";
		if (this.#closed) return refuse("unreadable", display, "directory handle is closed");
		const maxEntries = effectiveEntries(options.maxEntries);
		let directory;
		try {
			directory = await opendir(`${this.#base}/${this.#handle.fd}`);
		} catch (error) {
			return refuse("unreadable", display, `cannot list ${display}: ${(error as Error).message}`);
		}
		const entries: SafeDirEntry[] = [];
		try {
			for await (const dirent of directory) {
				if (entries.length >= maxEntries) {
					return refuse(
						"entry-capped",
						display,
						`${display} has more than ${maxEntries} entries; the walk cap is ${SAFE_READ_LIMITS.maxDirectoryEntries}`,
					);
				}
				const name = dirent.name;
				const problem = validateComponent(name);
				if (problem) return refuse("unsafe-path", this.#childPath(name), `${problem}: ${JSON.stringify(name)}`);
				const kind = await classifyEntry(this.#candidate(name), dirent);
				entries.push({ name, kind });
			}
		} finally {
			await directory.close().catch(() => undefined);
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		return { kind: "ok", value: entries };
	}
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

async function openDirectoryAt(
	base: string,
	rootComponents: readonly string[],
	relativeComponents: readonly string[],
): Promise<SafeReadResult<SafeDirectory>> {
	let current: FileHandle;
	try {
		current = await open("/", DIRECTORY_FLAGS);
	} catch (error) {
		return refuse("unreadable", "/", `cannot open the filesystem root: ${(error as Error).message}`);
	}

	let absoluteDisplay = "";
	for (const component of rootComponents) {
		absoluteDisplay = `${absoluteDisplay}/${component}`;
		const candidate = `${base}/${current.fd}/${component}`;
		try {
			const next = await open(candidate, DIRECTORY_FLAGS);
			const info = await next.stat();
			if (!info.isDirectory()) {
				const kind = describeStats(info);
				await next.close().catch(() => undefined);
				await current.close().catch(() => undefined);
				return refuse("not-directory", absoluteDisplay, `${absoluteDisplay} is a ${kind}, not a directory`);
			}
			await current.close().catch(() => undefined);
			current = next;
		} catch (error) {
			const result = await mapChildFailure<SafeDirectory>(error, candidate, absoluteDisplay, "directory");
			await current.close().catch(() => undefined);
			return result;
		}
	}

	let relativeDisplay = "";
	for (const component of relativeComponents) {
		relativeDisplay = relativeDisplay ? `${relativeDisplay}/${component}` : component;
		const candidate = `${base}/${current.fd}/${component}`;
		try {
			const next = await open(candidate, DIRECTORY_FLAGS);
			const info = await next.stat();
			if (!info.isDirectory()) {
				const kind = describeStats(info);
				await next.close().catch(() => undefined);
				await current.close().catch(() => undefined);
				return refuse("not-directory", relativeDisplay, `${relativeDisplay} is a ${kind}, not a directory`);
			}
			await current.close().catch(() => undefined);
			current = next;
		} catch (error) {
			const result = await mapChildFailure<SafeDirectory>(error, candidate, relativeDisplay, "directory");
			await current.close().catch(() => undefined);
			return result;
		}
	}

	return { kind: "ok", value: new PinnedDirectory(current, relativeDisplay, base) };
}

/** Open a pinned directory under a canonical root. Close the result. */
export async function openSafeDirectory(request: SafeDirectoryRef): Promise<SafeReadResult<SafeDirectory>> {
	const root = parseRoot(request.root);
	if (!root.ok) return refuse("unsafe-root", String(request.root), root.message);
	const relative = parseRelativePath(request.path ?? "", true);
	if (!relative.ok) return refuse("unsafe-path", String(request.path ?? ""), relative.message);
	const primitive = await resolvePrimitive(request.procFdBase);
	if (!primitive.ok) return refuse("unsupported-platform", String(request.root), primitive.message);
	return openDirectoryAt(primitive.base, root.components, relative.components);
}

/** Open one pinned regular file under a canonical root. Close the result. */
export async function openSafeFile(
	request: SafeDirectoryRef & { path: string },
): Promise<SafeReadResult<SafeFile>> {
	const root = parseRoot(request.root);
	if (!root.ok) return refuse("unsafe-root", String(request.root), root.message);
	const relative = parseRelativePath(request.path, false);
	if (!relative.ok) return refuse("unsafe-path", request.path, relative.message);
	const primitive = await resolvePrimitive(request.procFdBase);
	if (!primitive.ok) return refuse("unsupported-platform", request.path, primitive.message);
	const components = relative.components;
	const name = components.at(-1);
	if (name === undefined) return refuse("unsafe-path", request.path, "path must name a file inside the root");
	const directory = await openDirectoryAt(primitive.base, root.components, components.slice(0, -1));
	if (directory.kind !== "ok") return directory;
	try {
		return await directory.value.openFile(name);
	} finally {
		await directory.value.close();
	}
}

/** Read one capped regular file. Absent/refused are distinct results. */
export async function readSafeFile(request: SafeFileRequest): Promise<SafeReadResult<Buffer>> {
	const opened = await openSafeFile(request);
	if (opened.kind !== "ok") return opened;
	try {
		return await opened.value.readBytes({ maxBytes: request.maxBytes, budget: request.budget });
	} finally {
		await opened.value.close();
	}
}

/** Read one capped regular file as strict UTF-8 text (NUL and invalid UTF-8 refuse). */
export async function readSafeText(request: SafeFileRequest): Promise<SafeReadResult<string>> {
	const opened = await openSafeFile(request);
	if (opened.kind !== "ok") return opened;
	try {
		return await opened.value.readText({ maxBytes: request.maxBytes, budget: request.budget });
	} finally {
		await opened.value.close();
	}
}

/** List one directory without following any entry; the entry cap is a refusal. */
export async function listSafeDirectory(
	request: SafeListRequest,
): Promise<SafeReadResult<readonly SafeDirEntry[]>> {
	const opened = await openSafeDirectory(request);
	if (opened.kind !== "ok") return opened;
	try {
		return await opened.value.list({ maxEntries: request.maxEntries });
	} finally {
		await opened.value.close();
	}
}

interface WalkState {
	count: number;
	maxEntries: number;
	files: string[];
	directories: string[];
}

async function walkDirectory(
	directory: SafeDirectory,
	prefix: string,
	state: WalkState,
): Promise<SafeReadResult<void>> {
	const listing = await directory.list({ maxEntries: state.maxEntries - state.count });
	if (listing.kind === "absent") return listing;
	if (listing.kind === "refused") return listing;

	for (const entry of listing.value) {
		state.count += 1;
		if (state.count > state.maxEntries) {
			return refuse("entry-capped", prefix, `walk exceeded ${state.maxEntries} entries`);
		}
		const child = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (Buffer.byteLength(child, "utf8") > SAFE_READ_LIMITS.maxPathBytes) {
			return refuse("unsafe-path", child, `walked path exceeds ${SAFE_READ_LIMITS.maxPathBytes} UTF-8 bytes`);
		}
		if (entry.kind === "symlink") {
			return refuse("symlink", child, `${child} is a symbolic link; host walks never follow links`);
		}
		if (entry.kind === "other") {
			return refuse("not-regular", child, `${child} is not a regular file or directory`);
		}
		if (entry.kind === "file") {
			state.files.push(child);
			continue;
		}
		const opened = await directory.openDirectory(entry.name);
		if (opened.kind === "absent") {
			return refuse("changed", child, `${child} vanished while the walk was running`);
		}
		if (opened.kind !== "ok") return opened;
		state.directories.push(child);
		try {
			const nested = await walkDirectory(opened.value, child, state);
			if (nested.kind !== "ok") return nested;
		} finally {
			await opened.value.close();
		}
	}
	return { kind: "ok", value: undefined };
}

/**
 * Walk regular files/directories below a path without following links. The
 * result is root-relative and sorted; any symlink, FIFO/socket/device, unsafe
 * name or entry-count excess refuses the whole walk.
 */
export async function walkSafeFiles(request: SafeWalkRequest): Promise<SafeReadResult<SafeTreeListing>> {
	const opened = await openSafeDirectory(request);
	if (opened.kind !== "ok") return opened;
	const prefix = opened.value.path;
	const state: WalkState = {
		count: 0,
		maxEntries: effectiveEntries(request.maxEntries),
		files: [],
		directories: [],
	};
	try {
		const walked = await walkDirectory(opened.value, prefix, state);
		if (walked.kind !== "ok") return walked;
		return {
			kind: "ok",
			value: { files: state.files.sort(), directories: state.directories.sort() },
		};
	} finally {
		await opened.value.close();
	}
}

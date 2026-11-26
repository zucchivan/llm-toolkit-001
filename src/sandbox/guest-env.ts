import {
	ExecutionError,
	FileError,
} from "../engine/kit.ts";
import type {
	BinaryReader,
	Context,
	DirReader,
	ExecutionEnv,
	ExecutionErrorCode,
	FileChange,
	FileErrorCode,
	FileInfo,
	FileListing,
	FileWatcher,
	ListFilesOptions,
	Result,
	ShellExecOptions,
	ShellExecResult,
	TextLine,
	TextLineReader,
	WatchTarget,
} from "../engine/kit.ts";
import { BACKGROUND_CONTEXT } from "../engine/kit.ts";
import {
	GUEST_PROTOCOL_VERSION,
	GuestProtocolError,
	MAX_CHUNK_BYTES,
	encodeGuestFrame,
	parseGuestResponse,
	readGuestFrame,
	type GuestResponseFrame,
	type GuestWireFailure,
} from "./protocol.ts";
import { isGuestRole } from "./types.ts";
import type { GuestByteStream, GuestRole } from "./types.ts";

const FILE_CODES: readonly FileErrorCode[] = ["aborted", "not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "unknown"];
const EXECUTION_CODES: readonly ExecutionErrorCode[] = ["aborted", "timeout", "shell_unavailable", "spawn_error", "callback_error", "unknown"];

interface GuestEnvOptions {
	stream: GuestByteStream;
	leaseId: string;
	role: GuestRole;
	cwd: string;
}

interface PendingRequest {
	resolve(value: GuestResponseFrame): void;
	reject(error: Error): void;
	onEvent?: (event: string, data: unknown) => void;
	eventError?: unknown;
}

class GuestOperationCancelledBeforeDispatch extends Error {
	constructor() { super("operation aborted before guest dispatch"); }
}

/**
 * Pinned ExecutionEnv adapter for one already-created guest stream. It never
 * opens host files or processes; every effect is an explicit v1 guest op.
 */
export class GuestEnv implements ExecutionEnv {
	readonly id: string;
	cwd: string;
	readonly ready: Promise<void>;
	private readonly pending = new Map<string, PendingRequest>();
	private sequence = 0;
	private writeTail: Promise<void> = Promise.resolve();
	private closed = false;
	private cleaning = false;
	private failure?: Error;
	private cleanupPromise?: Promise<void>;

	constructor(private readonly options: GuestEnvOptions) {
		if (!isGuestRole(options.role)) throw new TypeError("unknown guest role");
		if (!validLeaseId(options.leaseId)) throw new TypeError("invalid guest lease id");
		if (!isGuestCwd(options.cwd)) throw new TypeError("invalid guest cwd");
		this.id = `guest-v${GUEST_PROTOCOL_VERSION}:${options.leaseId}`;
		this.cwd = options.cwd;
		void this.receiveLoop();
		this.ready = this.handshake();
	}

	private async handshake(): Promise<void> {
		const response = await this.exchange("hello", {
			leaseId: this.options.leaseId,
			role: this.options.role,
			cwd: this.options.cwd,
		}, BACKGROUND_CONTEXT, undefined, true);
		if (!response.ok) throw new GuestProtocolError("guest lease handshake was refused");
		const final = response.value;
		if (final.kind !== "final" || typeof final.value !== "object" || final.value === null ||
			(final.value as { namespaceId?: unknown }).namespaceId !== this.id) {
			throw new GuestProtocolError("guest lease handshake returned the wrong namespace");
		}
	}

	private async receiveLoop(): Promise<void> {
		try {
			while (!this.closed) {
				const raw = await readGuestFrame(this.options.stream);
				if (raw === undefined) throw new GuestProtocolError("guest stream closed");
				const response = parseGuestResponse(raw);
				const pending = this.pending.get(response.id);
				if (!pending) throw new GuestProtocolError("response id does not match an in-flight operation");
				if (!response.ok) {
					this.pending.delete(response.id);
					pending.resolve(response);
				} else if (response.value.kind === "event") {
					try {
						if (!pending.onEvent) throw new GuestProtocolError("unexpected guest response event");
						pending.onEvent(response.value.event, response.value.data);
					} catch (error) {
						pending.eventError = error;
						void this.sendCancellation(response.id);
					}
				} else {
					this.pending.delete(response.id);
					pending.resolve(response);
				}
			}
		} catch (error) {
			this.fail(error instanceof Error ? error : new GuestProtocolError("guest stream failed"));
		}
	}

	private fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		this.closed = true;
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			pending.reject(error);
		}
		void this.options.stream.close().catch(() => undefined);
	}

	private async sendCancellation(targetId: string): Promise<void> {
		try {
			await this.exchange("cancel", { targetId }, BACKGROUND_CONTEXT, undefined, true);
		} catch {
			// The original request remains pending. A closed stream fails it closed.
		}
	}

	private async exchange(
		op: string,
		args: Record<string, unknown>,
		context: Context,
		onEvent?: (event: string, data: unknown) => void,
		skipReady = false,
	): Promise<GuestResponseFrame> {
		if (!skipReady) await this.ready;
		if (this.failure) throw this.failure;
		if (this.closed || (this.cleaning && op !== "env.cleanup" && op !== "cancel")) throw new GuestProtocolError("guest environment is closed");
		if (context.abortSignal?.aborted) throw new GuestOperationCancelledBeforeDispatch();
		const id = `op-${++this.sequence}`;
		const frame = encodeGuestFrame({ v: 1, id, op, args });
		let pendingRecord: PendingRequest | undefined;
		const result = new Promise<GuestResponseFrame>((resolve, reject) => {
			pendingRecord = { resolve, reject, onEvent };
			this.pending.set(id, pendingRecord);
		});
		const signal = context.abortSignal;
		const cancel = () => { void this.sendCancellation(id); };
		signal?.addEventListener("abort", cancel, { once: true });
		try {
			const write = this.writeTail.then(() => {
				if (this.closed) throw this.failure ?? new GuestProtocolError("guest environment is closed");
				return this.options.stream.write(frame);
			});
			this.writeTail = write.catch((error: unknown) => {
				this.fail(error instanceof Error ? error : new GuestProtocolError("guest transport write failed"));
			});
			await write;
			const response = await result;
			const eventError = pendingRecord?.eventError;
			if (eventError instanceof GuestProtocolError) {
				this.fail(eventError);
				throw eventError;
			}
			if (eventError !== undefined) throw new ExecutionError("callback_error", safeMessage(eventError));
			return response;
		} catch (error) {
			this.pending.delete(id);
			if (error instanceof ExecutionError && error.code === "callback_error") throw error;
			const failure = error instanceof Error ? error : new GuestProtocolError("guest request failed");
			this.fail(failure);
			throw failure;
		} finally {
			signal?.removeEventListener("abort", cancel);
		}
	}

	private async fileCall<T>(op: string, args: Record<string, unknown>, context: Context, onEvent?: (event: string, data: unknown) => void): Promise<Result<T, FileError>> {
		try {
			const response = await this.exchange(op, args, context, onEvent);
			if (!response.ok) return { ok: false, error: fileError(response.code) };
			if (response.value.kind !== "final") return { ok: false, error: new FileError("invalid", "missing final guest response") };
			return { ok: true, value: response.value.value as T };
		} catch (error) {
			return { ok: false, error: fileTransportError(error, context) };
		}
	}

	private cwdArgs(): { cwd: string } { return { cwd: this.cwd }; }

	absolutePath(path: string, context: Context) {
		return this.fileCall<string>("fs.absolute", { ...this.cwdArgs(), path }, context);
	}
	joinPath(parts: string[], context: Context) {
		return this.fileCall<string>("fs.join", { ...this.cwdArgs(), parts }, context);
	}
	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		let text = "";
		const result = await this.fileCall<null>("fs.readTextFile", { ...this.cwdArgs(), path }, context, (event, data) => {
			if (event !== "text") throw new GuestProtocolError("unexpected text file event");
			if (!isRecord(data) || typeof data.text !== "string" || utf8Length(data.text) > MAX_CHUNK_BYTES) throw new GuestProtocolError("invalid text chunk");
			text += data.text;
		});
		return result.ok ? { ok: true, value: text } : result;
	}
	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const result = await this.fileCall<string>("fs.line.open", { ...this.cwdArgs(), path }, context);
		if (!result.ok) return result;
		const handle = result.value;
		let closed = false;
		return { ok: true, value: {
			readLine: async (cx) => {
				if (closed || this.closed) return { ok: false, error: new FileError("invalid", "Text line reader is closed", path) };
				let text = "";
				let finalLine: { terminated?: boolean; eof?: boolean } | undefined;
				const reply = await this.fileCall<void>("fs.line.read", { handle }, cx, (event, data) => {
					if (event === "text") {
						if (!isRecord(data) || typeof data.text !== "string" || utf8Length(data.text) > MAX_CHUNK_BYTES) throw new GuestProtocolError("invalid line chunk");
						text += data.text;
					} else if (event === "line") {
						if (!isRecord(data) || typeof data.terminated !== "boolean" || typeof data.eof !== "boolean") throw new GuestProtocolError("invalid line terminator");
						finalLine = { terminated: data.terminated, eof: data.eof };
					} else throw new GuestProtocolError("unexpected line reader event");
				});
				if (!reply.ok) return reply;
				if (!finalLine) return { ok: false, error: new FileError("invalid", "line response was incomplete", path) };
				return { ok: true, value: finalLine.eof ? undefined : { text, terminated: finalLine.terminated! } };
			},
			close: async (cx) => { if (!closed) { closed = true; if (!this.closed) await this.fileCall<void>("fs.line.close", { handle }, cx); } },
		} };
	}
	async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return { ok: true, value: [] };
		const opened = await this.openTextLineReader(path, context);
		if (!opened.ok) return opened;
		const lines: string[] = [];
		try {
			while (options?.maxLines === undefined || lines.length < options.maxLines) {
				const line = await opened.value.readLine(context);
				if (!line.ok) return line;
				if (line.value === undefined) break;
				lines.push(line.value.text);
			}
			return { ok: true, value: lines };
		} finally { await opened.value.close(BACKGROUND_CONTEXT); }
	}
	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const chunks: Uint8Array[] = [];
		const result = await this.fileCall<null>("fs.readBinaryFile", { ...this.cwdArgs(), path }, context, (event, data) => {
			if (event !== "bytes" || !isRecord(data) || typeof data.base64 !== "string") throw new GuestProtocolError("invalid binary file event");
			const bytes = fromBase64(data.base64);
			if (bytes.byteLength > MAX_CHUNK_BYTES) throw new GuestProtocolError("binary file chunk exceeds 64 KiB");
			chunks.push(bytes);
		});
		return result.ok ? { ok: true, value: concatBytes(chunks) } : result;
	}
	openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
		return this.fileCall<string>("fs.binary.open", { ...this.cwdArgs(), path, options }, context).then((opened) => {
			if (!opened.ok) return opened;
			const handle = opened.value;
			let closed = false;
			const checkClosed = <T>(): Result<T, FileError> => ({ ok: false, error: new FileError("invalid", "Binary reader is closed", path) });
			const close = async (cx: Context): Promise<void> => { if (!closed) { closed = true; if (!this.closed) await this.fileCall<void>("fs.binary.close", { handle }, cx); } };
			return { ok: true, value: {
				info: async (cx) => closed || this.closed ? checkClosed() : this.fileCall<FileInfo>("fs.binary.info", { handle }, cx),
				read: async (offset, length, cx) => {
					if (closed || this.closed) return checkClosed();
					if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) return { ok: false, error: new FileError("invalid", "Offset and length must be non-negative safe integers", path) };
					const pieces: Uint8Array[] = [];
					for (let consumed = 0; consumed < length;) {
						const wanted = Math.min(MAX_CHUNK_BYTES, length - consumed);
						const part = await this.fileCall<string>("fs.binary.read", { handle, offset: offset + consumed, length: wanted }, cx);
						if (!part.ok) return part;
						const bytes = fromBase64(part.value);
						if (bytes.length > MAX_CHUNK_BYTES || bytes.length > wanted) return { ok: false, error: new FileError("invalid", "guest returned an oversized byte chunk", path) };
						pieces.push(bytes);
						consumed += bytes.length;
						if (bytes.length < wanted) break;
					}
					return { ok: true, value: concatBytes(pieces) };
				},
				scanLines: async (scan, cx) => closed || this.closed ? checkClosed() : this.fileCall("fs.binary.scanLines", { handle, options: scan }, cx),
				close,
			} };
		});
	}
	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.upload("fs.write", path, typeof content === "string" ? new TextEncoder().encode(content) : content, context);
	}
	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.upload("fs.append", path, typeof content === "string" ? new TextEncoder().encode(content) : content, context);
	}
	private async upload(op: "fs.write" | "fs.append", path: string, bytes: Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const begin = await this.fileCall<string>(`${op}.begin`, { ...this.cwdArgs(), path }, context);
		if (!begin.ok) return begin;
		const uploadId = begin.value;
		let committed = false;
		try {
			for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK_BYTES) {
				const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + MAX_CHUNK_BYTES));
				const sent = await this.fileCall<void>(`${op}.chunk`, { uploadId, bytes: Buffer.from(chunk).toString("base64") }, context);
				if (!sent.ok) return sent;
			}
			const result = await this.fileCall<void>(`${op}.commit`, { uploadId }, context);
			committed = result.ok;
			return result;
		} finally {
			if (!committed) await this.fileCall<void>(`${op}.abort`, { uploadId }, BACKGROUND_CONTEXT);
		}
	}
	truncateFile(path: string, size: number, context: Context) { return this.fileCall<void>("fs.truncate", { ...this.cwdArgs(), path, size }, context); }
	flushFile(path: string, context: Context) { return this.fileCall<void>("fs.flush", { ...this.cwdArgs(), path }, context); }
	renameFile(sourcePath: string, destinationPath: string, context: Context) { return this.fileCall<void>("fs.rename", { ...this.cwdArgs(), sourcePath, destinationPath }, context); }
	fileInfo(path: string, context: Context) { return this.fileCall<FileInfo>("fs.info", { ...this.cwdArgs(), path }, context); }
	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const entries: FileInfo[] = [];
		const opened = await this.openDirReader(path, context);
		if (!opened.ok) return opened;
		try {
			while (true) {
				const page = await opened.value.next(32, context);
				if (!page.ok) return page;
				entries.push(...page.value.entries);
				if (page.value.done) return { ok: true, value: entries };
			}
		} finally { await opened.value.close(BACKGROUND_CONTEXT); }
	}
	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const opened = await this.fileCall<string>("fs.dir.open", { ...this.cwdArgs(), path }, context);
		if (!opened.ok) return opened;
		const handle = opened.value;
		let closed = false;
		return { ok: true, value: {
			next: async (maxEntries, cx) => {
				if (closed || this.closed) return { ok: false, error: new FileError("invalid", "Directory reader is closed", path) };
				if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) return { ok: false, error: new FileError("invalid", "maxEntries must be a positive safe integer", path) };
				const entries: FileInfo[] = [];
				let done = false;
				while (entries.length < maxEntries && !done) {
					const count = Math.min(32, maxEntries - entries.length);
					const page = await this.fileCall<{ entries: FileInfo[]; done: boolean }>("fs.dir.next", { handle, maxEntries: count }, cx);
					if (!page.ok) return page;
					entries.push(...page.value.entries);
					done = page.value.done;
				}
				return { ok: true, value: { entries, done } };
			},
			close: async (cx) => { if (!closed) { closed = true; if (!this.closed) await this.fileCall<void>("fs.dir.close", { handle }, cx); } },
		} };
	}
	canonicalPath(path: string, context: Context) { return this.fileCall<string>("fs.canonical", { ...this.cwdArgs(), path }, context); }
	exists(path: string, context: Context) { return this.fileCall<boolean>("fs.exists", { ...this.cwdArgs(), path }, context); }
	createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) { return this.fileCall<void>("fs.mkdir", { ...this.cwdArgs(), path, options }, context); }
	remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) { return this.fileCall<void>("fs.remove", { ...this.cwdArgs(), path, options }, context); }
	createTempDir(prefix: string | undefined, context: Context) { return this.fileCall<string>("fs.tempDir", { prefix }, context); }
	createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context) { return this.fileCall<string>("fs.tempFile", { options }, context); }
	listFiles(_path: string, _options: ListFilesOptions | undefined, _context: Context): Promise<Result<FileListing, FileError>> {
		return Promise.resolve({ ok: false, error: new FileError("not_supported", "guest file listing optimization is not supported") });
	}
	watch(_targets: readonly WatchTarget[], _onChange: (change: FileChange) => void, _context: Context): Promise<Result<FileWatcher, FileError>> {
		return Promise.resolve({ ok: false, error: new FileError("not_supported", "guest file watching is not supported") });
	}

	async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		if (typeof command === "string" && this.options.role !== "implementer") {
			return { ok: false, error: new ExecutionError("shell_unavailable", "shell commands are only available to the implementer role") };
		}
		const { onOutput, ...serializableOptions } = options ?? {};
		try {
			const response = await this.exchange("exec", { command, cwd: this.cwd, options: serializableOptions }, context, (event, data) => {
				if (event !== "output" || !isRecord(data) || typeof data.text !== "string" || !isRecord(data.info)) throw new GuestProtocolError("invalid exec output event");
				if (utf8Length(data.text) > MAX_CHUNK_BYTES) throw new GuestProtocolError("exec output chunk exceeds byte limit");
				onOutput?.(data.text, context, data.info as any);
			});
			if (!response.ok) return { ok: false, error: executionError(response.code) };
			if (response.value.kind !== "final") return { ok: false, error: new ExecutionError("unknown", "missing final guest response") };
			return { ok: true, value: response.value.value as ShellExecResult };
		} catch (error) {
			return { ok: false, error: executionTransportError(error, context) };
		}
	}

	async cleanup(_context: Context): Promise<void> {
		if (this.cleanupPromise) return this.cleanupPromise;
		if (this.closed) return;
		this.cleaning = true;
		this.cleanupPromise = (async () => {
			try { await this.exchange("env.cleanup", {}, BACKGROUND_CONTEXT); } catch { /* dead transport cannot confirm helper cleanup */ }
			this.closed = true;
			await this.options.stream.close().catch(() => undefined);
		})();
		return this.cleanupPromise;
	}
}

function fileError(failure: GuestWireFailure): FileError {
	if (failure.domain !== "file") return new FileError("invalid", failure.message);
	const code = FILE_CODES.includes(failure.code as FileErrorCode) ? failure.code as FileErrorCode : "unknown";
	return new FileError(code, failure.message, failure.path);
}
function executionError(failure: GuestWireFailure): ExecutionError {
	if (failure.domain !== "execution") return new ExecutionError("unknown", failure.message);
	const code = EXECUTION_CODES.includes(failure.code as ExecutionErrorCode) ? failure.code as ExecutionErrorCode : "unknown";
	const error = new ExecutionError(code, failure.message);
	if (failure.spillPath !== undefined) error.spillPath = failure.spillPath;
	return error;
}
function fileTransportError(error: unknown, context: Context): FileError {
	if (error instanceof FileError) return error;
	if (error instanceof GuestOperationCancelledBeforeDispatch) return new FileError("aborted", "aborted");
	void context;
	return new FileError(error instanceof GuestProtocolError && error.message.includes("invalid") ? "invalid" : "not_supported", error instanceof GuestProtocolError ? error.message : "guest transport failed");
}
function executionTransportError(error: unknown, context: Context): ExecutionError {
	if (error instanceof ExecutionError) return error;
	if (error instanceof GuestOperationCancelledBeforeDispatch) return new ExecutionError("aborted", "aborted");
	void context;
	return new ExecutionError("unknown", error instanceof GuestProtocolError ? error.message : "guest transport failed");
}
function validLeaseId(value: string): boolean { return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value); }
function isGuestCwd(value: unknown): value is string { return typeof value === "string" && value.startsWith("/") && !value.includes("\0"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 512) : "output callback failed"; }
function utf8Length(value: string): number { return new TextEncoder().encode(value).byteLength; }
function fromBase64(value: string): Uint8Array {
	if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new GuestProtocolError("invalid base64 byte chunk");
	return new Uint8Array(Buffer.from(value, "base64"));
}
function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
	const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const joined = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
	return joined;
}

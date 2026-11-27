import { NodeExecutionEnv, ExecutionError, FileError, BACKGROUND_CONTEXT, withAbortSignal } from "../engine/kit.ts";
import type {
	BinaryReader,
	Context,
	DirReader,
	ExecutionErrorCode,
	FileErrorCode,
	FileInfo,
	FileListing,
	Result,
	ShellExecOptions,
	TextLineReader,
} from "../engine/kit.ts";
import { MAX_CHUNK_BYTES, GuestProtocolError, encodeGuestFrame, parseGuestRequest, readGuestFrame, writeGuestFrame } from "./protocol.ts";
import type { GuestRequestFrame, GuestWireFailure } from "./protocol.ts";
import { isGuestRole } from "./types.ts";
import type { GuestByteStream, GuestRole } from "./types.ts";

const RECIPE_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const MAX_QUEUED_OUTPUT_BYTES = 1024 * 1024;
const GUEST_SHELL_PATH = "/bin/bash";
const GUEST_HOME = "/home/worker";
const GUEST_SHELL_ENV = { HOME: "/home/worker", PATH: "/usr/bin:/bin", TMPDIR: "/run/kit-tmp" };
const ALLOWED_FILE_CODES: readonly FileErrorCode[] = ["aborted", "not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "unknown"];
const ALLOWED_EXEC_CODES: readonly ExecutionErrorCode[] = ["aborted", "timeout", "shell_unavailable", "spawn_error", "callback_error", "unknown"];

interface GuestHelperOptions {
	stream: GuestByteStream;
	leaseId: string;
	role: GuestRole;
	cwd: string;
}

interface GuestHelperHandle {
	done: Promise<void>;
	close(): Promise<void>;
}

type Handle =
	| { kind: "binary"; value: BinaryReader }
	| { kind: "line"; value: TextLineReader }
	| { kind: "dir"; value: DirReader };
interface InFlight { controller: AbortController; settled: Promise<void> }
interface Upload { path: string; append: boolean; chunks: Uint8Array[]; bytes: number }

/** Start the fixed helper loop. The caller must run this module inside the guest. */
export function startGuestHelper(options: GuestHelperOptions): GuestHelperHandle {
	if (!isGuestRole(options.role)) throw new TypeError("unknown guest role");
	if (!validLeaseId(options.leaseId)) throw new TypeError("invalid guest lease id");
	if (!isGuestCwd(options.cwd)) throw new TypeError("invalid guest cwd");
	const helper = new GuestHelper(options);
	const done = helper.run();
	return { done, close: () => helper.close() };
}

class GuestHelper {
	private readonly env: NodeExecutionEnv;
	private readonly handles = new Map<string, Handle>();
	private readonly uploads = new Map<string, Upload>();
	private readonly inFlight = new Map<string, InFlight>();
	private readonly seenRequestIds = new Set<string>();
	private writeTail: Promise<void> = Promise.resolve();
	private transportFailed = false;
	private handleSequence = 0;
	private uploadSequence = 0;
	private phase: "hello" | "active" | "closing" | "closed" = "hello";
	private cleanupPromise?: Promise<void>;
	private readonly controlTasks = new Set<Promise<void>>();

	constructor(private readonly options: GuestHelperOptions) {
		// This construction intentionally has no cwd fallback, PATH lookup,
		// configurable shell, or caller-selected environment.
		this.env = new NodeExecutionEnv({ cwd: options.cwd, shellPath: GUEST_SHELL_PATH, shellEnv: GUEST_SHELL_ENV });
	}

	async run(): Promise<void> {
		try {
			const first = await readGuestFrame(this.options.stream);
			if (first === undefined) return;
			const hello = parseGuestRequest(first);
			if (hello.op !== "hello") {
				await this.sendFailure(hello.id, { domain: "protocol", code: "invalid", message: "guest handshake required" });
				return;
			}
			if (!this.acceptHello(hello)) {
				await this.sendFailure(hello.id, { domain: "protocol", code: "invalid", message: "guest lease identity or role refused" });
				return;
			}
			this.seenRequestIds.add(hello.id);
			this.phase = "active";
			await this.sendFinal(hello.id, { namespaceId: `guest-v1:${this.options.leaseId}` });
			while (this.phase === "active") {
				const raw = await readGuestFrame(this.options.stream);
				if (raw === undefined) break;
				const request = parseGuestRequest(raw);
				if (this.seenRequestIds.has(request.id)) throw new GuestProtocolError("duplicate guest request id");
				this.seenRequestIds.add(request.id);
				if (request.op === "cancel") this.trackControl(this.cancel(request));
				else if (request.op === "env.cleanup") this.trackControl(this.cleanupRequest(request));
				else this.dispatch(request);
			}
		} catch {
			// Malformed data and transport failures close the lease. No host
			// exception, stack, or dynamic method name crosses the protocol.
		} finally {
			await Promise.allSettled(this.controlTasks);
			await this.shutdown();
			this.phase = "closed";
			await this.options.stream.close().catch(() => undefined);
		}
	}

	private acceptHello(request: GuestRequestFrame): boolean {
		const { leaseId, role, cwd } = request.args;
		return leaseId === this.options.leaseId && role === this.options.role && cwd === this.options.cwd && isGuestRole(role);
	}

	private trackControl(task: Promise<void>): void {
		this.controlTasks.add(task);
		void task.then(() => this.controlTasks.delete(task), () => this.controlTasks.delete(task));
	}

	private dispatch(request: GuestRequestFrame): void {
		const controller = new AbortController();
		const context = this.context(controller.signal);
		const settled = this.execute(request.op, request.args, context, (event, data) => this.sendEvent(request.id, event, data))
			.then((value) => this.sendFinal(request.id, value))
			.catch(async (error: unknown) => {
				try { await this.sendFailure(request.id, serializeFailure(error, request.op.startsWith("exec"))); }
				catch { this.failTransport(); }
			})
			.finally(() => this.inFlight.delete(request.id));
		this.inFlight.set(request.id, { controller, settled });
	}

	private async cancel(request: GuestRequestFrame): Promise<void> {
		const targetId = request.args.targetId;
		if (typeof targetId !== "string") {
			await this.sendFailure(request.id, { domain: "protocol", code: "invalid", message: "invalid cancellation target" });
			return;
		}
		const target = this.inFlight.get(targetId);
		if (!target) {
			await this.sendFailure(request.id, { domain: "file", code: "invalid", message: "operation is no longer in flight" });
			return;
		}
		target.controller.abort();
		await target.settled;
		await this.sendFinal(request.id, { cancelled: true });
	}

	private async cleanupRequest(request: GuestRequestFrame): Promise<void> {
		if (this.phase !== "active") {
			await this.sendFailure(request.id, { domain: "file", code: "invalid", message: "guest lease is not active" });
			return;
		}
		this.phase = "closing";
		await this.shutdown();
		await this.sendFinal(request.id, null);
		this.phase = "closed";
		await this.options.stream.close().catch(() => undefined);
	}

	private async shutdown(): Promise<void> {
		if (this.cleanupPromise) return this.cleanupPromise;
		this.cleanupPromise = (async () => {
			this.phase = this.phase === "hello" ? "closed" : "closing";
			for (const op of this.inFlight.values()) op.controller.abort();
			await Promise.allSettled([...this.inFlight.values()].map((op) => op.settled));
			for (const handle of this.handles.values()) {
				try {
					if (handle.kind === "binary") await handle.value.close(BACKGROUND_CONTEXT);
					else if (handle.kind === "line") await handle.value.close(BACKGROUND_CONTEXT);
					else await handle.value.close(BACKGROUND_CONTEXT);
				} catch { /* best effort resource close after fencing */ }
			}
			this.handles.clear();
			this.uploads.clear();
			await this.env.cleanup(BACKGROUND_CONTEXT).catch(() => undefined);
		})();
		return this.cleanupPromise;
	}

	private context(signal: AbortSignal): Context {
		return withAbortSignal(signal, BACKGROUND_CONTEXT);
	}

	private async execute(
		op: string,
		args: Record<string, unknown>,
		context: Context,
		emit: (event: string, data: unknown) => Promise<void>,
	): Promise<unknown> {
		if (this.phase !== "active") throw new FileError("invalid", "guest lease is closing");
		if (requiresWritableRole(op) && this.options.role !== "implementer") throw new FileError("permission_denied", "operation is not allowed for this guest role");
		if (op === "exec") return this.exec(args, context, emit);
		switch (op) {
			case "fs.absolute": return unwrap(await this.env.absolutePath(this.path(args), context));
			case "fs.join": {
				this.setGuestCwd(args.cwd);
				return unwrap(await this.env.joinPath(stringArray(args.parts).map(expandGuestHome), context));
			}
			case "fs.readTextFile": {
				const text = unwrap(await this.env.readTextFile(this.path(args), context));
				await sendTextEvents(emit, "text", text);
				return null;
			}
			case "fs.line.open": return this.addHandle("line", unwrap(await this.env.openTextLineReader(this.path(args), context)));
			case "fs.line.read": {
				const line = unwrap(await this.getHandle<TextLineReader>(args.handle, "line").readLine(context));
				if (line) await sendTextEvents(emit, "text", line.text);
				await emit("line", { eof: line === undefined, terminated: line?.terminated ?? false });
				return null;
			}
			case "fs.line.close": return this.closeHandle(args.handle, "line");
			case "fs.readBinaryFile": {
				const bytes = unwrap(await this.env.readBinaryFile(this.path(args), context));
				await sendBytesEvents(emit, bytes);
				return null;
			}
			case "fs.binary.open": return this.addHandle("binary", unwrap(await this.env.openBinaryReader(this.path(args), args.options as { noFollow?: boolean } | undefined, context)));
			case "fs.binary.info": return unwrap(await this.getHandle<BinaryReader>(args.handle, "binary").info(context));
			case "fs.binary.read": {
				const length = safeInteger(args.length, "length");
				if (length > MAX_CHUNK_BYTES) throw new FileError("invalid", "binary read chunk exceeds 64 KiB");
				const bytes = unwrap(await this.getHandle<BinaryReader>(args.handle, "binary").read(safeInteger(args.offset, "offset"), length, context));
				return Buffer.from(bytes).toString("base64");
			}
			case "fs.binary.scanLines": return unwrap(await this.getHandle<BinaryReader>(args.handle, "binary").scanLines(args.options as { startLine: number; endLine?: number }, context));
			case "fs.binary.close": return this.closeHandle(args.handle, "binary");
			case "fs.write.begin": return this.beginUpload(args, false, context);
			case "fs.write.chunk": return this.uploadChunk(args);
			case "fs.write.commit": return this.commitUpload(args, context, false);
			case "fs.write.abort": return this.abortUpload(args);
			case "fs.append.begin": return this.beginUpload(args, true, context);
			case "fs.append.chunk": return this.uploadChunk(args);
			case "fs.append.commit": return this.commitUpload(args, context, true);
			case "fs.append.abort": return this.abortUpload(args);
			case "fs.truncate": return unwrap(await this.env.truncateFile(this.path(args), safeInteger(args.size, "size"), context));
			case "fs.flush": return unwrap(await this.env.flushFile(this.path(args), context));
			case "fs.rename": return unwrap(await this.env.renameFile(this.pathArg(args.sourcePath, args.cwd), this.pathArg(args.destinationPath, args.cwd), context));
			case "fs.info": return unwrap(await this.env.fileInfo(this.path(args), context));
			case "fs.dir.open": return this.addHandle("dir", unwrap(await this.env.openDirReader(this.path(args), context)));
			case "fs.dir.next": {
				const count = safeInteger(args.maxEntries, "maxEntries");
				if (count <= 0 || count > 32) throw new FileError("invalid", "directory page size must be between 1 and 32");
				return unwrap(await this.getHandle<DirReader>(args.handle, "dir").next(count, context));
			}
			case "fs.dir.close": return this.closeHandle(args.handle, "dir");
			case "fs.canonical": return unwrap(await this.env.canonicalPath(this.path(args), context));
			case "fs.exists": return unwrap(await this.env.exists(this.path(args), context));
			case "fs.mkdir": return unwrap(await this.env.createDir(this.path(args), args.options as { recursive?: boolean } | undefined, context));
			case "fs.remove": return unwrap(await this.env.remove(this.path(args), args.options as { recursive?: boolean; force?: boolean } | undefined, context));
			case "fs.tempDir": return unwrap(await this.env.createTempDir(typeof args.prefix === "string" ? args.prefix : undefined, context));
			case "fs.tempFile": return unwrap(await this.env.createTempFile(args.options as { prefix?: string; suffix?: string } | undefined, context));
			case "fs.listFiles": throw new FileError("not_supported", "guest file listing optimization is not supported");
			case "fs.watch": throw new FileError("not_supported", "guest file watching is not supported");
			case "cancel":
			case "env.cleanup": throw new FileError("invalid", "operation is handled by the lease dispatcher");
			default: throw new GuestProtocolError("unknown guest operation");
		}
	}

	private async exec(args: Record<string, unknown>, context: Context, emit: (event: string, data: unknown) => Promise<void>): Promise<unknown> {
		const cwd = this.setGuestCwd(args.cwd);
		const command = args.command;
		if (typeof command === "string") {
			if (this.options.role !== "implementer") throw new ExecutionError("shell_unavailable", "shell strings are only available to coding tools");
		} else if (!Array.isArray(command) || command.some((part) => typeof part !== "string")) {
			throw new ExecutionError("spawn_error", "exec command must be a string or literal argv");
		} else if (this.options.role !== "implementer" && this.options.role !== "gate" && this.options.role !== "probe") {
			throw new ExecutionError("shell_unavailable", "direct commands are not allowed for this guest role");
		}
		const options = validateExecOptions(args.options, cwd);
		const safeEnvironment = {
			...(options.inheritEnv === false ? {} : GUEST_SHELL_ENV),
			...(options.env ?? {}),
		};
		const perStream = new Map<string, { bytes: number; newlines: number; endsWithNewline: boolean }>();
		let queuedBytes = 0;
		let sendTail: Promise<void> = Promise.resolve();
		const queueOutput = (text: string, stream: "stdout" | "stderr", skipped?: { bytes: number; newlines: number; endsWithNewline: boolean }) => {
			const parts = splitText(text, MAX_CHUNK_BYTES);
			for (const part of parts) {
				const size = utf8Size(part);
				queuedBytes += size;
				if (queuedBytes > MAX_QUEUED_OUTPUT_BYTES) throw new Error("guest output transport is backpressured");
				const data = { text: part, info: { stream, ...(skipped ? { skipped } : {}) } };
				sendTail = sendTail.then(() => emit("output", data)).finally(() => { queuedBytes -= size; });
			}
			if (text.length === 0 && skipped) sendTail = sendTail.then(() => emit("output", { text: "", info: { stream, skipped } }));
		};
		const result = await this.env.exec(command as string | readonly string[], {
			...options,
			env: safeEnvironment,
			// NodeExecutionEnv's inheritEnv=true merges helper process.env. Supply
			// only the fixed guest environment and per-call guest values instead.
			inheritEnv: false,
			onOutput: (text, _cx, info) => {
				if (this.options.role !== "gate" && this.options.role !== "probe") {
					queueOutput(text, info.stream);
					return;
				}
				const current = perStream.get(info.stream) ?? { bytes: 0, newlines: 0, endsWithNewline: false };
				const bounded = capOutput(text, current, RECIPE_OUTPUT_LIMIT_BYTES);
				perStream.set(info.stream, bounded.state);
				queueOutput(bounded.kept, info.stream);
				if (bounded.skipped) queueOutput("", info.stream, bounded.skipped);
			},
		}, context);
		await sendTail;
		return unwrap(result);
	}

	private path(args: Record<string, unknown>): string { return this.pathArg(args.path, args.cwd); }
	private pathArg(path: unknown, cwd: unknown): string {
		if (typeof path !== "string" || path.includes("\0")) throw new FileError("invalid", "invalid guest path");
		this.setGuestCwd(cwd);
		return expandGuestHome(path);
	}
	private setGuestCwd(value: unknown): string {
		if (!isGuestCwd(value)) throw new FileError("invalid", "guest cwd must be an absolute guest path");
		this.env.cwd = value;
		return value;
	}
	private addHandle<K extends Handle["kind"]>(kind: K, value: Extract<Handle, { kind: K }>["value"]): string {
		const id = `h-${++this.handleSequence}`;
		this.handles.set(id, { kind, value } as Handle);
		return id;
	}
	private getHandle<T>(id: unknown, kind: Handle["kind"]): T {
		if (typeof id !== "string") throw new FileError("invalid", "invalid guest handle");
		const handle = this.handles.get(id);
		if (!handle || handle.kind !== kind) throw new FileError("invalid", "stale or unauthorized guest handle");
		return handle.value as T;
	}
	private async closeHandle(id: unknown, kind: Handle["kind"]): Promise<void> {
		if (typeof id !== "string") throw new FileError("invalid", "invalid guest handle");
		const handle = this.handles.get(id);
		if (!handle || handle.kind !== kind) throw new FileError("invalid", "stale or unauthorized guest handle");
		this.handles.delete(id);
		await handle.value.close(BACKGROUND_CONTEXT);
	}

	private async beginUpload(args: Record<string, unknown>, append: boolean, context: Context): Promise<string> {
		const path = this.pathArg(args.path, args.cwd);
		const absolutePath = unwrap(await this.env.absolutePath(path, context));
		const uploadId = `u-${++this.uploadSequence}`;
		this.uploads.set(uploadId, { path: absolutePath, append, chunks: [], bytes: 0 });
		return uploadId;
	}
	private uploadChunk(args: Record<string, unknown>): void {
		const id = args.uploadId;
		if (typeof id !== "string") throw new FileError("invalid", "invalid upload handle");
		const upload = this.uploads.get(id);
		if (!upload) throw new FileError("invalid", "stale upload handle");
		const bytes = decodeBase64(args.bytes);
		if (bytes.byteLength > MAX_CHUNK_BYTES) throw new FileError("invalid", "upload chunk exceeds 64 KiB");
		upload.chunks.push(bytes);
		upload.bytes += bytes.byteLength;
	}
	private async commitUpload(args: Record<string, unknown>, context: Context, append: boolean): Promise<void> {
		const id = args.uploadId;
		if (typeof id !== "string") throw new FileError("invalid", "invalid upload handle");
		const upload = this.uploads.get(id);
		if (!upload || upload.append !== append) throw new FileError("invalid", "stale or unauthorized upload handle");
		const bytes = joinChunks(upload.chunks, upload.bytes);
		const result = append ? await this.env.appendFile(upload.path, bytes, context) : await this.env.writeFile(upload.path, bytes, context);
		unwrap(result);
		this.uploads.delete(id);
	}
	private abortUpload(args: Record<string, unknown>): void {
		if (typeof args.uploadId !== "string" || !this.uploads.delete(args.uploadId)) throw new FileError("invalid", "stale upload handle");
	}

	private sendFrame(frame: unknown): Promise<void> {
		const bytes = encodeGuestFrame(frame);
		const write = this.writeTail.then(() => {
			if (this.transportFailed) throw new GuestProtocolError("guest transport is closed");
			return this.options.stream.write(bytes);
		});
		this.writeTail = write.catch(() => this.failTransport());
		return write;
	}
	private failTransport(): void {
		if (this.transportFailed || this.phase === "closed") return;
		this.transportFailed = true;
		this.phase = "closing";
		for (const operation of this.inFlight.values()) operation.controller.abort();
		void this.options.stream.close().catch(() => undefined);
	}
	private sendEvent(id: string, event: string, data: unknown): Promise<void> {
		return this.sendFrame({ id, ok: true, value: { kind: "event", event, data } });
	}
	private sendFinal(id: string, value: unknown): Promise<void> {
		return this.sendFrame({ id, ok: true, value: { kind: "final", value: value === undefined ? null : value } });
	}
	private sendFailure(id: string, code: GuestWireFailure): Promise<void> {
		return this.sendFrame({ id, ok: false, code });
	}
	async close(): Promise<void> {
		await this.options.stream.close().catch(() => undefined);
		await this.shutdown();
	}
}

function requiresWritableRole(op: string): boolean {
	return op.startsWith("fs.write") || op.startsWith("fs.append") || ["fs.truncate", "fs.flush", "fs.rename", "fs.mkdir", "fs.remove", "fs.tempDir", "fs.tempFile"].includes(op);
}
function unwrap<T>(result: Result<T, FileError | ExecutionError>): T {
	if (!result.ok) throw result.error;
	return result.value;
}
function serializeFailure(error: unknown, execution: boolean): GuestWireFailure {
	if (error instanceof FileError) return { domain: "file", code: safeFileCode(error.code), message: safeMessage(error.message), ...(error.path === undefined ? {} : { path: safeMessage(error.path) }) };
	if (error instanceof ExecutionError) return { domain: "execution", code: safeExecutionCode(error.code), message: safeMessage(error.message), ...(error.spillPath === undefined ? {} : { spillPath: safeMessage(error.spillPath) }) };
	if (error instanceof GuestProtocolError) return { domain: "protocol", code: "invalid", message: safeMessage(error.message) };
	return execution
		? { domain: "execution", code: "unknown", message: "guest command failed" }
		: { domain: "file", code: "unknown", message: "guest file operation failed" };
}
function safeFileCode(code: string): FileErrorCode { return ALLOWED_FILE_CODES.includes(code as FileErrorCode) ? code as FileErrorCode : "unknown"; }
function safeExecutionCode(code: string): ExecutionErrorCode { return ALLOWED_EXEC_CODES.includes(code as ExecutionErrorCode) ? code as ExecutionErrorCode : "unknown"; }
function safeMessage(value: string): string { return value.slice(0, 512); }
function isGuestCwd(value: unknown): value is string { return typeof value === "string" && value.startsWith("/") && !value.includes("\0"); }
function stringArray(value: unknown): string[] { if (!Array.isArray(value) || value.some((part) => typeof part !== "string")) throw new FileError("invalid", "expected a string array"); return value as string[]; }
function expandGuestHome(path: string): string {
	if (path === "~") return GUEST_HOME;
	if (path.startsWith("~/")) return `${GUEST_HOME}${path.slice(1)}`;
	return path;
}
function safeInteger(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new FileError("invalid", `${name} must be a non-negative safe integer`); return value; }
function validateExecOptions(value: unknown, cwd: string): ShellExecOptions {
	if (value === undefined) return { cwd };
	if (!isRecord(value)) throw new ExecutionError("spawn_error", "invalid exec options");
	if (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.length === 0 || value.cwd.includes("\0"))) throw new ExecutionError("spawn_error", "invalid exec cwd");
	if (value.env !== undefined && (!isRecord(value.env) || Object.values(value.env).some((part) => typeof part !== "string"))) throw new ExecutionError("spawn_error", "invalid exec environment");
	return {
		cwd: typeof value.cwd === "string" ? expandGuestHome(value.cwd) : cwd,
		...(value.env === undefined ? {} : { env: value.env as Record<string, string> }),
		...(typeof value.inheritEnv === "boolean" ? { inheritEnv: value.inheritEnv } : {}),
		...(typeof value.timeout === "number" ? { timeout: value.timeout } : {}),
		...(isRecord(value.spill) ? { spill: value.spill as { afterBytes: number; afterLines: number } } : {}),
		...(isRecord(value.window) ? { window: value.window as { maxBytes: number; maxLines: number; minIntervalMs: number; bytesPerSecond: number } } : {}),
	};
}
function decodeBase64(value: unknown): Uint8Array {
	if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new FileError("invalid", "invalid base64 chunk");
	return new Uint8Array(Buffer.from(value, "base64"));
}
function joinChunks(chunks: readonly Uint8Array[], length: number): Uint8Array {
	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
	return result;
}
function utf8Size(value: string): number { return new TextEncoder().encode(value).byteLength; }
function splitText(value: string, maxBytes: number): string[] {
	const out: string[] = [];
	let current = "";
	let bytes = 0;
	for (const character of value) {
		const size = utf8Size(character);
		if (current && bytes + size > maxBytes) { out.push(current); current = ""; bytes = 0; }
		current += character;
		bytes += size;
	}
	if (current) out.push(current);
	return out;
}
async function sendTextEvents(emit: (event: string, data: unknown) => Promise<void>, event: string, value: string): Promise<void> {
	for (const text of splitText(value, MAX_CHUNK_BYTES)) await emit(event, { text });
}
async function sendBytesEvents(emit: (event: string, data: unknown) => Promise<void>, bytes: Uint8Array): Promise<void> {
	for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK_BYTES) {
		await emit("bytes", { base64: Buffer.from(bytes.subarray(offset, offset + MAX_CHUNK_BYTES)).toString("base64") });
	}
}
function capOutput(text: string, state: { bytes: number; newlines: number; endsWithNewline: boolean }, maxBytes: number): {
	kept: string;
	state: { bytes: number; newlines: number; endsWithNewline: boolean };
	skipped?: { bytes: number; newlines: number; endsWithNewline: boolean };
} {
	const remaining = Math.max(0, maxBytes - state.bytes);
	let kept = "";
	let keptBytes = 0;
	let dropped = "";
	for (const character of text) {
		const size = utf8Size(character);
		if (keptBytes + size <= remaining) { kept += character; keptBytes += size; }
		else dropped += character;
	}
	const keptNewlines = (kept.match(/\n/g) ?? []).length;
	const nextState = {
		bytes: state.bytes + keptBytes,
		newlines: state.newlines + keptNewlines,
		endsWithNewline: kept.length === 0 ? state.endsWithNewline : kept.endsWith("\n"),
	};
	if (dropped.length === 0) return { kept, state: nextState };
	return {
		kept,
		state: nextState,
		skipped: { bytes: utf8Size(dropped), newlines: (dropped.match(/\n/g) ?? []).length, endsWithNewline: dropped.endsWith("\n") },
	};
}
function validLeaseId(value: string): boolean { return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }

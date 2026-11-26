import type { GuestByteStream } from "./types.ts";

export const GUEST_PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_CHUNK_BYTES = 64 * 1024;

export class GuestProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GuestProtocolError";
	}
}

export interface GuestRequestFrame {
	v: 1;
	id: string;
	op: string;
	args: Record<string, unknown>;
}

export type GuestWireFailure =
	| { domain: "file"; code: string; message: string; path?: string }
	| { domain: "execution"; code: string; message: string; spillPath?: string }
	| { domain: "protocol"; code: "invalid"; message: string };

export type GuestResponseValue =
	| { kind: "event"; event: string; data: unknown }
	| { kind: "final"; value: unknown };

export type GuestResponseFrame =
	| { id: string; ok: true; value: GuestResponseValue }
	| { id: string; ok: false; code: GuestWireFailure };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function encodeGuestFrame(value: unknown): Uint8Array {
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch {
		throw new GuestProtocolError("frame value is not JSON serializable");
	}
	if (json === undefined) throw new GuestProtocolError("frame value is not JSON serializable");
	const payload = textEncoder.encode(json);
	if (payload.byteLength === 0 || payload.byteLength > MAX_FRAME_BYTES) {
		throw new GuestProtocolError(`frame payload exceeds ${MAX_FRAME_BYTES} bytes`);
	}
	const framed = new Uint8Array(payload.byteLength + 4);
	new DataView(framed.buffer).setUint32(0, payload.byteLength, false);
	framed.set(payload, 4);
	return framed;
}

export async function writeGuestFrame(stream: GuestByteStream, value: unknown): Promise<void> {
	await stream.write(encodeGuestFrame(value));
}

export async function readGuestFrame(stream: GuestByteStream): Promise<unknown | undefined> {
	const prefix = await readExactly(stream, 4, true);
	if (prefix === undefined) return undefined;
	const length = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(0, false);
	if (length === 0 || length > MAX_FRAME_BYTES) throw new GuestProtocolError(`invalid frame length ${length}`);
	const payload = await readExactly(stream, length, false);
	if (payload === undefined) throw new GuestProtocolError("truncated frame payload");
	let parsed: unknown;
	try {
		parsed = JSON.parse(textDecoder.decode(payload));
	} catch {
		throw new GuestProtocolError("frame payload is not valid UTF-8 JSON");
	}
	return parsed;
}

async function readExactly(stream: GuestByteStream, size: number, eofAllowed: boolean): Promise<Uint8Array | undefined> {
	const result = new Uint8Array(size);
	let offset = 0;
	while (offset < size) {
		const chunk = await stream.read(size - offset);
		if (chunk === undefined) {
			if (offset === 0 && eofAllowed) return undefined;
			throw new GuestProtocolError(offset === 0 ? "unexpected end of stream" : "truncated frame");
		}
		if (chunk.byteLength === 0 || chunk.byteLength > size - offset) throw new GuestProtocolError("stream violated its bounded read contract");
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

export function parseGuestRequest(value: unknown): GuestRequestFrame {
	if (!isRecord(value) || value.v !== GUEST_PROTOCOL_VERSION || typeof value.id !== "string" || !isId(value.id) ||
		typeof value.op !== "string" || !/^[a-z][a-zA-Z0-9_.-]{0,63}$/.test(value.op) || !isRecord(value.args)) {
		throw new GuestProtocolError("invalid guest request envelope");
	}
	return { v: 1, id: value.id, op: value.op, args: value.args };
}

export function parseGuestResponse(value: unknown): GuestResponseFrame {
	if (!isRecord(value) || typeof value.id !== "string" || !isId(value.id) || typeof value.ok !== "boolean") {
		throw new GuestProtocolError("invalid guest response envelope");
	}
	if (value.ok) {
		if (!isRecord(value.value) || (value.value.kind !== "event" && value.value.kind !== "final")) {
			throw new GuestProtocolError("invalid guest response value");
		}
		if (value.value.kind === "event" && (typeof value.value.event !== "string" || !("data" in value.value))) {
			throw new GuestProtocolError("invalid guest response event");
		}
		if (value.value.kind === "final" && !("value" in value.value)) throw new GuestProtocolError("invalid final guest response");
		return value as GuestResponseFrame;
	}
	if (!isRecord(value.code) || !["file", "execution", "protocol"].includes(String(value.code.domain)) ||
		typeof value.code.code !== "string" || typeof value.code.message !== "string") {
		throw new GuestProtocolError("invalid guest refusal");
	}
	return value as GuestResponseFrame;
}

function isId(value: string): boolean {
	return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

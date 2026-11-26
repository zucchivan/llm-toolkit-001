/** Standalone stdio entrypoint for the fixed P03 guest helper ABI. */
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { startGuestHelper } from "./guest-helper.ts";
import { MAX_FRAME_BYTES } from "./protocol.ts";
import type { GuestByteStream, GuestRole } from "./types.ts";

export interface GuestHelperArgs {
	protocol: 1;
	leaseId: string;
	role: GuestRole;
	cwd: "/work";
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROLES = new Set<GuestRole>(["planner", "implementer", "verifier", "gate", "probe"]);
const MAX_CONTROL_READ = MAX_FRAME_BYTES + 4;

/** Parse the exact argv tail emitted by the trusted host; reject reordering extras and duplicates. */
export function parseGuestHelperArgs(argv: readonly string[]): GuestHelperArgs {
	if (argv.length !== 4) throw new Error("invalid guest helper arguments");
	const protocol = "--protocol=1";
	const leasePrefix = "--lease-id=";
	const rolePrefix = "--role=";
	const cwd = "--cwd=/work";
	if (argv[0] !== protocol || !argv[1]?.startsWith(leasePrefix) || !argv[2]?.startsWith(rolePrefix) || argv[3] !== cwd) {
		throw new Error("invalid guest helper arguments");
	}
	const leaseId = argv[1].slice(leasePrefix.length);
	const roleValue = argv[2].slice(rolePrefix.length) as GuestRole;
	if (!UUID_V4.test(leaseId) || !ROLES.has(roleValue)) throw new Error("invalid guest helper identity");
	return { protocol: 1, leaseId, role: roleValue, cwd: "/work" };
}

/** Adapt process stdio without buffering unbounded input or mixing diagnostics into control stdout. */
export function createGuestStdioStream(input: Readable, output: Writable): GuestByteStream {
	let closed = false;
	let failure: Error | undefined;
	input.on("error", (error) => { failure = error; });
	output.on("error", (error) => { failure = error; });
	return {
		async read(maxBytes) {
			if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CONTROL_READ) throw new Error("invalid bounded read size");
			while (true) {
				if (failure) throw failure;
				const available = input.readableLength;
				const chunk = input.read(available > 0 ? Math.min(maxBytes, available) : maxBytes) as Buffer | null;
				if (chunk !== null) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice();
				if (input.readableEnded || input.destroyed || closed) return undefined;
				await waitReadable(input);
			}
		},
		async write(bytes) {
			if (closed || failure || output.destroyed || output.writableEnded) throw failure ?? new Error("guest helper output is closed");
			if (bytes.byteLength > MAX_CONTROL_READ) throw new Error("guest helper frame exceeds the control bound");
			if (!bytes.byteLength) return;
			if (!output.write(bytes)) await once(output, "drain");
			if (failure) throw failure;
		},
		async close() {
			if (closed) return;
			closed = true;
			if (!output.writableEnded && !output.destroyed) output.end();
		},
	};
}

function waitReadable(input: Readable): Promise<void> {
	return new Promise((resolvePromise, rejectPromise) => {
		const cleanup = () => {
			input.off("readable", readable);
			input.off("end", ended);
			input.off("close", ended);
			input.off("error", failed);
		};
		const readable = () => { cleanup(); resolvePromise(); };
		const ended = () => { cleanup(); resolvePromise(); };
		const failed = (error: Error) => { cleanup(); rejectPromise(error); };
		input.once("readable", readable);
		input.once("end", ended);
		input.once("close", ended);
		input.once("error", failed);
	});
}

export async function runGuestHelperMain(
	argv: readonly string[],
	input: Readable,
	output: Writable,
): Promise<void> {
	const identity = parseGuestHelperArgs(argv);
	const helper = startGuestHelper({ stream: createGuestStdioStream(input, output), ...identity });
	await helper.done;
}

async function main(): Promise<void> {
	try {
		await runGuestHelperMain(process.argv.slice(2), process.stdin, process.stdout);
	} catch {
		// Fixed, bounded diagnostics only. Control stdout remains protocol-only.
		process.stderr.write("kit guest helper refused startup\n");
		process.exitCode = 2;
	}
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) void main();

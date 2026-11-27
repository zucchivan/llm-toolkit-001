import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
	BACKGROUND_CONTEXT,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	withAbortSignal,
} from "../src/engine/kit.ts";
import { GuestEnv } from "../src/sandbox/guest-env.ts";
import { startGuestHelper } from "../src/sandbox/guest-helper.ts";
import type { GuestByteStream, GuestRole } from "../src/sandbox/types.ts";
import { encodeGuestFrame, MAX_CHUNK_BYTES, MAX_FRAME_BYTES, parseGuestResponse, readGuestFrame, writeGuestFrame } from "../src/sandbox/protocol.ts";

let roots: string[] = [];
let processTmpRoot = "";
const originalProcessTmpdir = process.env.TMPDIR;
beforeAll(async () => {
	processTmpRoot = await mkdtemp(join(tmpdir(), "kit-guest-process-tmp-"));
	process.env.TMPDIR = processTmpRoot;
});
afterAll(async () => {
	if (originalProcessTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalProcessTmpdir;
	await rm(processTmpRoot, { recursive: true, force: true });
});
const leases: Array<{ env: GuestEnv; helper: ReturnType<typeof startGuestHelper> }> = [];
afterEach(async () => {
	for (const lease of leases.splice(0)) {
		await lease.env.cleanup(BACKGROUND_CONTEXT);
		await lease.helper.done;
	}
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots = [];
});

function pairedStreams(): [GuestByteStream, GuestByteStream] {
	type Waiter = { max: number; resolve(chunk: Uint8Array | undefined): void };
	type End = { queue: Uint8Array[]; waiters: Waiter[]; peer?: End; eof: boolean };
	const makeEnd = (): End => ({ queue: [], waiters: [], eof: false });
	const left = makeEnd();
	const right = makeEnd();
	left.peer = right;
	right.peer = left;
	const take = (end: End, max: number): Uint8Array | undefined => {
		const chunk = end.queue.shift();
		if (!chunk) return undefined;
		if (chunk.byteLength <= max) return chunk;
		end.queue.unshift(chunk.subarray(max));
		return chunk.subarray(0, max);
	};
	const push = (end: End, chunk: Uint8Array) => {
		const waiter = end.waiters.shift();
		if (waiter) {
			if (chunk.byteLength <= waiter.max) waiter.resolve(chunk);
			else {
				waiter.resolve(chunk.subarray(0, waiter.max));
				end.queue.unshift(chunk.subarray(waiter.max));
			}
		} else end.queue.push(chunk);
	};
	const view = (end: End): GuestByteStream => ({
		read: async (maxBytes) => take(end, maxBytes) ?? (end.eof ? undefined : await new Promise((resolve) => end.waiters.push({ max: maxBytes, resolve }))),
		write: async (bytes) => {
			if (!end.peer || end.peer.eof) throw new Error("peer is closed");
			push(end.peer, bytes.slice());
		},
		close: async () => {
			end.eof = true;
			for (const waiter of end.waiters.splice(0)) waiter.resolve(undefined);
			if (end.peer && !end.peer.eof) {
				end.peer.eof = true;
				for (const waiter of end.peer.waiters.splice(0)) waiter.resolve(undefined);
			}
		},
	});
	return [view(left), view(right)];
}

async function createLease(role: GuestRole = "implementer") {
	const cwd = await mkdtemp(join(tmpdir(), "kit-guest-env-"));
	roots.push(cwd);
	const [host, guest] = pairedStreams();
	const leaseId = `test-${Math.random().toString(16).slice(2)}`;
	const helper = startGuestHelper({ stream: guest, leaseId, role, cwd });
	const env = new GuestEnv({ stream: host, leaseId, role, cwd });
	await env.ready;
	leases.push({ env, helper });
	return { env, helper, cwd };
}

function executeTool(tool: unknown, args: unknown, env: GuestEnv, extras: Record<string, unknown> = {}) {
	const execute = (tool as { execute(args: unknown, api: unknown, context: unknown): Promise<unknown> }).execute;
	return execute(args, {
		env,
		output: (text: string) => { extras.output = `${String(extras.output ?? "")}${text}`; },
		outputWindow: undefined,
		retainedOutput: () => ({ text: String(extras.output ?? ""), truncated: false }),
		diagnostic: () => undefined,
		...extras,
	}, BACKGROUND_CONTEXT);
}

describe("guest ExecutionEnv transport", () => {
	it.each(["host", "guest"] as const)("closes the lease when the %s transport write fails", async (side) => {
		const cwd = await mkdtemp(join(tmpdir(), "kit-guest-env-"));
		roots.push(cwd);
		const [host, guest] = pairedStreams();
		const failedStream = side === "host" ? host : guest;
		const write = failedStream.write.bind(failedStream);
		let failWrites = false;
		let failedWrites = 0;
		failedStream.write = async (bytes) => {
			if (!failWrites) return write(bytes);
			failedWrites++;
			throw new Error("transport disconnected");
		};
		const lease = { cwd, leaseId: "write-failure", role: "implementer" as const };
		const helper = startGuestHelper({ ...lease, stream: guest });
		const env = new GuestEnv({ ...lease, stream: host });
		leases.push({ env, helper });
		await env.ready;

		failWrites = true;
		expect(await env.absolutePath(".", BACKGROUND_CONTEXT)).toMatchObject({ ok: false });
		await helper.done;
		expect(await env.absolutePath(".", BACKGROUND_CONTEXT)).toMatchObject({ ok: false });
		expect(failedWrites).toBe(1);
	});

	it("runs the registered read, edit, and write tools on guest paths and retains reader identity", async () => {
		const { env } = await createLease();
		await executeTool(createWriteTool(), { path: "nested/note.txt", content: "alpha\nbeta\n" }, env);
		const reader = await env.openBinaryReader("nested/note.txt", undefined, BACKGROUND_CONTEXT);
		expect(reader.ok).toBe(true);
		if (!reader.ok) return;
		const info = await reader.value.info(BACKGROUND_CONTEXT);
		const chunk = await reader.value.read(0, 5, BACKGROUND_CONTEXT);
		expect(info.ok && info.value.path).toBe(join(env.cwd, "nested/note.txt"));
		expect(chunk.ok && new TextDecoder().decode(chunk.value)).toBe("alpha");
		await reader.value.close(BACKGROUND_CONTEXT);

		await executeTool(createEditTool(), {
			path: "nested/note.txt",
			edits: [{ oldText: "beta", newText: "gamma" }],
		}, env);
		const read = await executeTool(createReadTool(), { path: "nested/note.txt" }, env) as { output: Array<{ text?: string }> };
		expect(read.output.map((part) => part.text ?? "").join("")).toBe("alpha\ngamma\n");

		const payload = Uint8Array.from({ length: 1024 * 1024 + 9 }, (_, index) => index % 251);
		const write = await env.writeFile("large.bin", payload, BACKGROUND_CONTEXT);
		expect(write.ok).toBe(true);
		const binary = await env.readBinaryFile("large.bin", BACKGROUND_CONTEXT);
		expect(binary.ok && binary.value).toEqual(payload);
	});

	it("preserves literal argv boundaries and separate stdout/stderr while bash uses its string form", async () => {
		const { env } = await createLease();
		const output: Array<{ text: string; stream: string }> = [];
		const command = [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)));process.stderr.write('err')", "a b", "x'y"];
		const result = await env.exec(command, {
			inheritEnv: false,
			env: {},
			onOutput: (text, _context, info) => output.push({ text, stream: info.stream }),
		}, BACKGROUND_CONTEXT);
		expect(result.ok && result.value.exitCode).toBe(0);
		expect(output.filter((part) => part.stream === "stdout").map((part) => part.text).join("")).toBe(JSON.stringify(["a b", "x'y"]));
		expect(output.filter((part) => part.stream === "stderr").map((part) => part.text).join("")).toBe("err");
		const bash = await executeTool(createBashTool(), { command: "printf 'guest bash'" }, env) as { structuredOutput: { exitCode: number } };
		expect(bash.structuredOutput.exitCode).toBe(0);
	});

	it("rejects stale handles, unsupported APIs, and role misuse without effects", async () => {
		const { env, cwd } = await createLease("planner");
		const reader = await env.openBinaryReader("missing.txt", undefined, BACKGROUND_CONTEXT);
		expect(reader.ok).toBe(false);
		const write = await env.writeFile("must-not-exist", "x", BACKGROUND_CONTEXT);
		expect(write.ok).toBe(false);
		expect(await readFile(join(cwd, "must-not-exist")).catch(() => undefined)).toBeUndefined();
		const shell = await env.exec("touch shell-marker", undefined, BACKGROUND_CONTEXT);
		expect(shell.ok).toBe(false);
		expect(await readFile(join(cwd, "shell-marker")).catch(() => undefined)).toBeUndefined();
		const listed = await env.listFiles?.(".", undefined, BACKGROUND_CONTEXT);
		expect(listed?.ok).toBe(false);
		if (listed && !listed.ok) expect(listed.error.code).toBe("not_supported");
		const watched = await env.watch([], () => undefined, BACKGROUND_CONTEXT);
		expect(watched.ok).toBe(false);
		if (!watched.ok) expect(watched.error.code).toBe("not_supported");
		const dir = await env.openDirReader(".", BACKGROUND_CONTEXT);
		if (dir.ok) {
			await dir.value.close(BACKGROUND_CONTEXT);
			const stale = await dir.value.next(1, BACKGROUND_CONTEXT);
			expect(stale.ok).toBe(false);
			if (!stale.ok) expect(stale.error.code).toBe("invalid");
		}
	});

	it("covers line, directory, and remaining guest filesystem methods", async () => {
		const { env } = await createLease();
		expect(await env.absolutePath("~/guest-home-proof.txt", BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: "/home/worker/guest-home-proof.txt",
		});
		expect((await env.joinPath([env.cwd, "docs", "x"], BACKGROUND_CONTEXT)).ok).toBe(true);
		expect((await env.createDir("work", { recursive: true }, BACKGROUND_CONTEXT)).ok).toBe(true);
		expect((await env.writeFile("work/lines.txt", "one\ntwo\n", BACKGROUND_CONTEXT)).ok).toBe(true);
		expect((await env.readTextFile("work/lines.txt", BACKGROUND_CONTEXT)).ok).toBe(true);
		const lines = await env.readTextLines("work/lines.txt", undefined, BACKGROUND_CONTEXT);
		expect(lines).toEqual({ ok: true, value: ["one", "two"] });
		const lineReader = await env.openTextLineReader("work/lines.txt", BACKGROUND_CONTEXT);
		expect(lineReader.ok).toBe(true);
		if (lineReader.ok) {
			expect(await lineReader.value.readLine(BACKGROUND_CONTEXT)).toEqual({ ok: true, value: { text: "one", terminated: true } });
			await lineReader.value.close(BACKGROUND_CONTEXT);
		}
		expect((await env.appendFile("work/lines.txt", "three", BACKGROUND_CONTEXT)).ok).toBe(true);
		expect((await env.truncateFile("work/lines.txt", 4, BACKGROUND_CONTEXT)).ok).toBe(true);
		expect((await env.flushFile("work/lines.txt", BACKGROUND_CONTEXT)).ok).toBe(true);
		expect((await env.renameFile("work/lines.txt", "work/renamed.txt", BACKGROUND_CONTEXT)).ok).toBe(true);
		expect((await env.fileInfo("work/renamed.txt", BACKGROUND_CONTEXT)).ok).toBe(true);
		expect((await env.canonicalPath("work/renamed.txt", BACKGROUND_CONTEXT)).ok).toBe(true);
		expect(await env.exists("work/renamed.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: true });
		const directory = await env.listDir("work", BACKGROUND_CONTEXT);
		expect(directory.ok && directory.value.map((item) => item.name)).toEqual(["renamed.txt"]);
		const tempDir = await env.createTempDir("guest-fixture-", BACKGROUND_CONTEXT);
		expect(tempDir.ok).toBe(true);
		if (tempDir.ok) {
			expect(tempDir.value.startsWith(processTmpRoot)).toBe(true);
			expect((await env.remove(tempDir.value, { recursive: true, force: true }, BACKGROUND_CONTEXT)).ok).toBe(true);
		}
		const tempFile = await env.createTempFile({ prefix: "guest-", suffix: ".tmp" }, BACKGROUND_CONTEXT);
		expect(tempFile.ok).toBe(true);
		if (tempFile.ok) {
			expect(tempFile.value.startsWith(processTmpRoot)).toBe(true);
			expect((await env.remove(tempFile.value, { force: true }, BACKGROUND_CONTEXT)).ok).toBe(true);
		}
		const longLine = "λ".repeat(90_000);
		expect((await env.writeFile("work/long.txt", longLine, BACKGROUND_CONTEXT)).ok).toBe(true);
		expect(await env.readTextFile("work/long.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: longLine });
		const longReader = await env.openTextLineReader("work/long.txt", BACKGROUND_CONTEXT);
		if (longReader.ok) expect(await longReader.value.readLine(BACKGROUND_CONTEXT)).toEqual({ ok: true, value: { text: longLine, terminated: false } });
	});

	it("uses a changed cwd for guest-relative files and default command execution", async () => {
		const { env, cwd } = await createLease();
		expect((await env.createDir("nested", { recursive: true }, BACKGROUND_CONTEXT)).ok).toBe(true);
		env.cwd = join(cwd, "nested");
		const write = await env.writeFile("cwd.txt", "guest cwd", BACKGROUND_CONTEXT);
		expect(write.ok).toBe(true);
		expect(await readFile(join(env.cwd, "cwd.txt"), "utf8")).toBe("guest cwd");
		let output = "";
		const execution = await env.exec([process.execPath, "-e", "process.stdout.write(process.cwd())"], {
			inheritEnv: false,
			env: {},
			onOutput: (text) => { output += text; },
		}, BACKGROUND_CONTEXT);
		expect(execution.ok && execution.value.exitCode).toBe(0);
		expect(output).toBe(env.cwd);
		expect((await env.createDir("command-child", { recursive: true }, BACKGROUND_CONTEXT)).ok).toBe(true);
		let childOutput = "";
		const childExecution = await env.exec([process.execPath, "-e", "process.stdout.write(process.cwd())"], {
			cwd: "command-child",
			inheritEnv: false,
			env: {},
			onOutput: (text) => { childOutput += text; },
		}, BACKGROUND_CONTEXT);
		expect(childExecution.ok && childExecution.value.exitCode).toBe(0);
		expect(childOutput).toBe(join(env.cwd, "command-child"));
		const guestHomeCwd = join(processTmpRoot, "guest-home-cwd");
		const simulatedHelperHome = join(processTmpRoot, "helper-home", "nested");
		await mkdir(guestHomeCwd, { recursive: true });
		await mkdir(simulatedHelperHome, { recursive: true });
		const homeRelativeCwd = relative("/home/worker", guestHomeCwd);
		const hostHomeResolution = resolve(simulatedHelperHome, homeRelativeCwd);
		expect(hostHomeResolution).not.toBe(guestHomeCwd);
		expect(await access(hostHomeResolution).then(() => true).catch(() => false)).toBe(false);
		const previousHome = process.env.HOME;
		process.env.HOME = simulatedHelperHome;
		try {
			let homeOutput = "";
			const homeExecution = await env.exec([process.execPath, "-e", "process.stdout.write(process.cwd())"], {
				cwd: `~/${homeRelativeCwd}`,
				inheritEnv: false,
				env: {},
				onOutput: (text) => { homeOutput += text; },
			}, BACKGROUND_CONTEXT);
			expect(homeExecution.ok && homeExecution.value.exitCode).toBe(0);
			expect(homeOutput).toBe(guestHomeCwd);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	it("cancels and fences a command before the request returns", async () => {
		const { env, cwd } = await createLease("implementer");
		const pidPath = join(cwd, "child.pid");
		const controller = new AbortController();
		const pending = env.exec([
			process.execPath,
			"-e",
			"require('node:fs').writeFileSync(process.argv[1], String(process.pid));setInterval(()=>{},1000)",
			pidPath,
		], undefined, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
		for (let attempt = 0; attempt < 100; attempt++) {
			if (await readFile(pidPath).then(() => true).catch(() => false)) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const pidText = await readFile(pidPath, "utf8");
		controller.abort();
		const result = await pending;
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("aborted");
		const pid = Number(pidText);
		let running = true;
		for (let attempt = 0; attempt < 30; attempt++) {
			try { process.kill(pid, 0); } catch { running = false; break; }
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(running).toBe(false);
	});

	it("caps recipe stdout and stderr independently", async () => {
		const { env } = await createLease("gate");
		const received: Array<{ text: string; stream: string; skipped?: { bytes: number } }> = [];
		const result = await env.exec([
			process.execPath,
			"-e",
			"process.stdout.write('x'.repeat(1100000));process.stderr.write('err')",
		], {
			inheritEnv: false,
			env: {},
			onOutput: (text, _context, info) => received.push({ text, stream: info.stream, ...(info.skipped ? { skipped: info.skipped } : {}) }),
		}, BACKGROUND_CONTEXT);
		expect(result.ok && result.value.exitCode).toBe(0);
		const stdout = received.filter((item) => item.stream === "stdout");
		const stderr = received.filter((item) => item.stream === "stderr");
		expect(new TextEncoder().encode(stdout.map((item) => item.text).join("")).length).toBeLessThanOrEqual(1024 * 1024);
		expect(stderr.map((item) => item.text).join("")).toBe("err");
		expect(stdout.some((item) => (item.skipped?.bytes ?? 0) > 0)).toBe(true);
	});

	it("cleanup fences in-flight commands and revokes local reader handles", async () => {
		const { env, cwd } = await createLease();
		await env.writeFile("open.txt", "handle", BACKGROUND_CONTEXT);
		const opened = await env.openBinaryReader("open.txt", undefined, BACKGROUND_CONTEXT);
		expect(opened.ok).toBe(true);
		const pidPath = join(cwd, "cleanup.pid");
		const pending = env.exec([
			process.execPath,
			"-e",
			"require('node:fs').writeFileSync(process.argv[1], String(process.pid));setInterval(()=>{},1000)",
			pidPath,
		], undefined, BACKGROUND_CONTEXT);
		for (let attempt = 0; attempt < 100; attempt++) {
			if (await readFile(pidPath).then(() => true).catch(() => false)) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const pid = Number(await readFile(pidPath, "utf8"));
		await env.cleanup(BACKGROUND_CONTEXT);
		const result = await pending;
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("aborted");
		if (opened.ok) {
			const info = await opened.value.info(BACKGROUND_CONTEXT);
			expect(info.ok).toBe(false);
			if (!info.ok) expect(info.error.code).toBe("invalid");
		}
		let running = true;
		try { process.kill(pid, 0); } catch { running = false; }
		expect(running).toBe(false);
	});

	it("bounds protocol frames and chunks", () => {
		expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
		expect(MAX_CHUNK_BYTES).toBe(64 * 1024);
		expect(() => encodeGuestFrame({ v: 1, id: "x", op: "x", args: { data: "x".repeat(MAX_FRAME_BYTES) } })).toThrow();
	});

	it("refuses unknown roles, unknown operations, and stale wire handles", async () => {
		const [client, server] = pairedStreams();
		expect(() => new GuestEnv({ stream: client, leaseId: "bad-role", role: "root" as GuestRole, cwd: "/work" })).toThrow("unknown guest role");
		await client.close();
		const invalidCwd = await mkdtemp(join(tmpdir(), "kit-guest-role-"));
		roots.push(invalidCwd);
		const [invalidRoleClient, invalidRoleGuest] = pairedStreams();
		const invalidRoleHelper = startGuestHelper({ stream: invalidRoleGuest, leaseId: "role-check", role: "implementer", cwd: invalidCwd });
		await writeGuestFrame(invalidRoleClient, { v: 1, id: "bad-role", op: "hello", args: { leaseId: "role-check", role: "root", cwd: invalidCwd } });
		const roleReply = parseGuestResponse(await readGuestFrame(invalidRoleClient));
		expect(roleReply.ok).toBe(false);
		if (!roleReply.ok) expect(roleReply.code.domain).toBe("protocol");
		await invalidRoleClient.close();
		await invalidRoleHelper.done;

		const cwd = await mkdtemp(join(tmpdir(), "kit-guest-protocol-"));
		roots.push(cwd);
		const [rawClient, rawGuest] = pairedStreams();
		const helper = startGuestHelper({ stream: rawGuest, leaseId: "wire", role: "implementer", cwd });
		await writeGuestFrame(rawClient, { v: 1, id: "hello", op: "hello", args: { leaseId: "wire", role: "implementer", cwd } });
		const hello = parseGuestResponse(await readGuestFrame(rawClient));
		expect(hello.ok).toBe(true);
		await writeGuestFrame(rawClient, { v: 1, id: "unknown-op", op: "fs.__proto__", args: {} });
		const unknown = parseGuestResponse(await readGuestFrame(rawClient));
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.code.domain).toBe("protocol");
		await writeGuestFrame(rawClient, { v: 1, id: "stale", op: "fs.binary.read", args: { handle: "h-1", offset: 0, length: 1 } });
		const stale = parseGuestResponse(await readGuestFrame(rawClient));
		expect(stale.ok).toBe(false);
		if (!stale.ok) expect(stale.code).toMatchObject({ domain: "file", code: "invalid" });
		await rawClient.close();
		await helper.done;
	});

	it("fails closed when a response id does not match an in-flight request", async () => {
		const [client, server] = pairedStreams();
		const env = new GuestEnv({ stream: client, leaseId: "id-check", role: "implementer", cwd: "/work" });
		const request = await readGuestFrame(server) as { id: string };
		await writeGuestFrame(server, { id: `${request.id}-wrong`, ok: true, value: { kind: "final", value: { namespaceId: env.id } } });
		await expect(env.ready).rejects.toThrow("response id does not match an in-flight operation");
	});

	it("rejects an incoming frame whose declared payload exceeds the limit", async () => {
		const [reader, writer] = pairedStreams();
		const prefix = new Uint8Array(4);
		new DataView(prefix.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false);
		await writer.write(prefix);
		await expect(readGuestFrame(reader)).rejects.toThrow("invalid frame length");
		await reader.close();
	});
});

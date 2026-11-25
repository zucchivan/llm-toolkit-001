/** Shared test scaffolding for the action/jobs suite (§15.1). */
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { startServer, type RunningUiServer } from "../server/server.ts";
import { installTrustedInstallationForTests, selectInstallation } from "../../src/sandbox/trusted-exec.ts";
import type { TrustedInstallationDescriptor } from "../../src/sandbox/types.ts";
import { bakeConfiguredDemo } from "./helpers.ts";

const STUB = await readFile(join(import.meta.dirname, "stub-cli.mjs"), "utf8");

/**
 * A controlled 0755 interpreter path: a hard link (or copy) of the running node
 * binary in a private 0755 temp dir. The approved installation rule refuses the
 * host's group-writable node installation ancestry on this machine (see the
 * M1-P01 evidence, residual R1); fixtures use this path to prove the launch
 * identity while the mode rule itself stays unchanged. It is test scaffolding,
 * never a production fallback.
 */
let runtimeFixture: Promise<string> | undefined;
export function trustedNodeFixture(): Promise<string> {
	runtimeFixture ??= (async () => {
		const dir = await mkdtemp(join(tmpdir(), "ui-runtime-"));
		await chmod(dir, 0o755);
		const target = join(dir, "node");
		try {
			await link(process.execPath, target);
		} catch {
			await copyFile(process.execPath, target);
		}
		await chmod(target, 0o755);
		return target;
	})();
	return runtimeFixture;
}

export interface Baked {
	root: string;
	/** The stub CLI entry, outside the project root (a target-local one refuses). */
	stubCli: string;
	/** The temp directory holding the stub (removed by `cleanup`). */
	stubDir: string;
	/** The host-owned descriptor injected for this server (step (f)). */
	installation: TrustedInstallationDescriptor;
	/** The controlled interpreter path recorded in the launch identity. */
	node: string;
	running: RunningUiServer;
	cookie: string;
	csrf: string;
	base: string;
}

export async function bake(opts: { heartbeatMs?: number; skipJobSweep?: boolean } = {}): Promise<Baked> {
	const root = await bakeConfiguredDemo();
	// M1-P01 step (f): the CLI is selected by the host-owned descriptor — never
	// KIT_UI_CLI_BIN, a target `.bin` or PATH. The stub lives OUTSIDE the project
	// root because a target-local executable is refused by the installation rule.
	const stubDir = await mkdtemp(join(tmpdir(), "ui-stub-cli-"));
	const stubCli = join(stubDir, "stub-cli.mjs");
	await writeFile(stubCli, STUB, "utf8");
	await chmod(stubCli, 0o755);
	const node = await trustedNodeFixture();
	const installation = selectInstallation({
		execPath: node,
		installation: { cli: stubCli, node },
	});
	installTrustedInstallationForTests(installation);
	const started = await startServer({
		root,
		token: "testtoken-typescript",
		port: 0,
		distDir: await fakeDistDir(),
		heartbeatMs: opts.heartbeatMs,
		skipJobSweep: opts.skipJobSweep,
		installation,
	});
	return {
		root,
		stubCli,
		stubDir,
		installation,
		node,
		running: started,
		// Both cookies like a real browser session (the SPA echoes the CSRF one in X-Kit-Token).
		cookie: "kit_ui=testtoken-typescript; kit_ui_csrf=testtoken-typescript",
		csrf: "testtoken-typescript",
		base: `http://127.0.0.1:${started.port}`,
	};
}

/** Tear a baked fixture down: server, project root, stub dir, injected descriptor. */
export async function cleanup(baked: Baked): Promise<void> {
	await baked.running.shutdown().catch(() => {});
	await rm(baked.root, { recursive: true, force: true }).catch(() => {});
	await rm(baked.stubDir, { recursive: true, force: true }).catch(() => {});
	installTrustedInstallationForTests(undefined);
}

let distDir: Promise<string> | undefined;

/** A minimal dist dir for the server (assets are inert in these tests). */
function fakeDistDir(): Promise<string> {
	distDir ??= (async () => {
		const dir = await mkdtemp(join(tmpdir(), "ui-dist-"));
		await mkdir(join(dir, "assets"), { recursive: true });
		await writeFile(join(dir, "index.html"), "<!doctype html><title>ok</title>", "utf8");
		await writeFile(join(dir, "assets", "x.js"), "console.log(1);\n", "utf8");
		return dir;
	})();
	return distDir;
}

/** A small JSON POST with the caller-chosen auth headers. */
export function postAction(base: string, cookie: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(`${base}/api/actions`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie, ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

/**
 * The mutation headers a browser session would send: the CSRF echo plus the
 * same-origin Origin (pass `origin` to exercise the same-origin path; leave it
 * out to exercise the documented non-browser path — both are accepted when
 * cookie + header are right).
 */
export const actionHeaders = (csrf: string, origin?: string): Record<string, string> => ({
	"x-kit-token": csrf,
	...(origin === undefined ? {} : { origin: origin }),
});

/** Poll until the predicate holds (bounded). */
export async function waitFor<T>(promised: () => T | Promise<T>, until: (value: T) => boolean, budgetMs = 10_000, stepMs = 100): Promise<T> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		const value = await promised();
		if (until(value)) return value;
		if (Date.now() > deadline) throw new Error(`waitFor timed out (after ${budgetMs}ms)`);
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

/** An alive external process to fake a foreign lock holder / attached run. */
export function spawnSleeper(seconds = 10): { child: ReturnType<typeof spawn>; pid: number } {
	const child = spawn(process.execPath, ["-e", `const t = Date.now() + ${seconds}000; while (Date.now() < t) {}`], { stdio: "ignore" });
	return { child, pid: child.pid! };
}

/** The only job record a project has when exactly one action ran ( asserting shape along the way). */
export async function singleJob(baked: Baked): Promise<import("../server/jobs.ts").JobRecord> {
	const res = await fetch(`${baked.base}/api/jobs`, { headers: { cookie: baked.cookie } });
	expectOk(res);
	const payload = (await res.json()) as { jobs: import("../server/jobs.ts").JobRecord[] };
	if (payload.jobs.length !== 1) throw new Error(`expected 1 job record, got ${payload.jobs.length}`);
	return payload.jobs[0]!;
}

function expectOk(res: Response): void {
	if (!res.ok) throw new Error(`expected ok, got ${res.status}`);
}

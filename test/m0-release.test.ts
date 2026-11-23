/**
 * M0-P19 — the M0 release gate (docs/engineering-plan/M0.md §M0-P19): prove the
 * prerequisite with a BLACK-BOX run of the BUILT CLI (`node dist/cli.js`) over
 * the shipped demo fixture. No engine imports drive the loop under test: every
 * plan/run/inspect below is a separate OS process of the compiled bin (README
 * §0: the demo is the first outcome test; the packet's release gate must not
 * pass by checking router status without executing the actual product).
 *
 * Faux replay queues are PROCESS-LOCAL: the full run and the subset grant run
 * in INDEPENDENT temp projects, and plan/run are separate CLI processes that
 * each re-read `KIT_FAUX_SCRIPT` from disk. No test here assumes an in-memory
 * replay queue remembering tokens across CLI processes (mid-run "resume" is
 * proven by the engine suites with stage-specific scripts; this gate proves
 * the shipped binary, fresh-process plan → run, and the documented offline
 * smoke contract).
 */
import { describe, expect, it, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exec } from "../src/util/exec.ts";
import { initProject } from "../src/init.ts";
import {
	prepareDemoProject,
	writeConfig,
	demoConfigToml,
	gitInit,
	installDemoGates,
	DEMO_ROOT_FIXTURE,
} from "./demo-project.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILT_CLI = join(REPO_ROOT, "dist", "cli.js");
const REPLAY = join(DEMO_ROOT_FIXTURE, "smoke.replay");
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run one command of the BUILT CLI in a project with the faux replay overlay. */
async function runBuiltCli(root: string, args: string[], timeoutMs = 90_000): Promise<CliResult> {
	const out = await exec([process.execPath, BUILT_CLI, ...args], {
		cwd: root,
		timeoutMs,
		env: { NO_COLOR: "1", KIT_FAUX: "1", KIT_FAUX_SCRIPT: REPLAY },
	});
	return { code: out.code ?? 1, stdout: stripAnsi(out.stdout), stderr: stripAnsi(out.stderr) };
}

const planRevisionOf = (plan: CliResult): string => {
	expect(plan.code).toBe(0);
	const revision = /plan revision:\s*([0-9a-f-]{36})/.exec(plan.stdout)?.[1];
	expect(revision).toMatch(/^[0-9a-f-]{36}$/);
	return revision!;
};

/** Demo project with reviewed gates, faux config, committed base, dirty operator bytes. */
async function bakeReleaseDemo(): Promise<{ root: string }> {
	const project = await prepareDemoProject();
	await installDemoGates(project.root);
	await writeConfig(project.root, demoConfigToml());
	await initProject(project.root); // templates + the hygiene .gitignore block
	await writeFile(join(project.root, "operator-note.md"), "committed operator base\n", "utf8");
	await writeFile(
		join(project.root, ".gitignore"),
		`${await readFile(join(project.root, ".gitignore"), "utf8")}coverage/\n`,
		"utf8",
	);
	await gitInit(project.root);
	// Dirty, unrelated operator state must not enter the task lease or move
	// when the serial driver freezes/publishes candidate trees.
	await writeFile(join(project.root, "operator-staged.txt"), "staged operator bytes\n", "utf8");
	await exec(["git", "add", "--", "operator-staged.txt"], { cwd: project.root, timeoutMs: 10_000 });
	await writeFile(join(project.root, "operator-note.md"), "unstaged operator bytes\n", "utf8");
	await mkdir(join(project.root, "coverage"), { recursive: true });
	await writeFile(join(project.root, "coverage", "sentinel.bin"), Buffer.from([0, 4, 8, 255]));
	expect((await exec(["git", "check-ignore", "coverage/sentinel.bin"], { cwd: project.root, timeoutMs: 10_000 })).code).toBe(0);
	return project;
}

/** The §0 outcome assertion: the accepted ref is the product, proven by executing it. */
async function assertAcceptedOutcome(root: string, revision: string, expectFullDemo: boolean): Promise<void> {
	const resultParent = await mkdtemp(join(tmpdir(), "m0-release-accepted-"));
	const resultRoot = join(resultParent, "accepted");
	try {
		const addResult = await exec(["git", "worktree", "add", "--detach", resultRoot, `refs/kit/${revision}/accepted`], {
			cwd: root,
			timeoutMs: 15_000,
		});
		expect(addResult.code).toBe(0);
		const acceptedFiles = (await exec(["git", "ls-tree", "-r", "--name-only", `refs/kit/${revision}/accepted`], { cwd: root, timeoutMs: 10_000 })).stdout;
		// Ignored coverage bytes never enter the frozen candidate lineage.
		expect(acceptedFiles).not.toContain("coverage/");
		expect(acceptedFiles).toContain("src/list.ts");
		expect(acceptedFiles.includes("src/query.ts")).toBe(expectFullDemo);
		expect(acceptedFiles.includes("bin/render.js")).toBe(expectFullDemo);

		// The contract invocation, executed on the FULL demo result: status 0,
		// stdout exactly `a b\n`, empty stderr — captured, not grepped from a
		// mirror. A subset grant has no bin/render.js yet: its absence is the
		// proof that no second task wave ran.
		if (expectFullDemo) {
			const render = await exec(["node", "bin/render.js", "/a/-b"], { cwd: resultRoot, timeoutMs: 15_000 });
			expect(render.code).toBe(0);
			expect(render.stdout).toBe("a b\n");
			expect(render.stderr).toBe("");
		} else {
			expect(acceptedFiles).not.toContain("bin/render.js");
		}
	} finally {
		await exec(["git", "worktree", "remove", "--force", resultRoot], { cwd: root, timeoutMs: 15_000 });
		await rm(resultParent, { recursive: true, force: true });
	}
}

describe("M0-P19 release gate (black-box built CLI)", () => {
	beforeAll(async () => {
		// The gate tests the BUILT artifact: always compile the current source
		// first, so a stale dist/ can never make the release look green.
		const build = await exec(["npm", "run", "build"], { cwd: REPO_ROOT, timeoutMs: 240_000 });
		expect(build.code, `npm run build failed:\n${build.stdout}\n${build.stderr}`).toBe(0);
		expect(existsSync(BUILT_CLI)).toBe(true);
	}, 300_000);

	it("full demo through the built CLI: exit 0 + STATUS: COMPLETE, and the accepted result answers `a b` with clean streams", { timeout: 180_000 }, async () => {
		const project = await bakeReleaseDemo();
		const root = project.root;
		const headBefore = (await exec(["git", "rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 })).stdout.trim();
		const indexBefore = (await exec(["git", "write-tree"], { cwd: root, timeoutMs: 10_000 })).stdout.trim();
		const stagedBefore = (await exec(["git", "diff", "--cached", "--binary"], { cwd: root, timeoutMs: 10_000 })).stdout;
		const unstagedBefore = (await exec(["git", "diff", "--binary"], { cwd: root, timeoutMs: 10_000 })).stdout;
		const sentinelBefore = await readFile(join(root, "coverage", "sentinel.bin"));

		// plan: its own CLI process consumes the replay's planner section.
		const plan = await runBuiltCli(root, ["plan"]);
		expect(plan.stdout).toContain("PLANNED");
		const revision = planRevisionOf(plan);

		// run: a SEPARATE process re-reads the script; the implementer/verifier
		// sections are consumed from disk, not from plan's memory.
		const run = await runBuiltCli(root, ["run", "--approve", "--revision", revision]);
		expect(run.code, `run stderr:\n${run.stderr}`).toBe(0);
		expect(run.stdout).toContain("STATUS: COMPLETE");
		expect(run.stdout).not.toContain("selection complete");

		// The product contract, executed inside the detached accepted result.
		await assertAcceptedOutcome(root, revision, true);

		// The operator checkout is not the result location: HEAD, index, staged
		// and unstaged bytes, and ignored coverage bytes are all unchanged.
		expect((await exec(["git", "rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 })).stdout.trim()).toBe(headBefore);
		expect((await exec(["git", "write-tree"], { cwd: root, timeoutMs: 10_000 })).stdout.trim()).toBe(indexBefore);
		expect((await exec(["git", "diff", "--cached", "--binary"], { cwd: root, timeoutMs: 10_000 })).stdout).toBe(stagedBefore);
		expect((await exec(["git", "diff", "--binary"], { cwd: root, timeoutMs: 10_000 })).stdout).toBe(unstagedBefore);
		expect(await readFile(join(root, "coverage", "sentinel.bin"))).toEqual(sentinelBefore);
		expect(await readFile(join(root, "operator-note.md"), "utf8")).toBe("unstaged operator bytes\n");
		expect(await readFile(join(root, "operator-staged.txt"), "utf8")).toBe("staged operator bytes\n");
		expect(await readFile(join(root, "src", "list.ts"), "utf8").catch(() => "<absent>")).toBe("<absent>");
	});

	it("subset grant through the built CLI: exit 0 + selection complete, and no record of a second task wave or whole-plan completion", { timeout: 180_000 }, async () => {
		// An INDEPENDENT project: faux queues are process-local and this subset
		// run must not inherit positions from the full-run project.
		const project = await bakeReleaseDemo();
		const root = project.root;

		const revision = planRevisionOf(await runBuiltCli(root, ["plan"]));
		const run = await runBuiltCli(root, ["run", "--approve", "--revision", revision, "--tasks", "list-parse"]);
		expect(run.code, `run stderr:\n${run.stderr}`).toBe(0);
		expect(run.stdout).toContain("selection complete");
		expect(run.stdout).not.toContain("STATUS: COMPLETE");

		// No record of a second task wave anywhere in the paper trail: every
		// wave-log row belongs to the granted task (or the session), the mirror
		// never flips to whole-plan completion, and the accepted lineage holds
		// exactly the granted task's bytes.
		const waveLog = (await readFile(join(root, ".orch", "wave-log.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((r) => JSON.parse(r) as { task?: string });
		expect(waveLog.length).toBeGreaterThan(0);
		expect(waveLog.every((r) => r.task === undefined || r.task === "list-parse" || r.task === "session")).toBe(true);

		const routerMd = await readFile(join(root, "router.md"), "utf8");
		expect(routerMd).not.toContain("queue drained");

		const inspect = await runBuiltCli(root, ["inspect", "--json"]);
		expect(inspect.code).toBe(0);
		const readout = JSON.parse(inspect.stdout) as {
			phase: string;
			tasks: { id: string; status: string }[];
			timeline: { task?: string }[];
		};
		const byId = new Map(readout.tasks.map((t) => [t.id, t.status]));
		expect(byId.get("list-parse")).toBe("done");
		expect(byId.get("list-query")).toBe("todo");
		expect(byId.get("cli-render")).toBe("todo");
		expect(readout.phase).not.toBe("complete");
		expect(readout.timeline.every((s) => s.task === undefined || s.task === "list-parse")).toBe(true);

		await assertAcceptedOutcome(root, revision, false);
	});

	it("edited mirror + locked/unlocked inspect window: grant and outcome are never reconstructed from router.md", { timeout: 180_000 }, async () => {
		const project = await bakeReleaseDemo();
		const root = project.root;
		const revision = planRevisionOf(await runBuiltCli(root, ["plan"]));
		const run = await runBuiltCli(root, ["run", "--approve", "--revision", revision, "--tasks", "list-parse"]);
		expect(run.code).toBe(0);

		// The operator edits the mirror to claim a completion the engine never
		// recorded (ADR 01/04: the stored grant/state governs; the mirror is a
		// projection, never plan input).
		const mirror = await readFile(join(root, "router.md"), "utf8");
		expect(mirror).toContain("- STATUS: todo");
		await writeFile(join(root, "router.md"), mirror.replaceAll("- STATUS: todo", "- STATUS: done"), "utf8");

		// A foreign process owns .orch/lock across the inspection window. It
		// uses only the built artifact (an observer open) as scaffolding — the
		// commands under test are the built CLI's own inspect.
		const holderScript = `
import(${JSON.stringify(pathToFileURL(join(REPO_ROOT, "dist", "engine", "harness.js")).href)}).then(async (m) => {
	const kit = await m.openProjectHarness(${JSON.stringify(root)}, "inspect", { readView: true });
	console.log("LOCKED");
	await new Promise((r) => setTimeout(r, 6000));
	await kit.loop.close();
	kit.lock.release();
	console.log("RELEASED");
}).catch((err) => { console.error(String(err && err.message || err)); process.exit(1); });
`;
		const holder = spawn(process.execPath, ["-e", holderScript], { stdio: ["ignore", "pipe", "pipe"] });
		let holderOut = "";
		holder.stdout!.on("data", (c: Buffer) => (holderOut += c.toString("utf8")));
		holder.stderr!.on("data", () => {});
		try {
			const lockedDeadline = Date.now() + 15_000;
			while (!holderOut.includes("LOCKED") && Date.now() < lockedDeadline) {
				await new Promise((r) => setTimeout(r, 100));
			}
			expect(holderOut).toContain("LOCKED");

			// Locked window: inspect degrades to side-cars and shows the engine's
			// status.json truth — the edited mirror's all-done claim never surfaces.
			const locked = await runBuiltCli(root, ["inspect", "--json"]);
			expect(locked.code).toBe(0);
			const lockedRead = JSON.parse(locked.stdout) as {
				degraded: boolean;
				storage?: unknown;
				tasks: { id: string; status: string }[];
				health: { id: string; ok: boolean; detail?: string }[];
			};
			expect(lockedRead.degraded).toBe(true);
			expect(lockedRead.storage).toBeUndefined();
			expect(lockedRead.tasks.map((t) => `${t.id}:${t.status}`).sort()).toEqual([
				"cli-render:todo",
				"list-parse:done",
				"list-query:todo",
			]);
			expect(lockedRead.health.find((h) => h.id === "mirrors")?.detail).toContain("skipped");

			const releaseDeadline = Date.now() + 15_000;
			while (!holderOut.includes("RELEASED") && Date.now() < releaseDeadline) {
				await new Promise((r) => setTimeout(r, 100));
			}
			expect(holderOut).toContain("RELEASED");

			// Unlocked window: storage is authoritative — the same true outcome,
			// and the edited mirror is FLAGGED as drift, not trusted or repaired.
			const unlocked = await runBuiltCli(root, ["inspect", "--json"]);
			expect(unlocked.code).toBe(0);
			const unlockedRead = JSON.parse(unlocked.stdout) as {
				degraded: boolean;
				storage?: unknown;
				tasks: { id: string; status: string }[];
				health: { id: string; ok: boolean; detail?: string }[];
			};
			expect(unlockedRead.degraded).toBe(false);
			expect(unlockedRead.storage).toBeDefined();
			expect(unlockedRead.tasks.map((t) => `${t.id}:${t.status}`).sort()).toEqual([
				"cli-render:todo",
				"list-parse:done",
				"list-query:todo",
			]);
			const mirrors = unlockedRead.health.find((h) => h.id === "mirrors");
			expect(mirrors?.ok).toBe(false);
			expect(mirrors?.detail).toContain("router.md bytes differ");
		} finally {
			if (holder.exitCode === null && !holder.killed) holder.kill("SIGKILL");
		}
	});
});

/**
 * M0-P02 — view harnesses are inert observers.
 *
 * - `readView:true` opens `Harness.open({ readOnly: true })` under the SAME
 *   host lock: zero model/tool dispatches, no task progress, no admission or
 *   recovery writes; commits with writes reject with the SDK's ReadOnlySession
 *   and change nothing.
 * - readView builds NO providers: a config naming an unwired provider opens
 *   fine for inspection (a real run would refuse it).
 * - A never-run project has no database: observation refuses to create one,
 *   exposes empty/absent evidence instead, and the CLI (status/inspect)
 *   renders that truth without materializing `.orch/durable.sqlite`.
 * - Kit identity is the package version (package.json → config.ts): the init
 *   marker, a fresh plan, and the CLI header all agree; identities recorded
 *   by older kits are historical and are never rewritten by observation.
 */
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildFauxModels, fauxAssistantMessage } from "./fixtures.ts";
import { prepareDemoProject, writeConfig, demoConfigToml, gitInit } from "./demo-project.ts";
import { initProject } from "../src/init.ts";
import { openProjectHarness, projectPaths, StoreAbsentError, LockBusyError } from "../src/engine/harness.ts";
import { readout } from "../src/engine/inspector.ts";
import { commitState, readSessionState } from "../src/engine/state.ts";
import { loadPrd, runPlan } from "../src/engine/planner.ts";
import { KIT_VERSION } from "../src/config.ts";
import { readInstalledPiDurableVersion } from "../src/engine/kit.ts";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const kitCli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function runCli(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync(process.execPath, [tsxCli, kitCli, ...args], {
		cwd: root,
		env: { ...process.env, NO_COLOR: "1", KIT_FAUX: "1" },
		timeout: 60_000,
	});
}

const ONE_TASK = {
	tasks: [
		{
			id: "t1",
			title: "one",
			spec: "write src/one.ts with the module.",
			dependsOn: [],
			acceptance: ["When src/one.ts exists, the system shall export const one = 1."],
			targetPaths: ["src/"],
			priority: 1,
		},
	],
};

describe("readView harnesses are inert (M0-P02)", () => {
	it("observes unfinished work under the host lock: no provider build, zero model calls, no progress or writes, writes refuse", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await gitInit(project.root);
		await initProject(project.root);

		const { models, faux } = buildFauxModels([]);
		faux.appendResponses([fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" })]);
		const planKit = await openProjectHarness(project.root, "plan", { modelsOverride: models });
		await runPlan(planKit, "docs/prd.md", await loadPrd(planKit));
		// Simulate unfinished work: wave 1 started and its process died mid-task.
		await commitState(planKit, {
			router: (d) => {
				d.tasks[0]!.status = "in_progress";
				d.tasks[0]!.waveCount = 1;
			},
		});
		await planKit.loop.close();
		planKit.lock.release();

		// Now name a provider the kit does not wire: a RUN would refuse at open;
		// an observer must not even construct it.
		await writeConfig(project.root, demoConfigToml().replaceAll('provider = "faux"', 'provider = "not-wired-anywhere"'));

		const callsBefore = faux.state.callCount;
		const waveLogBytes = readFileSync(join(project.root, ".orch", "wave-log.jsonl"), "utf8");
		const routerMdBytes = readFileSync(join(project.root, "router.md"), "utf8");

		const view = await openProjectHarness(project.root, "inspect", { readView: true });
		try {
			// Still under the host lock: a second open of any mode refuses politely.
			expect(existsSync(join(project.root, ".orch", "lock"))).toBe(true);
			await expect(openProjectHarness(project.root, "inspect", { readView: true })).rejects.toBeInstanceOf(LockBusyError);

			const state = await readSessionState(view.loop.harness);
			expect(state.router.phase).toBe("planned");
			expect(state.router.tasks[0]).toMatchObject({ id: "t1", status: "in_progress", waveCount: 1 });

			// The full inspector readout works on the read-only session (the UI pattern).
			const read = await readout(view.loop.paths, { loop: view });
			expect(read.degraded).toBe(false);
			expect(read.tasks.map((t) => t.id)).toEqual(["t1"]);
			expect(read.identity.kit).toBe(KIT_VERSION);

			// Zero model dispatches, mirrors byte-identical: no task progress, no writes.
			expect(faux.state.callCount).toBe(callsBefore);
			expect(readFileSync(join(project.root, ".orch", "wave-log.jsonl"), "utf8")).toBe(waveLogBytes);
			expect(readFileSync(join(project.root, "router.md"), "utf8")).toBe(routerMdBytes);

			// A write attempt refuses with the SDK's read-only error and lands nothing.
			await expect(
				commitState(view, { rows: [{ ts: Date.now(), kind: "engine", task: "session", verb: "must-not-land" }] }),
			).rejects.toMatchObject({ name: "ReadOnlySession" });
			const after = await readSessionState(view.loop.harness);
			expect(after.rows.length).toBe(state.rows.length);
			expect(after.rows.some((r) => r.verb === "must-not-land")).toBe(false);
		} finally {
			await view.loop.close();
			view.lock.release();
		}
		expect(existsSync(join(project.root, ".orch", "lock"))).toBe(false);

		// Storage still tells the same story after a normal reopen.
		const reopen = await openProjectHarness(project.root, "run", { modelsOverride: models });
		const reread = await readSessionState(reopen.loop.harness);
		expect(reread.router.tasks[0]).toMatchObject({ status: "in_progress", waveCount: 1 });
		expect(reread.rows.some((r) => r.verb === "must-not-land")).toBe(false);
		await reopen.loop.close();
		reopen.lock.release();
	});

	it("never-run project: observation refuses to create a DB and exposes empty/absent evidence (CLI included)", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await gitInit(project.root);
		await initProject(project.root);
		const database = join(project.root, ".orch", "durable.sqlite");

		await expect(openProjectHarness(project.root, "inspect", { readView: true })).rejects.toBeInstanceOf(StoreAbsentError);
		expect(existsSync(database)).toBe(false);
		// The refusal released the lock it had acquired for the check.
		expect(existsSync(join(project.root, ".orch", "lock"))).toBe(false);

		// Empty/absent evidence straight from the side-cars.
		const read = await readout(projectPaths(project.root), { sidecarReason: "test: never run" });
		expect(read.degraded).toBe(true);
		expect(read.degradedReason).toBe("test: never run");
		expect(read.tasks).toEqual([]);
		expect(read.rows).toEqual([]);
		expect(read.timeline).toEqual([]);
		expect(read.storage).toBeUndefined();

		// The CLI renders that truth and still creates no database.
		const inspectRun = await runCli(project.root, ["inspect", "--json"]);
		expect(inspectRun.stdout).toContain('"degraded": true');
		expect(inspectRun.stdout).toContain('"phase": "unknown"');
		expect(existsSync(database)).toBe(false);

		const statusRun = await runCli(project.root, ["status"]);
		expect(statusRun.stdout).toContain("phase empty");
		expect(existsSync(database)).toBe(false);
	}, 90_000);

	it("kit identity is the package version everywhere, and observation never rewrites recorded history", async () => {
		const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };
		expect(KIT_VERSION).toBe(pkg.version);
		expect(readInstalledPiDurableVersion()).toBe("1.5.0");

		// init's provenance marker agrees with package.json.
		const markerProject = await prepareDemoProject();
		await initProject(markerProject.root);
		const marker = await readFile(join(markerProject.root, ".orch", "kit-version"), "utf8");
		expect(marker).toBe(`kit=${pkg.version} pi-durable=${readInstalledPiDurableVersion()}\n`);

		// A fresh plan records the package version; the CLI header agrees too.
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await gitInit(project.root);
		await initProject(project.root);
		const { models, faux } = buildFauxModels([]);
		faux.appendResponses([fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" })]);
		const kit = await openProjectHarness(project.root, "plan", { modelsOverride: models });
		await runPlan(kit, "docs/prd.md", await loadPrd(kit));
		const state = await readSessionState(kit.loop.harness);
		expect(state.runStatus.kitVersion).toBe(pkg.version);

		// History is not rewritten: an older recorded identity survives observation.
		await commitState(kit, { runStatus: (d) => void (d.kitVersion = "0.0.1-legacy") });
		await kit.loop.close();
		kit.lock.release();

		const view = await openProjectHarness(project.root, "inspect", { readView: true });
		const observed = await readSessionState(view.loop.harness);
		expect(observed.runStatus.kitVersion).toBe("0.0.1-legacy");
		const read = await readout(view.loop.paths, { loop: view });
		expect(read.identity.kit).toBe("0.0.1-legacy");
		await view.loop.close();
		view.lock.release();

		const helpRun = await runCli(process.cwd(), ["--help"]);
		expect(helpRun.stdout).toContain(`kit llm-toolkit-001 ${KIT_VERSION} · run inside the target project`);
	}, 90_000);
});

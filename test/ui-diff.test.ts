/**
 * UI seam A.2/A.3 tests (ui/PRD.md Appendix A.2 diff artifacts + A.3 readout):
 * every done task gets .orch/artifacts/task-<id>.patch + task-<id>.json BEFORE
 * delivery; every quarantine keeps its quarantined-<id>-w<N>.patch and gains a
 * stats side-car; the patch is display-oriented (engine paths .orch/**,
 * router.md, PROMPT.md excluded), 5 MiB-capped (truncated:true in stats, never
 * a rollback input), and CUMULATIVE since the baseline (retries keep the tree).
 * The readout gains tasks[].diff refs and the "diff" artifact kind in BOTH
 * modes; nothing else changes (the rest of the suite stays authoritative).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { openProjectHarness } from "../src/engine/harness.ts";
import { readSessionState } from "../src/engine/state.ts";
import { runWaves } from "../src/engine/waves.ts";
import { runPlan, loadPrd } from "../src/engine/planner.ts";
import { readout } from "../src/engine/inspector.ts";
import { DISPLAY_PATCH_CAP_BYTES, isEngineOwnedPath } from "../src/util/git.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { demoConfigToml } from "./demo-project.ts";
import { bakeProject, scripted, accomplish } from "./fixtures2.ts";
import { writeGateFile } from "./helpers2.ts";
import { readJson } from "../src/util/fsx.ts";
import type { DisplayDiffStats } from "../src/util/git.ts";

beforeEach(() => {
	process.env["NO_COLOR"] = "1";
});

const ONE_TASK = {
	tasks: [
		{ id: "t1", title: "one", spec: "write src/one.ts with the module.", dependsOn: [], acceptance: ["When src/one.ts exists, the system shall compile."], targetPaths: ["src/"], priority: 1 },
	],
};

const implWrites = (writes: { path: string; content: string }[], closing = "STATUS: COMPLETE") =>
	writes.map((w) => fauxAssistantMessage([fauxToolCall("write", w)], { stopReason: "toolUse" })).concat([fauxAssistantMessage(closing, { stopReason: "stop" })]);

const verifyApprove = () =>
	fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass" }], notes: "ok" }), { stopReason: "stop" });

const statsOf = async (root: string, name: string): Promise<DisplayDiffStats> => {
	const stats = await readJson<DisplayDiffStats>(join(root, ".orch", "artifacts", name));
	expect(stats, `stats side-car ${name} missing`).toBeTruthy();
	return stats as DisplayDiffStats;
};

describe("A.2: done path writes patch + stats before delivery", () => {
	it("task-<id>.patch + task-<id>.json exist with the expected shape, exclusions, and no engine paths", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			...implWrites([
				{ path: "src/one.ts", content: "export const one = 1;\n" },
			]),
			verifyApprove(),
		], models.faux);
		await accomplish(kit);

		const summary = await runWaves(kit, { approve: true, tasksFilter: [] });
		expect(summary.complete).toBe(true);

		const patchPath = join(project.root, ".orch", "artifacts", "task-t1.patch");
		const patchMeta = await stat(patchPath);
		expect(patchMeta.isFile()).toBe(true);
		const patch = await readFile(patchPath, "utf8");
		// the wave's file is there; engine-owned churn is not
		expect(patch).toContain("diff --git a/src/one.ts b/src/one.ts");
		expect(patch).toContain("+export const one = 1;");
		expect(patch).not.toContain("router.md");
		expect(patch).not.toContain("PROMPT.md");
		expect(patch).not.toMatch(/^.{0,200}diff --git a\.orch/m);

		const stats = await statsOf(project.root, "task-t1.json");
		expect(stats.task).toBe("t1");
		expect(stats.wave).toBe(1);
		expect(stats.baselineTreeSha).toMatch(/^[0-9a-f]{40}$/);
		expect(typeof stats.generatedAt).toBe("number");
		expect(stats.files.map((f) => f.path).sort()).toEqual(["src/one.ts"]);
		const file = stats.files[0]!;
		expect(file.status).toBe("A");
		expect(file.insertions).toBe(1);
		expect(file.deletions).toBe(0);
		expect(file.binary).toBe(false);
		expect(stats.totalInsertions).toBe(1);
		expect(stats.totalDeletions).toBe(0);
		expect(stats.bytes).toBe(patchMeta.size);
		expect(stats.truncated).toBe(false);

		// delivery ran after the patch write (per-run delivery rows exist);
		// the state is terminal done and the loop ran to completion as before.
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.tasks[0]!.status).toBe("done");
		await kit.loop.close();
		kit.lock.release();
	});

	it("two waves (gate-fail retry) keep the patch cumulative since the baseline", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			// wave 1: two files, one of them BROKEN → gate fails → retry (tree stays)
			...implWrites([
				{ path: "src/one.ts", content: "export const one = 1;\n" },
				{ path: "src/two.ts", content: "export const BROKEN = true;\n" },
			]),
			// wave 2: fixes the tree (BROKEN gone from two.ts); adds a third file
			...implWrites([
				{ path: "src/one.ts", content: "export const one = 1;\nexport const two = 2;\n" },
				{ path: "src/two.ts", content: "export const settled = true;\n" },
				{ path: "src/three.ts", content: "export const three = 3;\n" },
			]),
			verifyApprove(),
		], models.faux);
		await accomplish(kit);
		await writeGateFile(project.root);

		const summary = await runWaves(kit, { approve: true, tasksFilter: [] });
		expect(summary.complete).toBe(true);

		const state = await readSessionState(kit.loop.harness);
		const task = state.router.tasks[0]!;
		expect(task.status).toBe("done");
		expect(task.waveCount).toBe(2);

		const stats = await statsOf(project.root, "task-t1.json");
		// CUMULATIVE: wave 1's attempt (one.ts, two.ts) and wave 2's edits + three.ts are all
		// visible against the baseline; there is no reset between attempts.
		expect(stats.wave).toBe(2);
		const paths = stats.files.map((f) => f.path).sort();
		expect(paths).toEqual(["src/one.ts", "src/three.ts", "src/two.ts"]);
		const two = stats.files.find((f) => f.path === "src/two.ts")!;
		expect(two.status).toBe("A"); // created in wave 1, still present (then rolled by wave-2 rewrite? no: wave 2 did not touch two.ts)
		const one = stats.files.find((f) => f.path === "src/one.ts")!;
		expect(one.insertions).toBe(2); // final content lines vs baseline
		expect(one.status).toBe("A");

		const patch = await readFile(join(project.root, ".orch", "artifacts", "task-t1.patch"), "utf8");
		expect(patch).toContain("src/two.ts");
		expect(patch).toContain("src/three.ts");
		expect(patch).toContain("+export const two = 2;");

		await kit.loop.close();
		kit.lock.release();
	});
});

describe("A.2: quarantine keeps its patch and gains a stats side-car; rollback holds", () => {
	it("quarantined-<id>-w<N>.patch + .json exist; the tree is back at the baseline; the patch is display-only", async () => {
		// retryLimit 0 → the wave-1 gate failure quarantines right away (wave 1 exactly)
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(project.root, ".orch", "config.toml"), demoConfigToml().replace("retryLimit = 2", "retryLimit = 0"), "utf8");
		await kit.loop.close();
		kit.lock.release();
		const fresh = buildFauxModels([]);
		const reopen = await openProjectHarness(project.root, "test", { modelsOverride: fresh.models });
		await scripted(reopen, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			...implWrites([{ path: "src/one.ts", content: "export const BROKEN = true;\n" }]),
		], fresh.faux);
		await writeGateFile(project.root);
		await accomplish(reopen);

		const summary = await runWaves(reopen, { approve: true, tasksFilter: [] });
		expect(summary.complete).toBe(false);

		const state = await readSessionState(reopen.loop.harness);
		const task = state.router.tasks[0]!;
		expect(task.status).toBe("quarantined");
		const baseline = task.baselineTreeSha!;

		const patch = await readFile(join(project.root, ".orch", "artifacts", "quarantined-t1-w1.patch"), "utf8");
		expect(patch).toContain("src/one.ts");
		expect(patch).toContain("+export const BROKEN = true;");
		// display rules hold on the quarantine path too
		expect(patch).not.toContain("router.md");

		const stats = await statsOf(project.root, "quarantined-t1-w1.json");
		expect(stats.task).toBe("t1");
		expect(stats.wave).toBe(1);
		expect(stats.baselineTreeSha).toBe(baseline);
		expect(stats.files.map((f) => `${f.path}:${f.status}`)).toEqual(["src/one.ts:A"]);

		// the evidence patch is display-only: the ROLLBACK ran (restoreTree), so
		// the tree is back at the baseline; no replay of the saved patch file.
		const treeNow = await readFile(join(project.root, "src", "one.ts"), "utf8").catch(() => "<absent>");
		expect(treeNow).toBe("<absent>"); // the quarantined file was rolled off the tree

		await reopen.loop.close();
		reopen.lock.release();
	});
});

describe("A.2: cap + truncation (display only, never a rollback input)", () => {
	it("a >5 MiB change truncates the stored patch, sets truncated:true, and stays display-only", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		// The big change is produced by a SMALL bash command (the faux provider
		// caps scripted message sizes; the tree change itself must still be > 5 MiB).
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: `yes 'export const filler = XXXX;' | head -c ${Math.ceil(DISPLAY_PATCH_CAP_BYTES * 1.4)} > src/big.ts` })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			verifyApprove(),
		], models.faux);
		await accomplish(kit);

		const summary = await runWaves(kit, { approve: true, tasksFilter: [] });
		expect(summary.complete).toBe(true);
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.tasks[0]!.status).toBe("done"); // the run outcome is untouched by the cap

		const patchPath = join(project.root, ".orch", "artifacts", "task-t1.patch");
		const meta = await stat(patchPath);
		expect(meta.size).toBeLessThanOrEqual(DISPLAY_PATCH_CAP_BYTES);
		const patch = await readFile(patchPath, "utf8");
		expect(patch.startsWith("diff --git ")).toBe(true); // head kept (headers first)

		const stats = await statsOf(project.root, "task-t1.json");
		expect(stats.truncated).toBe(true);
		expect(stats.bytes).toBeLessThanOrEqual(DISPLAY_PATCH_CAP_BYTES);
		// stats still describe every real file (side-car is not the capped text)
		expect(stats.files.map((f) => f.path)).toEqual(["src/big.ts"]);

		await kit.loop.close();
		kit.lock.release();
	});
});

describe("A.3: readout carries diff refs + the diff artifact kind", () => {
	it("storage mode: tasks[].diff {task, patch, stats, bytes, truncated} + kind === 'diff' artifacts", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			...implWrites([{ path: "src/one.ts", content: "export const one = 1;\n" }]),
			verifyApprove(),
		], models.faux);
		await accomplish(kit);
		await runWaves(kit, { approve: true, tasksFilter: [] });

		const read = await readout(kit.loop.paths, { loop: kit });
		expect(read.seam).toBe(1);
		const view = read.tasks[0]!;
		expect(view.status).toBe("done");
		expect(view.diff).toEqual({
			task: "t1",
			patch: "task-t1.patch",
			stats: "task-t1.json",
			bytes: expect.any(Number),
			truncated: false,
		});
		const diffArtifacts = read.artifacts.filter((a) => a.kind === "diff").map((a) => a.name).sort();
		expect(diffArtifacts).toEqual(["task-t1.json", "task-t1.patch"]);
		// engine-owned paths never leak in as display artifacts
		expect(read.artifacts.every((a) => !isEngineOwnedPath(a.name))).toBe(true);

		await kit.loop.close();
		kit.lock.release();
	});

	it("side-car mode (lock owned elsewhere): diff refs still resolve from the artifacts listing", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			...implWrites([{ path: "src/one.ts", content: "export const one = 1;\n" }]),
			verifyApprove(),
		], models.faux);
		await accomplish(kit);
		await runWaves(kit, { approve: true, tasksFilter: [] });
		await kit.loop.close();
		kit.lock.release();

		// no loop handed in → side-car readout; artifacts + status.json side-cars only
		const read = await readout(kit.loop.paths);
		expect(read.degraded).toBe(true);
		const view = read.tasks.find((t) => t.id === "t1")!;
		expect(view.diff?.patch).toBe("task-t1.patch");
		expect(view.diff?.stats).toBe("task-t1.json");
		expect(view.diff?.bytes).toBeGreaterThan(0);
	});
});

describe("A.2 side-car: status.json tasks carry baselineTreeSha (live diff input)", () => {
	it("the wave-running flush exposes the task's baseline so an attached UI can diff without storage", async () => {
		const { project, kit, models } = await bakeProject({ buildFauxModels });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			...implWrites([{ path: "src/one.ts", content: "export const one = 1;\n" }]),
			verifyApprove(),
		], models.faux);
		await accomplish(kit);
		await runWaves(kit, { approve: true, tasksFilter: [] });

		const payload = await readJson<{ tasks: { id: string; baselineTreeSha?: string }[] }>(join(project.root, ".orch", "status.json"));
		const entry = payload?.tasks.find((t) => t.id === "t1");
		expect(entry?.baselineTreeSha).toMatch(/^[0-9a-f]{40}$/);
		// router doc and side-car agree
		const state = await readSessionState(kit.loop.harness);
		expect(entry?.baselineTreeSha).toBe(state.router.tasks[0]!.baselineTreeSha);

		await kit.loop.close();
		kit.lock.release();
	});
});



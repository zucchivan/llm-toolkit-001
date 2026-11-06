/**
 * inspect/visibility (docs/concepts.md § visibility): readout() in both modes —
 * storage-backed under the lock, side-car-only when the lock is elsewhere —
 * plus the health findings on engineered states (orphan, missing patch).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { openProjectHarness } from "../src/engine/harness.ts";
import { commitState } from "../src/engine/state.ts";
import { loadPrd, runPlan } from "../src/engine/planner.ts";
import { runWaves } from "../src/engine/waves.ts";
import { readout } from "../src/engine/inspector.ts";
import { prepareDemoProject, writeConfig, demoConfigToml, gitInit } from "./demo-project.ts";
import { initProject } from "../src/init.ts";

beforeEach(() => {
	process.env["NO_COLOR"] = "1";
});

/** Drop files into the temp project (dirs created as needed). */
async function writeProject(root: string, files: Record<string, string>): Promise<void> {
	for (const [rel, content] of Object.entries(files)) {
		const file = join(root, rel);
		await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
		await writeFile(file, content, "utf8");
	}
}

const ONE_TASK = {
	tasks: [
		{ id: "t1", title: "one", spec: "write src/one.ts with the module.", dependsOn: [], acceptance: ["When src/one.ts exists, the system shall export const one = 1."], targetPaths: ["src/"], priority: 1 },
	],
};

const implWrites = (writes: { path: string; content: string }[], closing = "STATUS: COMPLETE") =>
	writes
		.map((w) => fauxAssistantMessage([fauxToolCall("write", w)], { stopReason: "toolUse" }))
		.concat([fauxAssistantMessage(closing, { stopReason: "stop" })]);

describe("inspector: readout seam", () => {
	it("storage readout after plan: tasks, rows, per-model usage, conversation summaries, healthy checks", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await gitInit(project.root);
		await initProject(project.root);

		const { models, faux } = buildFauxModels([]);
		faux.appendResponses([fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" })]);

		const planKit = await openProjectHarness(project.root, "plan", { modelsOverride: models });
		await runPlan(planKit, "docs/prd.md", await loadPrd(planKit));
		await planKit.loop.close();
		planKit.lock.release();

		// A fresh open: the readout must not depend on in-memory caches from planning.
		const kit = await openProjectHarness(project.root, "inspect", { modelsOverride: models });
		const read = await readout(kit.loop.paths, { loop: kit });

		expect(read.degraded).toBe(false);
		expect(read.storage).toBeDefined();
		expect(read.phase).toBe("planned");
		expect(read.tasks.map((t) => t.id)).toEqual(["t1"]);
		expect(read.tasks[0]).toMatchObject({ status: "todo", waveCount: 0, targetPaths: ["src/"], priority: 1 });
		expect(read.rows.some((row) => row.kind === "wave" && row.verb === "planned")).toBe(true);

		// usage: planner model bucket exists; tokens counted; by-task join sees the planner pool
		expect(Object.keys(read.usage.byModel).length).toBeGreaterThan(0);
		expect(read.usage.tokens).toBeGreaterThan(0);
		expect(read.usage.source).toBe("storage");
		expect(Object.keys(read.usage.byTask)).toContain("planner");

		// conversations: the planner unit is visible with its role
		const convs = read.storage?.conversations ?? [];
		expect(convs.length).toBeGreaterThanOrEqual(1);
		expect(convs.some((c) => c.role === "planner")).toBe(true);
		const plannerConv = convs.find((c) => c.role === "planner");
		expect(plannerConv?.entries ?? 0).toBeGreaterThan(0);
		expect(plannerConv?.usage.totalTokens ?? 0).toBeGreaterThan(0);

		// timeline: nothing ran yet — only the session-level planned row, no spans
		expect(read.timeline).toEqual([]);

		// health: pin ok, mirrors parity ok, PRD sha matches, side-car parsed
		const byId = new Map(read.health.map((check) => [check.id, check]));
		expect(byId.get("pin")?.ok).toBe(true);
		expect(byId.get("mirrors")?.ok).toBe(true);
		expect(byId.get("prd")?.ok).toBe(true);
		expect(byId.get("status-sidecar")?.ok).toBe(true);
		expect(byId.get("patches")?.ok).toBe(true);

		// the whole payload is plain JSON (report.json consumers)
		expect(() => JSON.parse(JSON.stringify(read))).not.toThrow();

		await kit.loop.close();
		kit.lock.release();
	});

	it("storage readout after a completed run: timeline span, per-task usage, implementer + verifier conversations", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await gitInit(project.root);
		await initProject(project.root);
		await writeProject(project.root, {
			"eval-gate.cjs": "process.exit(0);\n",
			"evals/recipes.toml": `[never-fails]\ncmd = "node eval-gate.cjs"\n`,
		});

		const { models, faux } = buildFauxModels([]);
		faux.setResponses([
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			...implWrites([{ path: "src/one.ts", content: "export const one = 1;\n" }]),
			fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass" }], notes: "" }), { stopReason: "stop" }),
		]);

		const kit = await openProjectHarness(project.root, "run", { modelsOverride: models });
		await runPlan(kit, "docs/prd.md", await loadPrd(kit));
		const summary = await runWaves(kit, { approve: true, tasksFilter: [] });
		expect(summary.complete).toBe(true);

		const read = await readout(kit.loop.paths, { loop: kit });
		expect(read.phase).toBe("complete");
		expect(read.tasks[0]).toMatchObject({ id: "t1", status: "done", waveCount: 1 });

		expect(read.timeline.length).toBe(1);
		const span = read.timeline[0]!;
		expect(span).toMatchObject({ task: "t1", wave: 1, outcome: "approved" });
		expect(span.durationMs).toBeGreaterThanOrEqual(0);
		expect(span.rowsCount).toBeGreaterThanOrEqual(2);

		expect(read.usage.wavesExecuted).toBe(1);
		expect(read.usage.byTask["t1"]).toBeDefined();
		expect(read.usage.byTask["t1"]?.waves).toBe(1);

		const convs = read.storage?.conversations ?? [];
		const implConv = convs.find((c) => c.role === "implementer");
		expect(implConv?.task).toBe("t1");
		expect((implConv?.toolRounds ?? 0)).toBeGreaterThan(0);
		expect(convs.some((c) => c.role === "verifier")).toBe(true);

		await kit.loop.close();
		kit.lock.release();
	});

	it("fresh project (init only): mirrors are template placeholders — info, not drift", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await gitInit(project.root);
		await initProject(project.root);

		const { models } = buildFauxModels([]);
		const kit = await openProjectHarness(project.root, "inspect", { modelsOverride: models });
		try {
			const read = await readout(kit.loop.paths, { loop: kit });
			const mirrors = read.health.find((check) => check.id === "mirrors");
			expect(mirrors?.ok).toBe(true);
			expect(mirrors?.detail).toContain("not written yet");
			expect(read.health.every((check) => check.ok)).toBe(true);
		} finally {
			await kit.loop.close();
			kit.lock.release();
		}
	});

	it("side-car readout while another process holds the lock: degraded, storage untouched, skip markers", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await gitInit(project.root);
		await initProject(project.root);

		const { models, faux } = buildFauxModels([]);
		faux.appendResponses([fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" })]);
		const planKit = await openProjectHarness(project.root, "plan", { modelsOverride: models });
		await runPlan(planKit, "docs/prd.md", await loadPrd(planKit));
		await planKit.loop.close();
		planKit.lock.release();

		// Another live owner now holds .orch/lock.
		const holder = await openProjectHarness(project.root, "run", { modelsOverride: buildFauxModels([]).models });
		try {
			const read = await readout(holder.loop.paths);
			expect(read.degraded).toBe(true);
			expect(read.storage).toBeUndefined();
			expect(read.phase).toBe("planning");
			expect(read.tasks.map((t) => t.id)).toEqual(["t1"]);
			expect(read.identity.lockedByPid).toBe(process.pid);
			expect(read.rows.length).toBeGreaterThanOrEqual(1);
			expect(read.timeline).toEqual([]);
			const byId = new Map(read.health.map((check) => [check.id, check]));
			expect(byId.get("storage-skip")?.severity).toBe("info");
			expect(byId.get("status-sidecar")?.ok).toBe(true);
			expect(byId.get("mirrors")?.detail).toContain("skipped");
		} finally {
			await holder.loop.close();
			holder.lock.release();
		}
	});

	it("health findings on engineered state: orphaned in_progress task + quarantined task without a patch", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await gitInit(project.root);
		await initProject(project.root);

		const { models, faux } = buildFauxModels([]);
		faux.appendResponses([fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" })]);
		const kit = await openProjectHarness(project.root, "test", { modelsOverride: models });
		try {
			await runPlan(kit, "docs/prd.md", await loadPrd(kit));
			await commitState(kit, {
				router: (draft) => {
					draft.tasks[0]!.status = "in_progress";
					draft.tasks.push({
						id: "q-sticky",
						title: "sticky quarantine",
						spec: "s",
						dependsOn: [],
						acceptance: [],
						targetPaths: [],
						priority: 0,
						status: "quarantined",
						waveCount: 2,
						baselineTreeSha: "deadbeef",
						feedback: [],
					});
				},
			});

			const read = await readout(kit.loop.paths, { loop: kit });
			const orphans = read.health.find((check) => check.id === "orphan");
			expect(orphans?.ok).toBe(false);
			expect(orphans?.detail).toContain("t1");

			const patches = read.health.find((check) => check.id === "patches");
			expect(patches?.ok).toBe(false);
			expect(patches?.detail).toContain("q-sticky");

			// a saveable patch satisfies the check: create the artifact it expects
			await writeProject(project.root, { ".orch/artifacts/quarantined-q-sticky-w2.patch": "diff" });
			const healed = await readout(kit.loop.paths, { loop: kit });
			expect(healed.health.find((check) => check.id === "patches")?.ok).toBe(true);
		} finally {
			await kit.loop.close();
			kit.lock.release();
		}
	});
});

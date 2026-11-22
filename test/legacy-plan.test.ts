/**
 * M0-P04 — v1 stores migrate without invented receipts.
 *
 * A store written by a pre-identity kit (RouterDoc/RunStatusDoc at payload
 * version 1) must open under the v2 definitions through the pinned
 * `defineDoc` pure `migrate(value, fromVersion)`:
 *
 *  - old rows stay READABLE: historical task statuses, the legacy approval
 *    stamp, recorded spend and kitVersion survive untouched;
 *  - the migration synthesizes NOTHING: no planRevision/identity for legacy
 *    plans, no receipts, no rewritten history;
 *  - a mutating run NEVER executes an unmigrated legacy plan — not even with
 *    `--approve`, and a legacy timestamp alone authorizes nothing;
 *  - the documented v1 upgrade (commit intended base → `plan` again → review
 *    → `run --approve`) migrates the store for real: identity minted, old
 *    stamp invalidated atomically, and the upgraded plan runs to completion.
 */
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "../src/engine/harness.ts";
import { defineDoc } from "../src/engine/kit.ts";
import type { SessionDocToken } from "../src/engine/kit.ts";
import { openProjectHarness } from "../src/engine/harness.ts";
import { readSessionState } from "../src/engine/state.ts";
import type { RouterTask } from "../src/engine/infos.ts";
import { prepareDemoProject, writeConfig, demoConfigToml, gitInit } from "./demo-project.ts";
import { initProject } from "../src/init.ts";
import { runCli } from "./plan-revision-helpers.ts";

// ---------------------------------------------------------------------------
// v1-shaped document tokens (the pre-identity kit's definitions), reached
// through the kit.ts seam exactly like the real ones.
// ---------------------------------------------------------------------------

type V1RouterValue = {
	version: 1;
	phase: "empty" | "planned" | "running" | "complete";
	tasks: RouterTask[];
};

const V1RouterDoc: SessionDocToken<V1RouterValue> = defineDoc({
	kind: "loop.router",
	version: 1,
	scope: "session",
	initial: (): V1RouterValue => ({ version: 1, phase: "empty", tasks: [] }),
	checkpointWhen: () => true,
});

type V1RunStatusValue = {
	version: 1;
	prdPath?: string;
	prdSha?: string;
	humanApprovedAt?: number;
	budgetSpentUsd: number;
	activeAlert?: string;
	sleepTaskId?: number;
	sleepUntil?: number;
	sleepCycleCount: number;
	consecutiveErrors: number;
	kitVersion: string;
};

const V1RunStatusDoc: SessionDocToken<V1RunStatusValue> = defineDoc({
	kind: "loop.run",
	version: 1,
	scope: "session",
	initial: (): V1RunStatusValue => ({ version: 1, budgetSpentUsd: 0, sleepCycleCount: 0, consecutiveErrors: 0, kitVersion: "0.1.0-legacy" }),
	checkpointWhen: () => true,
});

const LEGACY_TASK: RouterTask = {
	id: "t1",
	title: "one",
	spec: "write src/one.ts with the module.",
	dependsOn: [],
	acceptance: ["When src/one.ts exists, the system shall export const one = 1."],
	targetPaths: ["src/"],
	priority: 1,
	status: "in_progress",
	waveCount: 1,
	convId: 7,
	baselineTreeSha: "0123456789abcdef0123456789abcdef01234567",
	lastGateHash: "ffee",
	feedback: [{ wave: 1, from: "gate", text: "first wave failed its gate", ts: 1_600_000_000_000 }],
};

const LEGACY_STAMP_AT = 1_234_567_890_123;

/** Seed a v1-era store: planned router + approved run status + wavelog row. */
async function seedV1Store(root: string): Promise<void> {
	const kit = await openProjectHarness(root, "seed-legacy", { modelsOverride: (await import("./fixtures.ts")).buildFauxModels([]).models });
	await kit.loop.harness.commit(
		async (tx) => {
			const router = await tx.doc(V1RouterDoc);
			router.phase = "planned";
			router.tasks.push(LEGACY_TASK);
			const run = await tx.doc(V1RunStatusDoc);
			run.prdPath = "docs/prd.md";
			run.prdSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
			run.humanApprovedAt = LEGACY_STAMP_AT;
			run.budgetSpentUsd = 0.42;
			run.consecutiveErrors = 1;
			run.kitVersion = "0.1.0-legacy";
			const wavelog = await tx.doc((await import("../src/engine/infos.ts")).WaveLogDoc);
			wavelog.rows.push({ ts: 1_600_000_000_000, kind: "wave", task: "session", verb: "planned", detail: "1 task(s) from docs/prd.md (legacy)" });
		},
		BACKGROUND_CONTEXT,
	);
	await kit.loop.close();
	kit.lock.release();
}

const ONE_TASK_PLAN = {
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

const UPGRADE_REPLAY = `[planner]
${JSON.stringify(ONE_TASK_PLAN)}

[implementer]
{"tool":"write","path":"src/one.ts","content":"export const one = 1;\\n"}
---
STATUS: COMPLETE

[verifier]
{"verdict":"approve","criteria":[{"id":"1","status":"pass","evidence":[{"kind":"line","path":"src/one.ts","line":1}]}],"notes":"criterion satisfied"}
---
{"verdict":"approve","criteria":[{"id":"1","status":"pass","evidence":[{"kind":"line","path":"src/one.ts","line":1}]}],"notes":"skeptic agrees"}
`;

/** KIT_FAUX_SCRIPT wants a PATH; write the replay into the project. */
async function writeUpgradeReplay(root: string): Promise<string> {
	const path = join(root, "upgrade.replay");
	await writeFile(path, UPGRADE_REPLAY, "utf8");
	return path;
}

async function prepareProject(): Promise<string> {
	const project = await prepareDemoProject();
	await writeConfig(project.root, demoConfigToml());
	await gitInit(project.root);
	await initProject(project.root);
	return project.root;
}

describe("legacy v1 store (M0-P04)", () => {
	it("migrates old rows readably: statuses, stamp, spend, kitVersion and history survive; nothing is synthesized", async () => {
		const root = await prepareProject();
		await seedV1Store(root);

		const kit = await openProjectHarness(root, "read-legacy", { modelsOverride: (await import("./fixtures.ts")).buildFauxModels([]).models });
		const state = await readSessionState(kit.loop.harness);
		await kit.loop.close();
		kit.lock.release();

		// RouterDoc: historical rows readable through the pinned migrate.
		expect(state.router.version).toBe(2); // the MIGRATED view
		expect(state.router.phase).toBe("planned");
		expect(state.router.tasks).toEqual([LEGACY_TASK]);
		// No identity invented for the legacy plan; archive starts empty.
		expect(state.router.identity).toBeUndefined();
		expect(state.router.archived).toEqual([]);

		// RunStatusDoc: the v1 stamp and recorded facts survive untouched.
		expect(state.runStatus.humanApprovedAt).toBe(LEGACY_STAMP_AT);
		expect(state.runStatus.budgetSpentUsd).toBe(0.42);
		expect(state.runStatus.kitVersion).toBe("0.1.0-legacy");
		expect(state.runStatus.consecutiveErrors).toBe(1);
		// The migration does NOT translate the legacy stamp into a v2 approval.
		expect(state.runStatus.approvedPlanRevision).toBeUndefined();
	}, 90_000);

	it("a mutating run refuses the unmigrated legacy plan (bare and --approve) and the record stays at version 1", async () => {
		const root = await prepareProject();
		await seedV1Store(root);
		const stateBefore = JSON.stringify(await (async () => {
			const kit = await openProjectHarness(root, "snapshot", { modelsOverride: (await import("./fixtures.ts")).buildFauxModels([]).models });
			const s = await readSessionState(kit.loop.harness);
			await kit.loop.close();
			kit.lock.release();
			return s;
		})());

		// Bare run: the legacy timestamp alone authorizes nothing.
		const bare = await runCli(root, ["run"]);
		expect(bare.code).toBe(1);
		expect(bare.stderr).toMatch(/no plan revision \(v1 storage/);
		expect(bare.stderr).toMatch(/run `plan` again/);

		// A syntactically incomplete approve is refused at the CLI first (M0-P05:
		// --approve needs --revision; no hidden default revision).
		const approve = await runCli(root, ["run", "--approve"]);
		expect(approve.code).toBe(1);
		expect(approve.stderr).toMatch(/--approve needs --revision/);

		// And even a WELL-FORMED approve cannot start waves on an unmigrated plan:
		// the legacy-plan refusal names the storage, not the revision.
		const wellFormed = await runCli(root, ["run", "--approve", "--revision", "11111111-1111-4111-8111-111111111111"]);
		expect(wellFormed.code).toBe(1);
		expect(wellFormed.stderr).toMatch(/no plan revision \(v1 storage/);

		// The refusal mutated nothing — the record is still at payload version 1.
		const kit = await openProjectHarness(root, "verify-legacy", { modelsOverride: (await import("./fixtures.ts")).buildFauxModels([]).models });
		const stillV1 = await kit.loop.harness.snapshot(V1RouterDoc, BACKGROUND_CONTEXT);
		expect(stillV1).toMatchObject({ version: 1, phase: "planned" });
		expect((stillV1 as V1RouterValue).tasks[0]).toMatchObject({ id: "t1", status: "in_progress", waveCount: 1, convId: 7 });
		const stateAfter = JSON.stringify(await readSessionState(kit.loop.harness));
		await kit.loop.close();
		kit.lock.release();
		expect(stateAfter).toBe(stateBefore);
	}, 120_000);

	it("the documented v1 upgrade: replan mints the identity and invalidates the legacy stamp atomically, then review + approve completes the plan", async () => {
		const root = await prepareProject();
		await seedV1Store(root);

		// Upgrade step 1: `plan` again (replaces the legacy plan; no archived
		// ref exists because the legacy plan had no identity to reference).
		const replay = await writeUpgradeReplay(root);
		const planRun = await runCli(root, ["plan"], replay);
		expect(planRun.code).toBe(0);
		expect(planRun.stdout).toMatch(/plan revision:\s*[0-9a-f-]{36}/);
		expect(planRun.stdout).not.toMatch(/replaced:/);
		// M0-P05: the fresh revision is exactly what the upgrade's approve names.
		const upgradedRevision = /plan revision:\s*([0-9a-f-]{36})/.exec(planRun.stdout)?.[1];
		expect(upgradedRevision).toMatch(/^[0-9a-f-]{36}$/);

		// Step 2 (in the operator's flow: review router.md) — the mirror now
		// carries the durable revision and no legacy stamp survives.
		const mirror = await readFile(join(root, "router.md"), "utf8");
		expect(mirror).toMatch(/PLAN REVISION: [0-9a-f-]{36}/);

		const kit = await openProjectHarness(root, "post-upgrade", { modelsOverride: (await import("./fixtures.ts")).buildFauxModels([]).models });
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.identity).toBeDefined();
		expect(state.router.tasks[0]).toMatchObject({ id: "t1", status: "todo", waveCount: 0 }); // fresh reviewed graph
		expect(state.runStatus.approvedPlanRevision).toBeUndefined();
		expect(state.runStatus.humanApprovedAt).toBeUndefined(); // legacy approval invalidated
		expect(state.runStatus.budgetSpentUsd).toBe(0.42); // cumulative spend is never reset
		expect(state.runStatus.kitVersion).not.toBe("0.1.0-legacy"); // this kit recorded the plan
		const plannedRow = state.rows.find((r) => r.verb === "planned" && (r.detail ?? "").includes("prior approval invalidated"));
		expect(plannedRow).toBeDefined();
		await kit.loop.close();
		kit.lock.release();

		// Step 3: review happened (the mirror above); approve the fresh plan by
		// naming its revision (M0-P05: no hidden default revision).
		const run = await runCli(root, ["run", "--approve", "--revision", upgradedRevision!], replay);
		expect(run.code).toBe(0);
		expect(run.stdout).toMatch(/STATUS: COMPLETE/);

		const after = await readFile(join(root, "router.md"), "utf8");
		expect(after).toContain("STATUS: COMPLETE — task queue drained");
		const waveLog = await readFile(join(root, ".orch", "wave-log.jsonl"), "utf8");
		expect(waveLog).toContain('"verb":"done"');
	}, 180_000);
});

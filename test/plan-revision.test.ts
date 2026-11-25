/**
 * M0-P04 — reviewed plans carry identities; validation rejects before state
 * replacement; the mirror and CLI show the durable revision.
 *
 * - Every successful `plan` mints a FRESH planRevision (a UUIDv4 — even for
 *   identical replans), plus the canonical definition digest, the reviewed git
 *   base (commit/branch), and the normalized PRD path/digest. Approved
 *   controls hash into controlsSha256, where ABSENT is distinct from empty.
 * - A replan archives the replaced plan's identity references and invalidates
 *   the prior approval ATOMICALLY: the second plan lacks the first grant.
 * - Unsafe ids, colliding normalized ids, empty plans, unknown/cyclic/duplicate
 *   deps, and missing/invalid targets reject BEFORE any state replacement.
 * - A revision-qualified stamp authorizes a run; a timestamp alone (v1 legacy
 *   shape included) authorizes nothing. (Legacy-store rows themselves are
 *   covered by test/legacy-plan.test.ts.)
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildFauxModels, fauxAssistantMessage } from "./fixtures.ts";
import { bakeProject } from "./fixtures2.ts";
import { prepareDemoProject, writeConfig, demoConfigToml, gitInit } from "./demo-project.ts";
import { initProject } from "../src/init.ts";
import { openProjectHarness } from "../src/engine/harness.ts";
import { commitState, readSessionState, planRunRefusal, type SessionState } from "../src/engine/state.ts";
import { approveGrant, runWaves } from "../src/engine/waves.ts";
import { loadPrd, runPlan, PlanParseError, normalizeTasks } from "../src/engine/planner.ts";
import { canonicalSha256, loadPlanControls, type PlanIdentity } from "../src/engine/plans.ts";
import { ReceiptsDoc } from "../src/engine/receipts.ts";
import { BACKGROUND_CONTEXT } from "../src/engine/kit.ts";
import { renderRouterMd } from "../src/engine/infos.ts";
import { shasum } from "../src/util/git.ts";
import { KIT_VERSION } from "../src/config.ts";
import { runCli } from "./plan-revision-helpers.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

const PLAN_ONE = {
	tasks: [
		{
			id: "list-parse",
			title: "parseList + renderList",
			spec: "Add src/list.ts with parseList() and renderList().",
			dependsOn: [],
			acceptance: ["When parseList is called on '/a/-b', the system shall return ['a','b']."],
			targetPaths: ["src/"],
			priority: 2,
		},
	],
};

/** Same reviewed semantics as PLAN_ONE, serialized with different key order. */
const PLAN_ONE_REORDERED = {
	tasks: [
		{
			priority: 2,
			targetPaths: ["src/"],
			acceptance: ["When parseList is called on '/a/-b', the system shall return ['a','b']."],
			dependsOn: [],
			spec: "Add src/list.ts with parseList() and renderList().",
			title: "parseList + renderList",
			id: "list-parse",
		},
	],
};

async function prepareProject(): Promise<string> {
	const project = await prepareDemoProject();
	await writeConfig(project.root, demoConfigToml());
	await gitInit(project.root);
	await initProject(project.root);
	return project.root;
}

interface PlannedRun {
	planRevision: string;
	state: Awaited<ReturnType<typeof readSessionState>>;
	prdText: string;
}

async function planOnce(root: string, plannerJson: unknown, script: Parameters<ReturnType<typeof buildFauxModels>["faux"]["appendResponses"]>[0]): Promise<PlannedRun> {
	const { models, faux } = buildFauxModels([]);
	faux.appendResponses([script]);
	const kit = await openProjectHarness(root, "plan", { modelsOverride: models });
	const prdText = await loadPrd(kit);
	const outcome = await runPlan(kit, "docs/prd.md", prdText);
	const state = await readSessionState(kit.loop.harness);
	await kit.loop.close();
	kit.lock.release();
	return { planRevision: outcome.planRevision, state, prdText };
}

describe("plan identity (M0-P04)", () => {
	it("mints a fresh identity per plan; identical replans differ in revision but share the definition digest; the second plan lacks the first grant", async () => {
		const root = await prepareProject();

		const first = await planOnce(root, PLAN_ONE, fauxAssistantMessage(JSON.stringify(PLAN_ONE), { stopReason: "stop" }));
		const id1 = first.state.router.identity;
		expect(id1).toBeDefined();
		expect(id1!.planRevision).toMatch(UUID_RE);
		expect(id1!.definitionSha256).toMatch(SHA_RE);
		expect(id1!.prdPath).toBe("docs/prd.md");
		expect(id1!.prdSha256).toBe(shasum(first.prdText));
		// Approved controls exist in the fixture (PROMPT.md, checklist, human
		// recipes) — the digest is present, and ABSENT would have meant no
		// control input at all.
		expect(id1!.controlsSha256).toMatch(SHA_RE);
		// The reviewed base is the git HEAD (commit + branch), not the working tree.
		const { exec } = await import("../src/util/exec.ts");
		const head = await exec(["git", "rev-parse", "HEAD"], { cwd: root, timeoutMs: 15_000 });
		expect(id1!.baseCommit).toBe(head.stdout.trim());
		expect(id1!.baseBranch).toBeTruthy();
		// First plan replaced nothing and archived nothing.
		expect(first.state.router.archived).toEqual([]);

		// The mirror shows the durable revision and matches the durable render byte-for-byte.
		const mirror = await readFile(join(root, "router.md"), "utf8");
		expect(mirror).toContain(`PLAN REVISION: ${id1!.planRevision}`);
		expect(mirror).toContain(`DEFINITION SHA256: ${id1!.definitionSha256}`);
		expect(mirror).toBe(
			renderRouterMd(first.state.router.tasks, first.state.router.phase, first.state.runStatus.prdPath, id1, first.state.router.archived),
		);

		// Approve the first plan with the durable revision-qualified stamp.
		const approveKit = await openProjectHarness(root, "run", { modelsOverride: buildFauxModels([]).models });
		await commitState(approveKit, {
			runStatus: (d) => {
				d.approvedPlanRevision = id1!.planRevision;
				d.humanApprovedAt = 1_700_000_000_000;
			},
		});
		await approveKit.loop.close();
		approveKit.lock.release();

		// Identical replan: new revision, same definition digest, archived ref, no grant.
		const second = await planOnce(root, PLAN_ONE, fauxAssistantMessage(JSON.stringify(PLAN_ONE), { stopReason: "stop" }));
		const id2 = second.state.router.identity;
		expect(id2).toBeDefined();
		expect(id2!.planRevision).not.toBe(id1!.planRevision);
		expect(id2!.definitionSha256).toBe(id1!.definitionSha256);
		expect(second.state.router.archived.map((r) => r.planRevision)).toEqual([id1!.planRevision]);
		expect(second.state.router.archived[0]!.definitionSha256).toBe(id1!.definitionSha256);
		// The second plan lacks the first grant: approval invalidated atomically.
		expect(second.state.runStatus.approvedPlanRevision).toBeUndefined();
		expect(second.state.runStatus.humanApprovedAt).toBeUndefined();
		// The run authorization gate agrees: bare run is refused on the fresh plan.
		expect(planRunRefusal(second.state, { approve: false })).toMatch(/not human-approved for its current plan revision/);
	}, 90_000);

	it("captures the control bundle before disclosure: a control edited during planning is drift (M1-P01 step d)", async () => {
		const root = await prepareProject();
		const { models, faux } = buildFauxModels([]);
		faux.appendResponses([async () => {
			// Mutate a reviewed control WHILE the planner is answering. The identity
			// must describe the bytes captured before disclosure, not this edit.
			await writeFile(join(root, "evals", "checklist.md"), "EDITED DURING PLANNING\n", "utf8");
			return fauxAssistantMessage(JSON.stringify(PLAN_ONE), { stopReason: "stop" });
		}]);
		const kit = await openProjectHarness(root, "plan", { modelsOverride: models });
		const outcome = await runPlan(kit, "docs/prd.md", await loadPrd(kit));
		await kit.loop.close();
		kit.lock.release();

		const runKit = await openProjectHarness(root, "run", { modelsOverride: buildFauxModels([]).models });
		try {
			await expect(approveGrant(runKit, { planRevision: outcome.planRevision })).rejects.toThrow(/reviewed controls changed/);
			expect((await readSessionState(runKit.loop.harness)).runStatus.approvedPlanRevision).toBeUndefined();
		} finally {
			await runKit.loop.close().catch(() => {});
			runKit.lock.release();
		}
	}, 90_000);

	it("refuses a plan when a committed recipe byte is edited without a commit (M1-P01 step d)", async () => {
		const baked = await bakeProject({ buildFauxModels });
		const root = baked.project.root;
		try {
			// bakeProject commits the template controls; editing one after that
			// makes the plan review bytes the driver would NOT execute (it reads the
			// immutable base tree). The refusal happens before the planner runs.
			const recipesPath = join(root, "evals", "recipes.toml");
			const committedRecipes = await readFile(recipesPath, "utf8");
			await writeFile(recipesPath, "[uncommitted-gate]\nargv = [\"node\", \"-e\", \"require('node:fs').writeFileSync('uncommitted-gate-ran','yes')\"]\n", "utf8");
			const error = await runPlan(baked.kit, "docs/prd.md", await loadPrd(baked.kit)).then(
				() => undefined,
				(err: unknown) => err,
			);
			expect(error).toBeInstanceOf(PlanParseError);
			expect((error as Error).message).toMatch(/evals\/recipes\.toml differs from base commit[\s\S]*commit the reviewed evals\/\*\* and PROMPT\.md bytes/);
			expect(baked.models.faux.state.callCount).toBe(0);
			// The uncommitted recipe command never ran: no effect marker, no plan.
			expect(await readFile(join(root, "uncommitted-gate-ran"), "utf8").catch(() => "<absent>")).toBe("<absent>");

			// The same rule covers PROMPT.md, which the wave driver reads from the
			// projected start tree.
			await writeFile(recipesPath, committedRecipes, "utf8");
			await writeFile(join(root, "PROMPT.md"), "UNCOMMITTED WAVE RULES\n", "utf8");
			const promptError = await runPlan(baked.kit, "docs/prd.md", await loadPrd(baked.kit)).then(
				() => undefined,
				(err: unknown) => err,
			);
			expect(promptError).toBeInstanceOf(PlanParseError);
			expect((promptError as Error).message).toMatch(/PROMPT\.md differs from base commit/);
			expect(baked.models.faux.state.callCount).toBe(0);
			const state = await readSessionState(baked.kit.loop.harness);
			expect(state.router.identity).toBeUndefined();
			expect(state.router.tasks).toEqual([]);
		} finally {
			await baked.kit.loop.close().catch(() => {});
			baked.kit.lock.release();
		}
	}, 90_000);

	it("a pre-step-(d) control digest refuses resume as a migration, not an on-disk edit, and rewrites no receipts", async () => {
		const root = await prepareProject();
		const planned = await planOnce(root, PLAN_ONE, fauxAssistantMessage(JSON.stringify(PLAN_ONE), { stopReason: "stop" }));
		const { models, faux } = buildFauxModels([]);
		const kit = await openProjectHarness(root, "run", { modelsOverride: models });
		try {
			await approveGrant(kit, { planRevision: planned.planRevision });
			// Seed the OLD five-field digest shape a pre-step-(d) plan recorded.
			const controls = await loadPlanControls(root, { prdPath: "docs/prd.md" });
			const oldDigest = canonicalSha256({
				remediations: controls.remediations,
				promptSha256: controls.prompt?.sha256 ?? null,
				checklistSha256: controls.evals?.find((file) => file.path === "evals/checklist.md")?.sha256 ?? null,
				recipesSha256: controls.evals?.find((file) => file.path === "evals/recipes.toml")?.sha256 ?? null,
				recipesAutoSha256: controls.evals?.find((file) => file.path === "evals/recipes.auto.toml")?.sha256 ?? null,
			});
			await commitState(kit, { router: (draft) => { draft.identity!.controlsSha256 = oldDigest; } });
			const receiptsBefore = (await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT))?.events.length ?? 0;
			const callsBefore = faux.state.callCount;

			await expect(runWaves(kit, { tasksFilter: [] })).rejects.toThrow(/pre-M1-P01-step-\(d\) control digest shape[\s\S]*replan and re-approve/);

			const receiptsAfter = (await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT))?.events.length ?? 0;
			expect(receiptsAfter).toBe(receiptsBefore);
			expect(faux.state.callCount).toBe(callsBefore);
			const state = await readSessionState(kit.loop.harness);
			expect(state.router.tasks[0]).toMatchObject({ status: "todo", waveCount: 0 });
		} finally {
			await kit.loop.close().catch(() => {});
			kit.lock.release();
		}
	}, 90_000);

	it("a changed non-recipe eval byte refuses a NEW grant before approval is minted (M1-P01 step d)", async () => {
		const root = await prepareProject();
		const planned = await planOnce(root, PLAN_ONE, fauxAssistantMessage(JSON.stringify(PLAN_ONE), { stopReason: "stop" }));
		await writeFile(join(root, "evals", "checklist.md"), "TAMPERED REVIEW RULES\n", "utf8");
		const kit = await openProjectHarness(root, "run", { modelsOverride: buildFauxModels([]).models });
		try {
			await expect(approveGrant(kit, { planRevision: planned.planRevision })).rejects.toThrow(/reviewed controls changed/);
			const state = await readSessionState(kit.loop.harness);
			expect(state.runStatus.approvedPlanRevision).toBeUndefined();
			expect(state.runStatus.approvedSelected).toBeUndefined();
			expect(state.runStatus.humanApprovedAt).toBeUndefined();
			expect(state.router.phase).toBe("planned");
		} finally {
			await kit.loop.close().catch(() => {});
			kit.lock.release();
		}
	}, 90_000);

	it("canonical hashing: key order is irrelevant, array order is significant; replans from reordered planner JSON share the definition digest", async () => {
		// Unit: object keys sort recursively; arrays keep order.
		expect(canonicalSha256({ b: 1, a: { d: [2, 1], c: "x" } })).toBe(canonicalSha256({ a: { c: "x", d: [2, 1] }, b: 1 }));
		expect(canonicalSha256([1, 2])).not.toBe(canonicalSha256([2, 1]));
		expect(canonicalSha256({ a: 1 })).not.toBe(canonicalSha256({ a: "1" }));

		const root = await prepareProject();
		const first = await planOnce(root, PLAN_ONE, fauxAssistantMessage(JSON.stringify(PLAN_ONE), { stopReason: "stop" }));
		const second = await planOnce(root, PLAN_ONE_REORDERED, fauxAssistantMessage(JSON.stringify(PLAN_ONE_REORDERED), { stopReason: "stop" }));
		expect(second.planRevision).not.toBe(first.planRevision);
		expect(second.state.router.identity!.definitionSha256).toBe(first.state.router.identity!.definitionSha256);

		// Array order IS part of the reviewed definition: a swapped acceptance
		// list is a different plan even when the prose is the same set.
		const swapped = structuredClone(PLAN_ONE);
		const task = swapped.tasks[0]!;
		task.acceptance = [...task.acceptance, "When renderList runs, the system shall print one line."];
		const third = await planOnce(root, swapped, fauxAssistantMessage(JSON.stringify(swapped), { stopReason: "stop" }));
		expect(third.state.router.identity!.definitionSha256).not.toBe(first.state.router.identity!.definitionSha256);
		expect(third.state.router.archived.map((r) => r.planRevision)).toEqual([second.planRevision, first.planRevision]);
	}, 90_000);

	it("the CLI prints the durable revision, the mirror carries it, and a documented replan names the replaced plan", async () => {
		const root = await prepareProject();
		const replay = join(root, "plan.replay");
		const writeReplay = async (json: unknown) => {
			await writeFile(replay, `[planner]\n${JSON.stringify(json)}\n`, "utf8");
		};

		await writeReplay(PLAN_ONE);
		const firstRun = await runCli(root, ["plan"], replay);
		expect(firstRun.code).toBe(0);
		const firstRevision = /plan revision:\s*([0-9a-f-]{36})/.exec(firstRun.stdout)?.[1];
		expect(firstRevision).toMatch(UUID_RE);
		const firstMirror = await readFile(join(root, "router.md"), "utf8");
		expect(firstMirror).toContain(`PLAN REVISION: ${firstRevision}`);

		// Replan through the documented flow: revise the PRD and rerun plan.
		await writeReplay(PLAN_ONE_REORDERED);
		const secondRun = await runCli(root, ["plan"], replay);
		expect(secondRun.code).toBe(0);
		const secondRevision = /plan revision:\s*([0-9a-f-]{36})/.exec(secondRun.stdout)?.[1];
		expect(secondRevision).toMatch(UUID_RE);
		expect(secondRevision).not.toBe(firstRevision);
		expect(secondRun.stdout).toContain(`replaced: ${firstRevision} (archived; prior approval invalidated)`);
		const secondMirror = await readFile(join(root, "router.md"), "utf8");
		expect(secondMirror).toContain(`PLAN REVISION: ${secondRevision}`);
		expect(secondMirror).toContain(`- ${firstRevision} (archived `);
	}, 120_000);
});

describe("plan validation rejects before replacing state (M0-P04)", () => {
	const CASES: Array<{ name: string; planner: unknown; message: RegExp }> = [
		{ name: "empty plan", planner: { tasks: [] }, message: /empty plan/ },
		{
			name: "colliding normalized ids",
			planner: {
				tasks: [
					{ id: "My Task", title: "a", spec: "s", dependsOn: [], acceptance: ["c"], targetPaths: ["src/"], priority: 1 },
					{ id: "my-task", title: "b", spec: "s", dependsOn: [], acceptance: ["c"], targetPaths: ["src/"], priority: 1 },
				],
			},
			message: /duplicate task id after normalization.*"my-task"/s,
		},
		{
			name: "unsafe id keeps its leading dash (the -b case)",
			planner: { tasks: [{ id: "-b", title: "b", spec: "s", dependsOn: [], acceptance: ["c"], targetPaths: ["src/"], priority: 1 }] },
			message: /"-b" is not a safe task id/,
		},
		{
			name: "unsafe id longer than 63 characters",
			planner: { tasks: [{ id: "a".repeat(65), title: "a", spec: "s", dependsOn: [], acceptance: ["c"], targetPaths: ["src/"], priority: 1 }] },
			message: /not a safe task id/,
		},
		{
			name: "duplicate deps",
			planner: {
				tasks: [
					{ id: "t1", title: "a", spec: "s", dependsOn: [], acceptance: ["c"], targetPaths: ["src/"], priority: 1 },
					{ id: "t2", title: "b", spec: "s", dependsOn: ["t1", "t1"], acceptance: ["c"], targetPaths: ["src/"], priority: 1 },
				],
			},
			message: /dependsOn has duplicate entries/,
		},
		{
			name: "unknown dep",
			planner: { tasks: [{ id: "t1", title: "a", spec: "s", dependsOn: ["ghost"], acceptance: ["c"], targetPaths: ["src/"], priority: 1 }] },
			message: /dependsOn unknown task "ghost"/,
		},
		{
			name: "cyclic deps",
			planner: {
				tasks: [
					{ id: "t1", title: "a", spec: "s", dependsOn: ["t2"], acceptance: ["c"], targetPaths: ["src/"], priority: 1 },
					{ id: "t2", title: "b", spec: "s", dependsOn: ["t1"], acceptance: ["c"], targetPaths: ["src/"], priority: 1 },
				],
			},
			message: /cycle through "t1"/,
		},
		{
			name: "missing targetPaths",
			planner: { tasks: [{ id: "t1", title: "a", spec: "s", dependsOn: [], acceptance: ["c"], priority: 1 }] },
			message: /missing targetPaths.*\[\] means unrestricted admissible paths/s,
		},
		{
			name: "targetPaths is not an array",
			planner: { tasks: [{ id: "t1", title: "a", spec: "s", dependsOn: [], acceptance: ["c"], targetPaths: "src/", priority: 1 }] },
			message: /targetPaths must be an array/,
		},
		{
			name: "absolute target path",
			planner: { tasks: [{ id: "t1", title: "a", spec: "s", dependsOn: [], acceptance: ["c"], targetPaths: ["/etc"], priority: 1 }] },
			message: /not a safe project-relative path/,
		},
		{
			name: "traversal target path",
			planner: { tasks: [{ id: "t1", title: "a", spec: "s", dependsOn: [], acceptance: ["c"], targetPaths: ["../escape"], priority: 1 }] },
			message: /not a safe project-relative path/,
		},
		{
			name: "empty target path entry",
			planner: { tasks: [{ id: "t1", title: "a", spec: "s", dependsOn: [], acceptance: ["c"], targetPaths: [""], priority: 1 }] },
			message: /targetPaths entries must be non-empty strings/,
		},
	];

	it("every rejection leaves the previous plan, run status, wave-log, and mirror byte-identical", async () => {
		const root = await prepareProject();
		const { models, faux } = buildFauxModels([]);
		const kit = await openProjectHarness(root, "plan", { modelsOverride: models });
		const prdText = await loadPrd(kit);

		// An empty project is the "previous plan": one failing parse must not
		// move any durable byte.
		const snapshot = async (): Promise<string> => {
			const state = await readSessionState(kit.loop.harness);
			const log = await readFile(join(root, ".orch", "wave-log.jsonl"), "utf8").catch(() => "<absent>");
			const mirror = await readFile(join(root, "router.md"), "utf8").catch(() => "<absent>");
			return JSON.stringify({ state, log, mirror });
		};
		const before = await snapshot();

		for (const testCase of CASES) {
			faux.appendResponses([fauxAssistantMessage(JSON.stringify(testCase.planner), { stopReason: "stop" })]);
			const failure: PlanParseError | undefined = await runPlan(kit, "docs/prd.md", prdText).then(
				() => undefined,
				(err: unknown) => (err instanceof PlanParseError ? err : undefined),
			);
			expect(failure, testCase.name).toBeDefined();
			expect(failure?.message, testCase.name).toMatch(testCase.message);
			expect(await snapshot(), testCase.name).toBe(before);
		}

		await kit.loop.close();
		kit.lock.release();
	}, 120_000);

	it("accepts [] as the explicit unrestricted-admissible-paths marker and normalizes ids to the safe shape", () => {
		const tasks = normalizeTasks({
			tasks: [
				{ id: "Write The Parser", title: "a", spec: "s", dependsOn: [], acceptance: ["c"], targetPaths: [], priority: 1 },
				{ id: "verify_it", title: "b", spec: "s", dependsOn: ["write-the-parser"], acceptance: ["c"], targetPaths: ["src/x.ts"], priority: 1 },
			],
		});
		expect(tasks.map((t) => t.id)).toEqual(["write-the-parser", "verify_it"]);
		expect(tasks[0]!.targetPaths).toEqual([]);
	});
});

describe("plan-authorization gate (M0-P04)", () => {
	const TASK_ROW = {
		id: "t1",
		title: "one",
		spec: "s",
		dependsOn: [],
		acceptance: ["c"],
		targetPaths: ["src/"],
		priority: 1,
		status: "todo" as const,
		waveCount: 0,
		feedback: [],
	};

	const stateWith = (identity?: PlanIdentity, stamp?: { revision?: string; at?: number }): SessionState => ({
		router: {
			version: 2,
			phase: "planned",
			tasks: [TASK_ROW],
			archived: [],
			...(identity ? { identity } : {}),
		},
		runStatus: {
			version: 2,
			budgetSpentUsd: 0,
			sleepCycleCount: 0,
			consecutiveErrors: 0,
			kitVersion: KIT_VERSION,
			...(stamp?.revision ? { approvedPlanRevision: stamp.revision } : {}),
			...(stamp?.at ? { humanApprovedAt: stamp.at } : {}),
		},
		rows: [],
	});

	const identityOf = (revision: string): PlanIdentity => ({
		planRevision: revision,
		definitionSha256: "0".repeat(64),
		baseCommit: null,
		baseBranch: null,
		prdPath: "docs/prd.md",
		prdSha256: "0".repeat(64),
	});

	it("a plan with no identity is never runnable — not even with --approve (unmigrated legacy plans)", () => {
		const refusal = planRunRefusal(stateWith(undefined, { revision: undefined, at: 1_700_000_000_000 }), { approve: true });
		expect(refusal).toMatch(/no plan revision \(v1 storage/);
		expect(planRunRefusal(stateWith(undefined), { approve: false })).toMatch(/no plan revision/);
	});

	it("timestamps alone authorize no run: the stamp must name the current plan revision", () => {
		const id = identityOf("11111111-1111-4111-8111-111111111111");
		expect(planRunRefusal(stateWith(id), { approve: false })).toMatch(/not human-approved for its current plan revision/);
		expect(planRunRefusal(stateWith(id, { at: 1_700_000_000_000 }), { approve: false })).toMatch(/not human-approved/);
		expect(planRunRefusal(stateWith(id, { revision: "22222222-2222-4222-8222-222222222222" }), { approve: false })).toMatch(/not human-approved/);
		expect(planRunRefusal(stateWith(id, { revision: "22222222-2222-4222-8222-222222222222", at: 1_700_000_000_000 }), { approve: false })).toMatch(
			/not human-approved/,
		);
		expect(planRunRefusal(stateWith(id, { revision: id.planRevision, at: 1_700_000_000_000 }), { approve: false })).toBeUndefined();
		// An explicit --approve is a fresh approval act and overrides a stale stamp.
		expect(planRunRefusal(stateWith(id, { revision: "22222222-2222-4222-8222-222222222222", at: 1_700_000_000_000 }), { approve: true })).toBeUndefined();
	});

	it("an empty (task-less) old store is not legacy-refused: it may plan immediately", () => {
		const empty: SessionState = {
			router: { version: 2, phase: "empty", tasks: [], archived: [] },
			runStatus: { version: 2, budgetSpentUsd: 0, sleepCycleCount: 0, consecutiveErrors: 0, kitVersion: KIT_VERSION },
			rows: [],
		};
		expect(planRunRefusal(empty, { approve: true })).toBeUndefined();
	});
});

describe("mirror parity keeps holding with identity present", () => {
	it("router.md on disk matches the durable render after a plan (the gate's engineSynced contract)", async () => {
		const root = await prepareProject();
		const { models, faux } = buildFauxModels([]);
		faux.appendResponses([fauxAssistantMessage(JSON.stringify(PLAN_ONE), { stopReason: "stop" })]);
		const kit = await openProjectHarness(root, "plan", { modelsOverride: models });
		await runPlan(kit, "docs/prd.md", await loadPrd(kit));
		const state = await readSessionState(kit.loop.harness);
		await kit.loop.close();
		kit.lock.release();

		const disk = readFileSync(join(root, "router.md"), "utf8");
		const expected = renderRouterMd(state.router.tasks, state.router.phase, state.runStatus.prdPath, state.router.identity, state.router.archived);
		expect(disk).toBe(expected);
		expect(disk).toContain("PLAN REVISION: ");
	});
});

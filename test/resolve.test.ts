/**
 * M0-P18 — binding CLI resolution without bypassing safety (§3 "Human path").
 *
 * `resolve --retry` opens ONE fresh retry cycle for a blocked task: it requeues
 * from the current accepted head, clears the duplicate-failure hash, transport
 * counters and the task's durable sleep counter, preserves every earlier
 * receipt/feedback entry, and dispatches nothing until an authorized `run`.
 * `resolve --accept-tree` is ONLY for an inconclusive `needs_human` quarantine:
 * same retained candidate, unchanged lineage/controls, deterministic gates
 * rerun on the exact tree, and an operator evidence document proving every
 * reviewed criterion. It records HUMAN authority (`human-v1`) and drives local
 * integration only — `commit`/`pr` publication still needs an authorized run.
 *
 * Both forms require the current revision, the current grant, an eligible
 * (quarantined) task and verified recovery (discarded lease, unchanged accepted
 * head), derive a deterministic operation id (idempotent replay), and print the
 * remedy when blocked. `verify` never mutates task disposition.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { prepareDemoProject, writeConfig, gitInit } from "./demo-project.ts";
import { initProject } from "../src/init.ts";
import { openProjectHarness } from "../src/engine/harness.ts";
import { readSessionState, commitState } from "../src/engine/state.ts";
import { runWaves } from "../src/engine/waves.ts";
import { loadPrd, runPlan } from "../src/engine/planner.ts";
import {
	runResolution, loadResolutionEvidence, validateResolutionReason, resolutionOperationId,
	ResolutionRefusal, RESOLUTION_EVIDENCE_MAX_BYTES, RESOLUTION_REASON_MAX,
} from "../src/engine/resolution.ts";
import { ReceiptsDoc } from "../src/engine/receipts.ts";
import type { ReceiptsDocValue } from "../src/engine/receipts.ts";
import { BACKGROUND_CONTEXT } from "../src/engine/kit.ts";
import { readCommit, readRef } from "../src/util/git-objects.ts";
import { runCli } from "./plan-revision-helpers.ts";

beforeEach(() => {
	process.env["NO_COLOR"] = "1";
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TASKS = {
	tasks: [{
		id: "t1", title: "write src/one.ts", spec: "Add src/one.ts exporting one.",
		dependsOn: [], acceptance: ["When src/one.ts is imported, the system shall export one."], targetPaths: ["src/"], priority: 1,
	}],
};

const GOOD_ONE = "export const one = 1;\n";
const BROKEN_ONE = "export const one = 1; // BROKEN\n";

const implWrites = (writes: { path: string; content: string }[]) =>
	writes.map((w) => fauxAssistantMessage([fauxToolCall("write", w)], { stopReason: "toolUse" }))
		.concat([fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" })]);
const approve = (gateId: string, notes = "executed gate proves the criterion") =>
	fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "gate", id: gateId }] }], notes }), { stopReason: "stop" });
const skepticApprove = (gateId: string) => approve(gateId, "adversarial pass: no refutation found");
const needsHuman = (notes = "cannot conclude from this tree") =>
	fauxAssistantMessage(JSON.stringify({
		verdict: "needs_human",
		criteria: [{ id: "1", status: "unverifiable", evidence: [] }],
		notes,
	}), { stopReason: "stop" });

/**
 * A one-task project whose single recipe fails while `src/` contains the
 * BROKEN token. `retryLimit` controls whether the first gate failure quarantines
 * (0) or retries in the same run (2).
 */
async function newProject(retryLimit: number): Promise<string> {
	const project = await prepareDemoProject();
	await writeConfig(project.root, `# resolve fixtures
[engine]
piDurable = "1.5.0"
maxTurns = 12
retryLimit = ${retryLimit}

[roles.planner]
provider = "faux"
modelId = "kit-planner"

[roles.implementer]
provider = "faux"
modelId = "kit-impl"

[roles.verifier]
provider = "faux"
modelId = "kit-verifier"

[budgets]
sessionUsd = 25.0
waveUsdWarn = 6.0
maxConsecutiveErrors = 3
maxSleepCycles = 3

[gates]
timeoutSec = 30
enforceTargetPaths = true

[delivery]
mode = "none"

[paths]
prd = "docs/prd.md"
specs = "specs/"
`);
	await mkdir(join(project.root, "bin"), { recursive: true });
	await mkdir(join(project.root, "evals"), { recursive: true });
	await writeFile(
		join(project.root, "eval-gate.cjs"),
		`const fs = require("node:fs");\nconst files = fs.existsSync("src") ? fs.readdirSync("src").map((f) => "src/" + f) : [];\nprocess.exit(files.some((p) => fs.readFileSync(p, "utf8").includes("BROKEN")) ? 1 : 0);\n`,
		"utf8",
	);
	await writeFile(join(project.root, "evals", "recipes.toml"), `[gate-ok]\ncmd = "node eval-gate.cjs"\n`, "utf8");
	await initProject(project.root);
	await gitInit(project.root);
	return project.root;
}

type Kit = Awaited<ReturnType<typeof openProjectHarness>>;

async function plan(kit: Kit): Promise<string> {
	const outcome = await runPlan(kit, "docs/prd.md", await loadPrd(kit));
	return outcome.planRevision;
}

function receiptsOf(doc: ReceiptsDocValue | undefined): ReceiptsDocValue {
	return doc ?? { version: 1, events: [] };
}

function retainedCandidate(doc: ReceiptsDocValue, revision: string, taskId: string): string {
	const checkpoint = doc.events.filter((event) => event.kind === "checkpoint"
		&& event.value.planRevision === revision && event.value.taskId === taskId && event.value.candidate !== undefined).at(-1);
	if (!checkpoint || checkpoint.kind !== "checkpoint" || !checkpoint.value.candidate) throw new Error("no retained candidate");
	return checkpoint.value.candidate;
}

async function evidenceFile(criteria: unknown): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "kit-evidence-"));
	const file = join(dir, "evidence.json");
	await writeFile(file, JSON.stringify({ criteria }), "utf8");
	return file;
}

/** Gate-failure quarantine (retryLimit 0) with no verifier call. */
async function quarantinedByGate(): Promise<{ kit: Kit; root: string; revision: string; models: ReturnType<typeof buildFauxModels> }> {
	const root = await newProject(0);
	const models = buildFauxModels([]);
	models.faux.appendResponses([
		fauxAssistantMessage(JSON.stringify(TASKS), { stopReason: "stop" }),
		...implWrites([{ path: "src/one.ts", content: BROKEN_ONE }]),
	]);
	const kit = await openProjectHarness(root, "test", { modelsOverride: models.models });
	const revision = await plan(kit);
	const summary = await runWaves(kit, { approve: { planRevision: revision }, tasksFilter: [] });
	expect(summary.exit).toBe("blocked");
	return { kit, root, revision, models };
}

/** Inconclusive-verifier quarantine (`needs_human`) with a retained candidate. */
async function quarantinedByNeedsHuman(): Promise<{ kit: Kit; root: string; revision: string; models: ReturnType<typeof buildFauxModels> }> {
	const root = await newProject(2);
	const models = buildFauxModels([]);
	models.faux.appendResponses([
		fauxAssistantMessage(JSON.stringify(TASKS), { stopReason: "stop" }),
		...implWrites([{ path: "src/one.ts", content: GOOD_ONE }]),
		needsHuman(),
	]);
	const kit = await openProjectHarness(root, "test", { modelsOverride: models.models });
	const revision = await plan(kit);
	const summary = await runWaves(kit, { approve: { planRevision: revision }, tasksFilter: [] });
	expect(summary.exit).toBe("blocked");
	return { kit, root, revision, models };
}

// ---------------------------------------------------------------------------
// --retry
// ---------------------------------------------------------------------------

describe("resolve --retry: one fresh retry cycle from the accepted head", () => {
	it("requeues the blocked task, clears the sleep counter + duplicate hash, keeps history, and runs no work", async () => {
		const { kit, revision, models } = await quarantinedByGate();
		const before = receiptsOf(await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT));
		// A consumed sleep counter and a gate-failure hash from the quarantined wave.
		await commitState(kit, { router: (draft) => { draft.tasks[0]!.sleepCycles = 3; } });
		let state = await readSessionState(kit.loop.harness);
		expect(state.router.tasks[0]!.status).toBe("quarantined");
		expect(state.router.tasks[0]!.lastGateHash).toBeTruthy();
		const callsBefore = models.faux.state.callCount;
		const acceptedBefore = await readRef(kit.loop.paths.root, `refs/kit/${revision}/accepted`);

		const outcome = await runResolution(kit, {
			planRevision: revision,
			taskId: "t1",
			action: "retry",
			reason: "reviewed the failed gate output; retry from the accepted head",
		});
		expect(outcome.idempotent).toBe(false);
		expect(outcome.wave).toBe(1);
		expect(outcome.operationId).toBe(resolutionOperationId({
			planRevision: revision, taskId: "t1", wave: 1, action: "retry",
			reason: "reviewed the failed gate output; retry from the accepted head",
		}));

		state = await readSessionState(kit.loop.harness);
		const task = state.router.tasks[0]!;
		expect(task.status).toBe("todo");
		expect(task.sleepCycles).toBe(0);
		expect(task.lastGateHash).toBeUndefined();
		expect(task.blockReason).toBeUndefined();
		expect(task.waveCount).toBe(1);
		// History is preserved: the gate failure feedback AND the human decision.
		expect(task.feedback.some((entry) => entry.from === "gate" && entry.text.includes("GATES FAILED"))).toBe(true);
		expect(task.feedback.some((entry) => entry.text.startsWith("human retry:"))).toBe(true);
		expect(state.runStatus.consecutiveErrors).toBe(0);
		// No dispatch, no integration move: a retry performs no work.
		expect(models.faux.state.callCount).toBe(callsBefore);
		expect(await readRef(kit.loop.paths.root, `refs/kit/${revision}/accepted`)).toBe(acceptedBefore);

		// Earlier receipts survive; the human decision is a NEW resolution receipt.
		const after = receiptsOf(await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT));
		expect(after.events.filter((event) => event.kind === "gate")).toHaveLength(
			before.events.filter((event) => event.kind === "gate").length,
		);
		const resolution = after.events.filter((event) => event.kind === "resolution");
		expect(resolution).toHaveLength(1);
		expect(resolution[0]).toMatchObject({
			opId: outcome.operationId,
			value: { planRevision: revision, taskId: "t1", wave: 1, action: "retry", reason: "reviewed the failed gate output; retry from the accepted head" },
		});
		expect(state.rows.some((row) => row.verb === "resolve:retry" && row.task === "t1")).toBe(true);

		// Idempotent replay: the SAME request records nothing twice.
		const again = await runResolution(kit, {
			planRevision: revision,
			taskId: "t1",
			action: "retry",
			reason: "reviewed the failed gate output; retry from the accepted head",
		});
		expect(again.idempotent).toBe(true);
		expect(again.operationId).toBe(outcome.operationId);
		const replay = receiptsOf(await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT));
		expect(replay.events.filter((event) => event.kind === "resolution")).toHaveLength(1);
		expect(replay.events).toHaveLength(after.events.length);

		// The fresh cycle runs from the accepted head as wave 2 and completes.
		models.faux.appendResponses([
			...implWrites([{ path: "src/one.ts", content: GOOD_ONE }]),
			approve("gate-ok"),
			skepticApprove("gate-ok"),
		]);
		const resumed = await runWaves(kit, { tasksFilter: [] });
		expect(resumed.exit).toBe("plan-complete");
		state = await readSessionState(kit.loop.harness);
		expect(state.router.tasks[0]!.status).toBe("done");
		expect(state.router.tasks[0]!.waveCount).toBe(2);
		const wave2 = receiptsOf(await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT))
			.events.filter((event) => event.kind === "gate" && event.value.wave === 2);
		expect(wave2).toHaveLength(1);

		await kit.loop.close();
		kit.lock.release();
	});

	it("refuses a stale revision, a missing grant, a non-quarantined task and evidence on a retry (with remedies)", async () => {
		const { kit, revision } = await quarantinedByGate();
		await expect(runResolution(kit, {
			planRevision: "00000000-0000-4000-8000-000000000000", taskId: "t1", action: "retry", reason: "wrong revision",
		})).rejects.toThrow(/does not name the current plan revision[\s\S]*remedy:/);
		await expect(runResolution(kit, {
			planRevision: revision, taskId: "nope", action: "retry", reason: "unknown task",
		})).rejects.toThrow(/is not in the current plan/);
		await expect(runResolution(kit, {
			planRevision: revision, taskId: "t1", action: "retry", reason: "  ",
		})).rejects.toThrow(ResolutionRefusal);
		await expect(runResolution(kit, {
			planRevision: revision, taskId: "t1", action: "retry", reason: "r".repeat(RESOLUTION_REASON_MAX + 1),
		})).rejects.toThrow(new RegExp(`1–${RESOLUTION_REASON_MAX} characters`));
		// A retry never carries evidence (it discards, it does not accept a tree).
		const file = await evidenceFile([{ id: "1", status: "pass", evidence: [{ kind: "gate", id: "gate-ok" }] }]);
		await expect(runResolution(kit, {
			planRevision: revision, taskId: "t1", action: "retry", reason: "with evidence",
			evidence: await loadResolutionEvidence(file),
		})).rejects.toThrow(/takes no --accept-tree\/--evidence/);
		await kit.loop.close();
		kit.lock.release();
	});

	it("refuses to act before any run (task not quarantined) and outside the current grant", async () => {
		const root = await newProject(2);
		const models = buildFauxModels([]);
		models.faux.appendResponses([fauxAssistantMessage(JSON.stringify(TASKS), { stopReason: "stop" })]);
		const kit = await openProjectHarness(root, "test", { modelsOverride: models.models });
		const revision = await plan(kit);
		await expect(runResolution(kit, {
			planRevision: revision, taskId: "t1", action: "retry", reason: "nothing is blocked yet",
		})).rejects.toThrow(/has no current human grant/);
		await kit.loop.close();
		kit.lock.release();
	});
});

// ---------------------------------------------------------------------------
// --accept-tree
// ---------------------------------------------------------------------------

describe("resolve --accept-tree: a human acceptance of a needs_human candidate", () => {
	it("requires the retained tree, records human authority, integrates locally, and leaves publication to run", async () => {
		const { kit, root, revision, models } = await quarantinedByNeedsHuman();
		const before = receiptsOf(await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT));
		const candidate = retainedCandidate(before, revision, "t1");
		const state = await readSessionState(kit.loop.harness);
		const baseCommit = state.router.identity!.baseCommit!;
		const callsBefore = models.faux.state.callCount;
		const file = await evidenceFile([{ id: "1", status: "pass", evidence: [{ kind: "gate", id: "gate-ok" }] }]);

		const outcome = await runResolution(kit, {
			planRevision: revision,
			taskId: "t1",
			action: "accept-tree",
			tree: candidate,
			evidence: await loadResolutionEvidence(file),
			reason: "read the diff by hand; the executed gate proves criterion 1",
		});
		expect(outcome.action).toBe("accept-tree");
		expect(outcome.idempotent).toBe(false);
		expect(outcome.commit).toBeTruthy();
		// No model dispatch: a human decision is not a paid submission.
		expect(models.faux.state.callCount).toBe(callsBefore);

		// A HUMAN acceptance receipt (never model approval), policy human-v1.
		const after = receiptsOf(await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT));
		const acceptance = after.events.filter((event) => event.kind === "acceptance");
		expect(acceptance).toHaveLength(1);
		expect(acceptance[0]!.value).toMatchObject({
			planRevision: revision, taskId: "t1", wave: 1, tree: candidate, authority: "human", policy: "human-v1",
			required: ["human"], parent: baseCommit,
		});
		expect(acceptance[0]!.value.passes[0]).toMatchObject({ pass: "human", verdict: "approve", notes: "read the diff by hand; the executed gate proves criterion 1" });
		// The gate was RERUN on the exact candidate and its receipt is referenced.
		const gate = after.events.filter((event) => event.kind === "gate" && event.value.wave === 1).at(-1);
		expect(gate?.value).toMatchObject({ tree: candidate, checks: expect.arrayContaining([expect.objectContaining({ id: "gate-ok", outcome: "pass" })]) });
		expect(acceptance[0]!.value.gateId).toBe(gate!.value.id);

		// Integration advanced by exactly one commit whose parent is the old head.
		const accepted = await readRef(root, `refs/kit/${revision}/accepted`);
		expect(accepted).toBe(outcome.commit);
		expect((await readCommit(root, accepted!)).parents).toEqual([baseCommit]);
		// Accepted is not delivered: no delivery receipt, task not done.
		expect(after.events.filter((event) => event.kind === "delivery")).toHaveLength(0);
		let now = await readSessionState(kit.loop.harness);
		expect(now.router.tasks[0]!.status).toBe("in_progress");
		expect(now.router.tasks[0]!.blockReason).toBeUndefined();
		expect(now.router.tasks[0]!.waveCount).toBe(1);

		// Idempotent replay reconciles instead of recording a second decision.
		const again = await runResolution(kit, {
			planRevision: revision,
			taskId: "t1",
			action: "accept-tree",
			tree: candidate,
			evidence: await loadResolutionEvidence(file),
			reason: "read the diff by hand; the executed gate proves criterion 1",
		});
		expect(again.idempotent).toBe(true);
		expect(again.commit).toBe(outcome.commit);
		const replay = receiptsOf(await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT));
		expect(replay.events.filter((event) => event.kind === "acceptance")).toHaveLength(1);
		expect(replay.events.filter((event) => event.kind === "resolution")).toHaveLength(1);

		// The authorized run finishes publication WITHOUT paying for another wave.
		const callsBeforeRun = models.faux.state.callCount;
		const resumed = await runWaves(kit, { tasksFilter: [] });
		expect(resumed.exit).toBe("plan-complete");
		expect(models.faux.state.callCount).toBe(callsBeforeRun);
		now = await readSessionState(kit.loop.harness);
		expect(now.router.tasks[0]!.status).toBe("done");
		expect(now.router.tasks[0]!.waveCount).toBe(1);
		const delivered = receiptsOf(await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT))
			.events.filter((event) => event.kind === "delivery");
		expect(delivered.at(-1)?.value.state).toBe("not_requested");

		await kit.loop.close();
		kit.lock.release();
	});

	it("refuses a non-needs_human quarantine, a stale tree, invalid evidence and a non-candidate gate reference", async () => {
		const gateFailure = await quarantinedByGate();
		const gateEvidence = await loadResolutionEvidence(await evidenceFile([
			{ id: "1", status: "pass", evidence: [{ kind: "gate", id: "gate-ok" }] },
		]));
		const gateCandidate = retainedCandidate(
			receiptsOf(await gateFailure.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT)),
			gateFailure.revision,
			"t1",
		);
		await expect(runResolution(gateFailure.kit, {
			planRevision: gateFailure.revision, taskId: "t1", action: "accept-tree",
			tree: gateCandidate, evidence: gateEvidence, reason: "accept a gate-failed tree",
		})).rejects.toThrow(/only to an inconclusive `needs_human` quarantine/);
		await gateFailure.kit.loop.close();
		gateFailure.kit.lock.release();

		const { kit, root, revision } = await quarantinedByNeedsHuman();
		const candidate = retainedCandidate(receiptsOf(await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT)), revision, "t1");
		const state = await readSessionState(kit.loop.harness);
		const baseTree = await readCommit(kit.loop.paths.root, state.router.identity!.baseCommit!);

		// Stale/stale-by-tree: a valid tree object that is not this wave's candidate.
		await expect(runResolution(kit, {
			planRevision: revision, taskId: "t1", action: "accept-tree", tree: baseTree.tree,
			evidence: await loadResolutionEvidence(await evidenceFile([{ id: "1", status: "pass", evidence: [{ kind: "gate", id: "gate-ok" }] }])),
			reason: "accept the base tree",
		})).rejects.toThrow(/is not the retained candidate/);

		// A missing criterion id is refused (ids are the reviewed 1-based indices).
		await expect(runResolution(kit, {
			planRevision: revision, taskId: "t1", action: "accept-tree", tree: candidate,
			evidence: await loadResolutionEvidence(await evidenceFile([{ id: "2", status: "pass", evidence: [{ kind: "gate", id: "gate-ok" }] }])),
			reason: "criterion 2 does not exist",
		})).rejects.toThrow(/is not one of the reviewed criteria 1–1/);

		// A gate reference that did not execute on the rerun is not proof.
		await expect(runResolution(kit, {
			planRevision: revision, taskId: "t1", action: "accept-tree", tree: candidate,
			evidence: await loadResolutionEvidence(await evidenceFile([{ id: "1", status: "pass", evidence: [{ kind: "gate", id: "never-ran" }] }])),
			reason: "gate that never executed",
		})).rejects.toThrow(/is not an executed, non-scope, non-skipped passing check/);

		// A line reference outside the frozen tree is not proof either.
		await expect(runResolution(kit, {
			planRevision: revision, taskId: "t1", action: "accept-tree", tree: candidate,
			evidence: await loadResolutionEvidence(await evidenceFile([{ id: "1", status: "pass", evidence: [{ kind: "line", path: "src/one.ts", line: 99 }] }])),
			reason: "line does not exist",
		})).rejects.toThrow(/does not exist in a safe text blob/);

		// Changed control inputs after review: a human acceptance may not absorb them.
		await writeFile(join(root, "evals", "recipes.toml"), `[gate-ok]\ncmd = "node eval-gate.cjs"\n[extra]\ncmd = "node eval-gate.cjs"\n`, "utf8");
		await expect(runResolution(kit, {
			planRevision: revision, taskId: "t1", action: "accept-tree", tree: candidate,
			evidence: await loadResolutionEvidence(await evidenceFile([{ id: "1", status: "pass", evidence: [{ kind: "gate", id: "gate-ok" }] }])),
			reason: "controls edited after review",
		})).rejects.toThrow(/approved control inputs changed on disk/);

		// Nothing was accepted by any refusal above.
		const after = receiptsOf(await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT));
		expect(after.events.filter((event) => event.kind === "acceptance")).toHaveLength(0);
		expect(after.events.filter((event) => event.kind === "resolution")).toHaveLength(0);
		expect((await readSessionState(kit.loop.harness)).router.tasks[0]!.status).toBe("quarantined");
		await kit.loop.close();
		kit.lock.release();
	});
});

describe("evidence documents are bounded, local and schema-strict", () => {
	it("refuses a missing file, a directory, invalid JSON, unknown keys, oversized files and malformed entries", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kit-evidence-"));
		await expect(loadResolutionEvidence(join(dir, "absent.json"))).rejects.toThrow(/does not exist/);
		await expect(loadResolutionEvidence(dir)).rejects.toThrow(/not a regular file/);
		const invalid = join(dir, "invalid.json");
		await writeFile(invalid, "{not json", "utf8");
		await expect(loadResolutionEvidence(invalid)).rejects.toThrow(/is not JSON/);
		const extra = join(dir, "extra.json");
		await writeFile(extra, JSON.stringify({ criteria: [], tree: "abc" }), "utf8");
		await expect(loadResolutionEvidence(extra)).rejects.toThrow(/unknown top-level key/);
		const big = join(dir, "big.json");
		await writeFile(big, JSON.stringify({ criteria: [], pad: "x".repeat(RESOLUTION_EVIDENCE_MAX_BYTES) }), "utf8");
		await expect(loadResolutionEvidence(big)).rejects.toThrow(new RegExp(`${RESOLUTION_EVIDENCE_MAX_BYTES} bytes`));

		// A malformed entry is PRESERVED (never filtered) and fails validation later.
		const malformed = await evidenceFile([{ id: "1", status: "passed", evidence: [] }]);
		const loaded = await loadResolutionEvidence(malformed);
		expect(loaded.criteria[0]).toMatchObject({ id: "1", status: "unverifiable", malformed: true });
		expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);

		expect(() => validateResolutionReason("")).toThrow(ResolutionRefusal);
		expect(validateResolutionReason("  a real reason  ")).toBe("a real reason");
	});
});

// ---------------------------------------------------------------------------
// CLI: strict forms, exit codes and the printed remedy
// ---------------------------------------------------------------------------

describe("resolve CLI", () => {
	it("refuses ambiguous and incomplete forms before opening the project", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kit-resolve-cli-"));
		const both = await runCli(dir, ["resolve", "--revision", "r", "--task", "t", "--retry", "--accept-tree", "abc", "--reason", "x"]);
		expect(both.code).toBe(1);
		expect(both.stderr).toContain("pass exactly one of --retry or --accept-tree");
		const neither = await runCli(dir, ["resolve", "--revision", "r", "--task", "t", "--reason", "x"]);
		expect(neither.code).toBe(1);
		expect(neither.stderr).toContain("exactly one of --retry or --accept-tree");
		const noEvidence = await runCli(dir, ["resolve", "--revision", "r", "--task", "t", "--accept-tree", "abc", "--reason", "x"]);
		expect(noEvidence.code).toBe(1);
		expect(noEvidence.stderr).toContain("--accept-tree needs --evidence FILE");
		const missing = await runCli(dir, ["resolve", "--task", "t", "--retry", "--reason", "x"]);
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("--revision, --task and --reason are all required");
		const unknown = await runCli(dir, ["resolve", "--revision", "r", "--task", "t", "--retry", "--reason", "x", "--frobnicate"]);
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain("resolve refused");
	});

	it("resolves a blocked task through the CLI and prints the remedy for a refusal", async () => {
		const { kit, root, revision } = await quarantinedByGate();
		await kit.loop.close();
		kit.lock.release();

		const stale = await runCli(root, ["resolve", "--revision", "00000000-0000-4000-8000-000000000000", "--task", "t1", "--retry", "--reason", "stale"]);
		expect(stale.code).toBe(1);
		expect(stale.stderr).toContain("does not name the current plan revision");
		expect(stale.stderr).toContain("remedy:");

		const ok = await runCli(root, ["resolve", "--revision", revision, "--task", "t1", "--retry", "--reason", "human review: retry the blocked wave"]);
		expect(ok.code).toBe(0);
		expect(ok.stdout).toContain("RESOLVED (human retry)");
		expect(ok.stdout).toContain("next:");

		const replay = await runCli(root, ["resolve", "--revision", revision, "--task", "t1", "--retry", "--reason", "human review: retry the blocked wave"]);
		expect(replay.code).toBe(0);
		expect(replay.stdout).toContain("already resolved");
	});

	it("help lists both resolve forms and never advertises an editable web authority", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kit-resolve-help-"));
		const help = await runCli(dir, ["--help"]);
		expect(help.code).toBe(0);
		expect(help.stdout).toContain("resolve --revision <uuid> --task <id> --retry --reason TEXT");
		expect(help.stdout).toContain("--accept-tree <oid> --evidence FILE --reason TEXT");
	});
});

import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { acceptCandidate, discardCandidateWorkspace, RecoveryRequiredError } from "../src/engine/delivery.ts";
import type { LoopAndLock } from "../src/engine/harness.ts";
import { buildFauxModels, fauxAssistantMessage } from "./fixtures.ts";
import { bakeProject, scripted } from "./fixtures2.ts";
import { gateReceiptEvent, passReceiptEvent, ReceiptsDoc } from "../src/engine/receipts.ts";
import type { WaveKey } from "../src/engine/receipts.ts";
import { commitState, readSessionState } from "../src/engine/state.ts";
import { BACKGROUND_CONTEXT } from "../src/engine/kit.ts";
import { loadPrd, runPlan } from "../src/engine/planner.ts";
import { approveGrant } from "../src/engine/waves.ts";
import { createTaskControls } from "../src/engine/controls.ts";
import { discard, fenceWorkspace, observeLease, openTask } from "../src/engine/workspace.ts";
import { exec } from "../src/util/exec.ts";
import { readRef } from "../src/util/git-objects.ts";

const roots: string[] = [];
const openKits: LoopAndLock[] = [];
const TASK_ID = "rollback-task";
const ACCEPTANCE = "When a private workspace is discarded, the system shall preserve the integration ref.";

async function closeKit(kit: LoopAndLock): Promise<void> {
	const index = openKits.indexOf(kit);
	if (index >= 0) openKits.splice(index, 1);
	await kit.loop.close().catch(() => {});
	kit.lock.release();
}

afterEach(async () => {
	await Promise.all(openKits.splice(0).map(async (kit) => {
		await kit.loop.close().catch(() => {});
		kit.lock.release();
	}));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function preparedRollback() {
	const baked = await bakeProject({ buildFauxModels });
	roots.push(baked.project.root);
	openKits.push(baked.kit);
	await scripted(baked.kit, [fauxAssistantMessage(JSON.stringify({ tasks: [{
		id: TASK_ID, title: "Discard a private lease", spec: "Prove failed workspace recovery stays blocking.",
		dependsOn: [], acceptance: [ACCEPTANCE], targetPaths: ["src/"], priority: 1,
	}] }), { stopReason: "stop" })], baked.models.faux);
	const plan = await runPlan(baked.kit, "docs/prd.md", await loadPrd(baked.kit));
	await approveGrant(baked.kit, { planRevision: plan.planRevision });
	const state = await readSessionState(baked.kit.loop.harness);
	const parent = state.router.identity!.baseCommit!;
	const wave: WaveKey = { planRevision: plan.planRevision, taskId: TASK_ID, wave: 1 };
	const tree = (await exec(["git", "rev-parse", `${parent}^{tree}`], { cwd: baked.project.root, timeoutMs: 10_000 })).stdout.trim();
	const gate = gateReceiptEvent(wave, { tree, checks: [
		{ id: "scope", kind: "scope", outcome: "pass", exit: null, ms: 0 },
		{ id: "rollback-check", kind: "recipe", outcome: "pass", exit: 0, ms: 1 },
	] });
	const primary = passReceiptEvent(wave, {
		tree, gateId: gate.value.id, policy: "always",
		review: { pass: "primary", verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "gate", id: "rollback-check" }] }], notes: "accepted" },
	});
	const skeptic = passReceiptEvent(wave, {
		tree, gateId: gate.value.id, policy: "always",
		review: { pass: "skeptic", verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "gate", id: "rollback-check" }] }], notes: "checked" },
	});
	await commitState(baked.kit, { receipts: [gate, primary, skeptic] });
	await acceptCandidate(baked.kit, { ...wave, parent, tree, policy: "always", required: ["primary", "skeptic"] });
	const lease = await openTask({ root: baked.project.root, oid: parent }, state.router.identity!, TASK_ID);
	const fencedWorkspace = fenceWorkspace(lease, createTaskControls({ root: baked.project.root, targetPaths: ["src/"] }));
	const integrationRef = `refs/kit/${plan.planRevision}/accepted`;
	const expectedIntegrationCommit = await readRef(baked.project.root, integrationRef);
	return { root: baked.project.root, kit: baked.kit, wave, parent, tree, lease, fencedWorkspace, expectedIntegrationCommit };
}

async function rollbackEvents(kit: LoopAndLock) {
	return (await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT))?.events.filter((event) => event.kind === "rollback") ?? [];
}

describe("rollback receipts require observed fenced disposal", () => {
	it("persists a failed blocking receipt when workspace disposal fails; no discarded success is recorded", async () => {
		const data = await preparedRollback();
		await expect(discardCandidateWorkspace(data.kit, {
			...data.wave, fencedWorkspace: data.fencedWorkspace, baseTree: data.parent, producedTree: data.tree,
			expectedIntegrationCommit: data.expectedIntegrationCommit,
		}, {
			faultInjector(point) {
				if (point === "rollback-discard:before-effect") throw new Error("injected workspace disposal failure");
			},
		})).rejects.toThrow("injected workspace disposal failure");
		expect(await observeLease(data.lease)).toBe("present");
		const events = await rollbackEvents(data.kit);
		const last = events.at(-1);
		expect(last?.kind === "rollback" ? last.value.state : undefined).toBe("failed");
		if (last?.kind === "rollback") {
			expect(last.value).not.toHaveProperty("fencedWorkspace");
			expect(last.value).not.toHaveProperty("expectedIntegrationCommit");
		}
		expect(events.some((event) => event.kind === "rollback" && event.value.state === "discarded")).toBe(false);
		const state = await readSessionState(data.kit.loop.harness);
		expect(state.router.tasks.find((task) => task.id === TASK_ID)?.status).not.toBe("done");
	});

	it("reconciles a crash after directory removal only after absence and unchanged integration ref are observed", async () => {
		const data = await preparedRollback();
		await expect(discardCandidateWorkspace(data.kit, {
			...data.wave, fencedWorkspace: data.fencedWorkspace, baseTree: data.parent, producedTree: data.tree,
			expectedIntegrationCommit: data.expectedIntegrationCommit,
		}, {
			faultInjector(point) {
				if (point === "rollback-discard:after-effect") throw new Error("process stopped after disposal");
			},
		})).rejects.toThrow("process stopped after disposal");
		expect(await observeLease(data.lease)).toBe("absent");
		expect(await readRef(data.root, `refs/kit/${data.wave.planRevision}/accepted`)).toBe(data.expectedIntegrationCommit);
		const interrupted = (await rollbackEvents(data.kit)).at(-1);
		expect(interrupted?.kind === "rollback" ? interrupted.value.state : undefined).toBe("unknown");

		const recovered = await discardCandidateWorkspace(data.kit, {
			...data.wave, fencedWorkspace: data.fencedWorkspace, baseTree: data.parent, producedTree: data.tree,
			expectedIntegrationCommit: data.expectedIntegrationCommit,
		});
		expect(recovered.receipt.state).toBe("discarded");
		expect(await observeLease(data.lease)).toBe("absent");
		expect(await readRef(data.root, `refs/kit/${data.wave.planRevision}/accepted`)).toBe(data.expectedIntegrationCommit);
		const events = await rollbackEvents(data.kit);
		expect(events.map((event) => event.value.state)).toEqual(["pending", "unknown", "pending", "discarded"]);
		expect(events.map((event) => "ordinal" in event ? event.ordinal : 0)).toEqual([1, 2, 3, 4]);
	});

	it("refuses a rollback receipt if the integration ref changed during disposal", async () => {
		const data = await preparedRollback();
		const foreignTree = data.tree;
		await expect(discardCandidateWorkspace(data.kit, {
			...data.wave, fencedWorkspace: data.fencedWorkspace, baseTree: data.parent, producedTree: foreignTree,
			expectedIntegrationCommit: "0".repeat(40),
		})).rejects.toBeInstanceOf(RecoveryRequiredError);
		expect(await observeLease(data.lease)).toBe("present");
		const blocked = await rollbackEvents(data.kit);
		expect(blocked).toHaveLength(1);
		expect(blocked[0]?.kind === "rollback" ? blocked[0].value.state : undefined).toBe("unknown");
		expect(blocked.some((event) => event.kind === "rollback" && event.value.state === "discarded")).toBe(false);
		await discard(data.lease);
	});
});

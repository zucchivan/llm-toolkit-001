import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptCandidate, integrateAcceptedCandidate, publishLocalResult, RecoveryRequiredError } from "../src/engine/delivery.ts";
import type { LoopAndLock } from "../src/engine/harness.ts";
import { buildFauxModels, fauxAssistantMessage } from "./fixtures.ts";
import { bakeProject, scripted } from "./fixtures2.ts";
import { gateReceiptEvent, passReceiptEvent, receiptKey, ReceiptsDoc } from "../src/engine/receipts.ts";
import type { WaveKey } from "../src/engine/receipts.ts";
import { commitState, readSessionState } from "../src/engine/state.ts";
import { BACKGROUND_CONTEXT } from "../src/engine/kit.ts";
import { loadPrd, runPlan } from "../src/engine/planner.ts";
import { approveGrant } from "../src/engine/waves.ts";
import { exec } from "../src/util/exec.ts";
import { createCommitObject, readRef } from "../src/util/git-objects.ts";

const roots: string[] = [];
const openKits: LoopAndLock[] = [];
const TASK_ID = "journal-task";
const ACCEPTANCE = "When the journal candidate is accepted, the system shall preserve the checked tree.";

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

async function prepared(): Promise<{
	root: string;
	kit: LoopAndLock;
	wave: WaveKey;
	parent: string;
	tree: string;
}> {
	const baked = await bakeProject({ buildFauxModels });
	roots.push(baked.project.root);
	openKits.push(baked.kit);
	await scripted(baked.kit, [fauxAssistantMessage(JSON.stringify({ tasks: [{
		id: TASK_ID,
		title: "Journal acceptance",
		spec: "Accept and publish one candidate tree idempotently.",
		dependsOn: [],
		acceptance: [ACCEPTANCE],
		targetPaths: ["src/"],
		priority: 1,
	}] }), { stopReason: "stop" })], baked.models.faux);
	const plan = await runPlan(baked.kit, "docs/prd.md", await loadPrd(baked.kit));
	await approveGrant(baked.kit, { planRevision: plan.planRevision });
	const state = await readSessionState(baked.kit.loop.harness);
	const parent = state.router.identity!.baseCommit!;
	const wave: WaveKey = { planRevision: plan.planRevision, taskId: TASK_ID, wave: 1 };
	const tree = (await exec(["git", "rev-parse", `${parent}^{tree}`], { cwd: baked.project.root, timeoutMs: 10_000 })).stdout.trim();
	const gate = gateReceiptEvent(wave, {
		tree,
		checks: [
			{ id: "scope", kind: "scope", outcome: "pass", exit: null, ms: 0 },
			{ id: "journal-check", kind: "recipe", outcome: "pass", exit: 0, ms: 1 },
		],
	});
	const primary = passReceiptEvent(wave, {
		tree, gateId: gate.value.id, policy: "always",
		review: { pass: "primary", verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "gate", id: "journal-check" }] }], notes: "accepted" },
	});
	const skeptic = passReceiptEvent(wave, {
		tree, gateId: gate.value.id, policy: "always",
		review: { pass: "skeptic", verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "gate", id: "journal-check" }] }], notes: "independently checked" },
	});
	await commitState(baked.kit, { receipts: [gate, primary, skeptic] });
	await acceptCandidate(baked.kit, { ...wave, parent, tree, policy: "always", required: ["primary", "skeptic"] });
	return { root: baked.project.root, kit: baked.kit, wave, parent, tree };
}

async function reopen(root: string): Promise<LoopAndLock> {
	const kit = await import("../src/engine/harness.ts").then(({ openProjectHarness }) =>
		openProjectHarness(root, "test", { modelsOverride: buildFauxModels([]).models }),
	);
	openKits.push(kit);
	return kit;
}

async function ref(root: string, revision: string): Promise<string | undefined> {
	return readRef(root, `refs/kit/${revision}/accepted`);
}

async function receiptEvents(kit: LoopAndLock) {
	return (await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT))?.events ?? [];
}

describe("integration journal and local publication", () => {
	it("recovers an intent committed before CAS using the exact pinned commit", async () => {
		const data = await prepared();
		const initial = await ref(data.root, data.wave.planRevision);
		const receiptDoc = await data.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		const acceptanceKey = receiptKey({ ...data.wave, stage: "acceptance" });
		const acceptancePointer = receiptDoc?.latest?.[acceptanceKey];
		expect(acceptancePointer?.ordinal).toBe(1);
		expect(receiptDoc?.events.find((event) => event.opId === acceptancePointer?.opId)?.kind).toBe("acceptance");
		let recordedCommit: string | undefined;
		await expect(integrateAcceptedCandidate(data.kit, data.wave, {
			faultInjector(point) {
				if (point === "integration-intent:after-commit") throw new Error("simulated process stop after intent");
			},
		})).rejects.toThrow("simulated process stop");
		const pending = (await receiptEvents(data.kit)).filter((event) => event.kind === "integrate").at(-1);
		expect(pending?.kind).toBe("integrate");
		if (!pending || pending.kind !== "integrate") throw new Error("missing integration intent");
		recordedCommit = pending.value.commit;
		expect(await ref(data.root, data.wave.planRevision)).toBe(initial);
		await closeKit(data.kit);

		const reopened = await reopen(data.root);
		const completed = await integrateAcceptedCandidate(reopened, data.wave);
		expect(completed.receipt.state).toBe("integrated");
		expect(completed.receipt.commit).toBe(recordedCommit);
		expect(await ref(data.root, data.wave.planRevision)).toBe(recordedCommit);
		const repeatedAcceptance = await acceptCandidate(reopened, {
			...data.wave, parent: data.parent, tree: data.tree, policy: "always", required: ["primary", "skeptic"],
		});
		expect(repeatedAcceptance.event.opId).toBe(acceptancePointer?.opId);
		const journal = await receiptEvents(reopened);
		const keyed = journal.filter((event) => event.kind === "integrate" && event.key.endsWith("/integrate"));
		expect(keyed.map((event) => "ordinal" in event ? event.ordinal : 0)).toEqual([1, 2, 3]);
	});

	it("observes a post-CAS interruption and retries without creating or publishing a second commit", async () => {
		const data = await prepared();
		let casCount = 0;
		await expect(integrateAcceptedCandidate(data.kit, data.wave, {
			faultInjector(point) {
				if (point === "integration-cas:before-effect") casCount += 1;
				if (point === "integration-cas:after-effect") throw new Error("lost CAS acknowledgment");
			},
		})).rejects.toThrow("lost CAS acknowledgment");
		const afterCas = await ref(data.root, data.wave.planRevision);
		expect(afterCas).toMatch(/^[0-9a-f]{40}$/);
		await closeKit(data.kit);

		const reopened = await reopen(data.root);
		let retryCasCount = 0;
		const result = await integrateAcceptedCandidate(reopened, data.wave, {
			faultInjector(point) { if (point === "integration-cas:before-effect") retryCasCount += 1; },
		});
		expect(result.receipt).toMatchObject({ state: "integrated", commit: afterCas });
		expect(retryCasCount).toBe(0); // the accepted ref already reads back as the recorded commit
		expect(casCount).toBe(1);
		const integrationRefs = await exec(["git", "for-each-ref", "--format=%(refname)", `refs/kit/${data.wave.planRevision}/integration-objects`], { cwd: data.root, timeoutMs: 10_000 });
		expect(integrationRefs.stdout.trim().split("\n")).toHaveLength(1);
	});

	it("stops recovery when accepted-ref CAS conflicts with neither parent nor recorded commit", async () => {
		const data = await prepared();
		const foreign = await createCommitObject(data.root, data.tree, data.parent, "foreign accepted-ref movement");
		await expect(integrateAcceptedCandidate(data.kit, data.wave, {
			async faultInjector(point) {
				if (point !== "integration-cas:before-effect") return;
				const pending = (await receiptEvents(data.kit)).filter((event) => event.kind === "integrate").at(-1);
				if (!pending || pending.kind !== "integrate") throw new Error("expected pending integration intent");
				// Move the private integration ref to an unrelated existing commit between read and CAS.
				const { compareAndSwapRef } = await import("../src/util/git-objects.ts");
				await compareAndSwapRef(data.root, `refs/kit/${data.wave.planRevision}/accepted`, foreign, data.parent);
			},
		})).rejects.toBeInstanceOf(RecoveryRequiredError);
		const events = await receiptEvents(data.kit);
		const latest = events.filter((event) => event.kind === "integrate").at(-1);
		expect(latest?.kind === "integrate" ? latest.value : undefined).toMatchObject({ state: "unknown", code: "recovery-required" });
		await expect(integrateAcceptedCandidate(data.kit, data.wave)).rejects.toBeInstanceOf(RecoveryRequiredError);
	});

	it("recovers local branch publication after CAS and does not repeat the branch update", async () => {
		const data = await prepared();
		const integrated = await integrateAcceptedCandidate(data.kit, data.wave);
		let beforeCas = 0;
		await expect(publishLocalResult(data.kit, data.wave, "commit", {
			faultInjector(point) {
				if (point === "delivery-cas:before-effect") beforeCas += 1;
				if (point === "delivery-cas:after-effect") throw new Error("lost branch CAS acknowledgment");
			},
		})).rejects.toThrow("lost branch CAS");
		const branch = `refs/heads/kit/${data.wave.planRevision}/result`;
		expect(await readRef(data.root, branch)).toBe(integrated.receipt.commit);
		await closeKit(data.kit);

		const reopened = await reopen(data.root);
		let retryCas = 0;
		const published = await publishLocalResult(reopened, data.wave, "commit", {
			faultInjector(point) { if (point === "delivery-cas:before-effect") retryCas += 1; },
		});
		expect(published.receipt).toMatchObject({ state: "published", ref: branch, commit: integrated.receipt.commit });
		expect(retryCas).toBe(0);
	});

	it("does not treat a failed publication receipt commit as success; replay observes the branch before acknowledging", async () => {
		const data = await prepared();
		await integrateAcceptedCandidate(data.kit, data.wave);
		await expect(publishLocalResult(data.kit, data.wave, "commit", {
			faultInjector(point) {
				if (point === "delivery-result:before-commit") throw new Error("effect receipt store unavailable");
			},
		})).rejects.toThrow("effect receipt store unavailable");
		const events = (await receiptEvents(data.kit)).filter((event) => event.kind === "delivery");
		expect(events.at(-1)?.kind === "delivery" ? events.at(-1)!.value.state : undefined).toBe("pending");
		const branch = `refs/heads/kit/${data.wave.planRevision}/result`;
		const publishedCommit = await readRef(data.root, branch);
		expect(publishedCommit).toMatch(/^[0-9a-f]{40}$/);
		const replay = await publishLocalResult(data.kit, data.wave, "commit");
		expect(replay.receipt).toMatchObject({ state: "published", commit: publishedCommit, ref: branch });
		expect((await receiptEvents(data.kit)).filter((event) => event.kind === "delivery").map((event) => event.value.state))
			.toEqual(["pending", "pending", "published"]);
	});

	it("none mode acknowledges the private result without changing branches, HEAD, or index", async () => {
		const data = await prepared();
		await integrateAcceptedCandidate(data.kit, data.wave);
		const headBefore = (await exec(["git", "rev-parse", "HEAD"], { cwd: data.root, timeoutMs: 10_000 })).stdout.trim();
		const indexBefore = (await exec(["git", "write-tree"], { cwd: data.root, timeoutMs: 10_000 })).stdout.trim();
		const branchesBefore = (await exec(["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], { cwd: data.root, timeoutMs: 10_000 })).stdout;
		const result = await publishLocalResult(data.kit, data.wave, "none");
		expect(result.receipt.state).toBe("not_requested");
		expect((await exec(["git", "rev-parse", "HEAD"], { cwd: data.root, timeoutMs: 10_000 })).stdout.trim()).toBe(headBefore);
		expect((await exec(["git", "write-tree"], { cwd: data.root, timeoutMs: 10_000 })).stdout.trim()).toBe(indexBefore);
		expect((await exec(["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], { cwd: data.root, timeoutMs: 10_000 })).stdout).toBe(branchesBefore);
		expect(await readRef(data.root, `refs/heads/kit/${data.wave.planRevision}/result`)).toBeUndefined();
	});
});

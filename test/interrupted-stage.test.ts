import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectHarness, type LoopAndLock } from "../src/engine/harness.ts";
import { runWaves } from "../src/engine/waves.ts";
import { BACKGROUND_CONTEXT } from "../src/engine/kit.ts";
import { ReceiptsDoc } from "../src/engine/receipts.ts";
import { readSessionState } from "../src/engine/state.ts";
import { compareAndSwapRef, readCommit, readRef } from "../src/util/git-objects.ts";
import { exec } from "../src/util/exec.ts";
import { readJson } from "../src/util/fsx.ts";
import { conversationEntries, readout } from "../src/engine/inspector.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { accomplish, bakeProject, reopenProject, scripted } from "./fixtures2.ts";
import { demoConfigToml } from "./demo-project.ts";
import { runCli } from "./plan-revision-helpers.ts";
import { writeGateFile } from "./helpers2.ts";

const roots: string[] = [];
const openKits: LoopAndLock[] = [];
const TASK = {
	tasks: [{
		id: "resume-task",
		title: "Resume after reviewed candidate",
		spec: "Write src/accepted.ts and review its frozen candidate.",
		dependsOn: [],
		acceptance: ["When src/accepted.ts exists, it shall export the accepted marker."],
		targetPaths: ["src/accepted.ts"],
		priority: 1,
	}],
};

const DEPENDENT_TASKS = { tasks: [
	{ id: "task-a", title: "A", spec: "Write src/a.ts", dependsOn: [], acceptance: ["A exists"], targetPaths: ["src/"], priority: 2 },
	{ id: "task-b", title: "B", spec: "Depends on A", dependsOn: ["task-a"], acceptance: ["B exists"], targetPaths: ["src/"], priority: 1 },
] };

async function closeKit(kit: LoopAndLock): Promise<void> {
	const index = openKits.indexOf(kit);
	if (index >= 0) openKits.splice(index, 1);
	await kit.loop.close().catch(() => {});
	kit.lock.release();
}

afterEach(async () => {
	await Promise.all(openKits.splice(0).map(closeKit));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const pass = (notes: string) => fauxAssistantMessage(JSON.stringify({
	verdict: "approve",
	criteria: [{ id: "1", status: "pass", evidence: [{ kind: "line", path: "src/accepted.ts", line: 1 }] }],
	notes,
}), { stopReason: "stop" });

describe("interrupted stage reconciliation", () => {
	it("resumes after the committed primary receipt without dispatching primary again", async () => {
		const baked = await bakeProject({ buildFauxModels });
		roots.push(baked.project.root);
		openKits.push(baked.kit);
		await scripted(baked.kit, [
			fauxAssistantMessage(JSON.stringify(TASK), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/accepted.ts", content: "export const accepted = true;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			pass("primary reviewed the frozen candidate"),
			pass("skeptic independently reviewed the frozen candidate"),
		], baked.models.faux);
		const revision = await accomplish(baked.kit);
		const usageBefore = await baked.kit.loop.sessionUsage();

		await expect(runWaves(baked.kit, {
			driverFaultInjector(point) {
				if (point === "after-primary") throw new Error("stop after primary receipt commit");
			},
		})).rejects.toThrow("stop after primary receipt commit");
		const afterPrimary = await baked.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		expect(afterPrimary?.events.filter((event) => event.kind === "pass")).toHaveLength(1);
		expect(afterPrimary?.events.filter((event) => event.kind === "checkpoint" && event.value.stage === "primary").at(-1)).toMatchObject({
			kind: "checkpoint", value: { state: "complete", outcome: "approve", submissionKey: `kit:${revision}:resume-task:w1:primary` },
		});

		const resumed = await runWaves(baked.kit, { tasksFilter: [] });
		expect(resumed).toMatchObject({ exit: "plan-complete", complete: true });
		const afterResume = await baked.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		expect(afterResume?.events.filter((event) => event.kind === "pass").map((event) => event.kind === "pass" && event.value.review.pass)).toEqual(["primary", "skeptic"]);
		expect((await baked.kit.loop.sessionUsage()).tokens - usageBefore.tokens).toBeGreaterThan(0);
		expect(baked.models.faux.getPendingResponseCount()).toBe(0);
	});

	it("refuses a reopened resumed model stage when reviewed controls drifted (M1-P01 step d)", async () => {
		const baked = await bakeProject({ buildFauxModels });
		roots.push(baked.project.root);
		openKits.push(baked.kit);
		await scripted(baked.kit, [
			fauxAssistantMessage(JSON.stringify(TASK), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/accepted.ts", content: "export const accepted = true;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			pass("primary reviewed the frozen candidate"),
			pass("skeptic independently reviewed the frozen candidate"),
		], baked.models.faux);
		await accomplish(baked.kit);
		await expect(runWaves(baked.kit, {
			driverFaultInjector(point) {
				if (point === "after-primary") throw new Error("stop after primary receipt commit");
			},
		})).rejects.toThrow("stop after primary receipt commit");
		const beforeReopen = await baked.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		expect(beforeReopen?.events.filter((event) => event.kind === "pass")).toHaveLength(1);

		// Reopen after the crash and drift a committed control. The resumed
		// PRIMARY checkpoint is model work: runWaves must refuse before dispatching
		// the skeptic (or rerunning primary) and must leave receipts untouched.
		const reopened = await reopenProject(baked);
		const closedIndex = openKits.indexOf(baked.kit);
		if (closedIndex >= 0) openKits.splice(closedIndex, 1);
		openKits.push(reopened.kit);
		await writeFile(join(reopened.project.root, "evals", "checklist.md"), "TAMPERED REVIEW CHECKS\n", "utf8");
		await expect(runWaves(reopened.kit, { tasksFilter: [] })).rejects.toThrow(/reviewed controls changed/);
		expect(reopened.models.faux.state.callCount).toBe(0);
		const after = await reopened.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		expect(after?.events.filter((event) => event.kind === "pass")).toHaveLength(1);
		const state = await readSessionState(reopened.kit.loop.harness);
		expect(state.router.tasks[0]).toMatchObject({ status: "in_progress", waveCount: 1 });
		const latest = after?.events.filter((event) => event.kind === "checkpoint" && event.value.taskId === "resume-task").at(-1);
		expect(latest).toMatchObject({ kind: "checkpoint", value: { stage: "primary", state: "complete" } });
	});

	it("resumes the receipted candidate after review without re-running implementation or verification", async () => {
		const config = demoConfigToml().replace('mode = "none"', 'mode = "commit"');
		const baked = await bakeProject({ buildFauxModels, configToml: config });
		roots.push(baked.project.root);
		openKits.push(baked.kit);
		await scripted(baked.kit, [
			fauxAssistantMessage(JSON.stringify(TASK), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/accepted.ts", content: "export const accepted = true;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			pass("primary reviewed the frozen candidate"),
			pass("skeptic independently reviewed the frozen candidate"),
		], baked.models.faux);
		const revision = await accomplish(baked.kit);
		const operatorHead = (await exec(["git", "rev-parse", "HEAD"], { cwd: baked.project.root, timeoutMs: 10_000 })).stdout.trim();
		const operatorIndex = (await exec(["git", "write-tree"], { cwd: baked.project.root, timeoutMs: 10_000 })).stdout.trim();

		await expect(runWaves(baked.kit, {
			driverFaultInjector(point) {
				if (point === "after-review-before-delivery") throw new Error("simulated process interruption after review");
			},
		})).rejects.toThrow("simulated process interruption");

		const afterReview = await readSessionState(baked.kit.loop.harness);
		expect(afterReview.router.tasks[0]).toMatchObject({ status: "in_progress", waveCount: 1 });
		const status = await readJson<{
			planRevision?: string;
			receiptStates?: { taskId: string; wave: number; primary?: string; skeptic?: string };
			checkpoint?: { wave: number; baseTree: string; candidateTree: string; asOf: number };
		}>(join(baked.project.root, ".orch", "status.json"));
		expect(status).toMatchObject({
			planRevision: revision,
			receiptStates: { taskId: "resume-task", wave: 1, primary: "approve", skeptic: "approve" },
			checkpoint: { wave: 1, baseTree: expect.any(String), candidateTree: expect.any(String), asOf: expect.any(Number) },
		});
		const receiptsBefore = await baked.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		const passCountBefore = receiptsBefore?.events.filter((event) => event.kind === "pass").length;
		expect(passCountBefore).toBe(2);
		const usageBefore = await baked.kit.loop.sessionUsage();
		await closeKit(baked.kit);

		// A fresh faux provider has no queued responses. Any implementation or
		// verifier replay would therefore fail rather than silently pass this test.
		const emptyModels = buildFauxModels([]);
		const reopened = await openProjectHarness(baked.project.root, "resume-test", { modelsOverride: emptyModels.models });
		openKits.push(reopened);
		const summary = await runWaves(reopened, { tasksFilter: [] });
		expect(summary).toMatchObject({ exit: "plan-complete", complete: true, grant: { planRevision: revision } });

		const state = await readSessionState(reopened.loop.harness);
		expect(state.router.tasks[0]).toMatchObject({ status: "done", waveCount: 1 });
		const receiptsAfter = await reopened.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		expect(receiptsAfter?.events.filter((event) => event.kind === "pass")).toHaveLength(passCountBefore);
		expect(receiptsAfter?.events.filter((event) => event.kind === "gate")).toHaveLength(1);
		expect(receiptsAfter?.events.filter((event) => event.kind === "acceptance")).toHaveLength(1);
		expect(receiptsAfter?.events.filter((event) => event.kind === "integrate" && event.value.state === "integrated")).toHaveLength(1);
		expect(receiptsAfter?.events.filter((event) => event.kind === "delivery" && event.value.state === "published")).toHaveLength(1);
		expect((await reopened.loop.sessionUsage()).tokens).toBe(usageBefore.tokens);
		expect(emptyModels.faux.getPendingResponseCount()).toBe(0);
		const resultRef = `refs/heads/kit/${revision}/result`;
		expect(await readRef(baked.project.root, resultRef)).toMatch(/^[0-9a-f]{40}$/);
		expect(await readFile(join(baked.project.root, "src", "accepted.ts"), "utf8").catch(() => "<absent>")).toBe("<absent>");
		expect((await exec(["git", "rev-parse", "HEAD"], { cwd: baked.project.root, timeoutMs: 10_000 })).stdout.trim()).toBe(operatorHead);
		expect((await exec(["git", "write-tree"], { cwd: baked.project.root, timeoutMs: 10_000 })).stdout.trim()).toBe(operatorIndex);
	});

	it("does not mark a task done when a confirmed local result ref later moves", async () => {
		const config = demoConfigToml().replace('mode = "none"', 'mode = "commit"');
		const baked = await bakeProject({ buildFauxModels, configToml: config });
		roots.push(baked.project.root);
		openKits.push(baked.kit);
		await scripted(baked.kit, [
			fauxAssistantMessage(JSON.stringify(TASK), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/accepted.ts", content: "export const accepted = true;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			pass("primary reviewed the frozen candidate"),
			pass("skeptic independently reviewed the frozen candidate"),
		], baked.models.faux);
		const revision = await accomplish(baked.kit);
		await expect(runWaves(baked.kit, {
			driverFaultInjector(point) {
				if (point === "after-publication") throw new Error("stop after confirmed publication");
			},
		})).rejects.toThrow("stop after confirmed publication");

		const resultRef = `refs/heads/kit/${revision}/result`;
		const published = await readRef(baked.project.root, resultRef);
		expect(published).toMatch(/^[0-9a-f]{40}$/);
		const parent = (await readCommit(baked.project.root, published!)).parents[0]!;
		await compareAndSwapRef(baked.project.root, resultRef, parent, published!);

		const resumed = await runWaves(baked.kit, { tasksFilter: [] });
		expect(resumed.exit).toBe("recovery-required");
		expect(resumed.blockedIds).toEqual(["resume-task"]);
		const state = await readSessionState(baked.kit.loop.harness);
		expect(state.router.tasks[0]?.status).toBe("in_progress");
		expect(state.rows.some((row) => row.kind === "task" && row.task === "resume-task" && row.verb === "done")).toBe(false);
		const receipts = await baked.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		expect(receipts?.events.filter((event) => event.kind === "delivery").at(-1)).toMatchObject({
			kind: "delivery", value: { state: "unknown", code: "result-ref-conflict" },
		});
	});

	it("does not reuse an integrated receipt when the accepted ref later moves", async () => {
		const baked = await bakeProject({ buildFauxModels, configToml: demoConfigToml() });
		roots.push(baked.project.root);
		openKits.push(baked.kit);
		await scripted(baked.kit, [
			fauxAssistantMessage(JSON.stringify(TASK), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/accepted.ts", content: "export const accepted = true;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			pass("primary reviewed the frozen candidate"),
			pass("skeptic independently reviewed the frozen candidate"),
		], baked.models.faux);
		const revision = await accomplish(baked.kit);
		await expect(runWaves(baked.kit, {
			driverFaultInjector(point) {
				if (point === "after-publication") throw new Error("stop after confirmed no-publication receipt");
			},
		})).rejects.toThrow("stop after confirmed no-publication receipt");

		const acceptedRef = `refs/kit/${revision}/accepted`;
		const integrated = await readRef(baked.project.root, acceptedRef);
		expect(integrated).toMatch(/^[0-9a-f]{40}$/);
		const parent = (await readCommit(baked.project.root, integrated!)).parents[0]!;
		await compareAndSwapRef(baked.project.root, acceptedRef, parent, integrated!);

		const resumed = await runWaves(baked.kit, { tasksFilter: [] });
		expect(resumed.exit).toBe("recovery-required");
		const state = await readSessionState(baked.kit.loop.harness);
		expect(state.router.tasks[0]?.status).toBe("in_progress");
		const receipts = await baked.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		expect(receipts?.events.filter((event) => event.kind === "integrate").at(-1)).toMatchObject({
			kind: "integrate", value: { state: "unknown", code: "accepted-ref-conflict" },
		});
	});

	it("one-off verify reads the latest frozen candidate, not conflicting operator bytes", async () => {
		const baked = await bakeProject({ buildFauxModels });
		roots.push(baked.project.root);
		openKits.push(baked.kit);
		await scripted(baked.kit, [
			fauxAssistantMessage(JSON.stringify(TASK), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/accepted.ts", content: "export const accepted = true;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			pass("primary reviewed the frozen candidate"),
			pass("skeptic independently reviewed the frozen candidate"),
		], baked.models.faux);
		await accomplish(baked.kit);
		await runWaves(baked.kit, {});
		await closeKit(baked.kit);

		await writeFile(join(baked.project.root, "src", "accepted.ts"), "export const accepted = false; // OPERATOR DECOY\n", "utf8");
		const replayDir = await mkdtemp(join(tmpdir(), "kit-verify-replay-"));
		roots.push(replayDir);
		const replay = join(replayDir, "verify.replay");
		const approval = JSON.stringify({
			verdict: "approve",
			criteria: [{ id: "1", status: "pass", evidence: [{ kind: "line", path: "src/accepted.ts", line: 1 }] }],
			notes: "the candidate line is present",
		});
		await writeFile(replay, [
			"[planner]", "[implementer]", "[verifier]",
			JSON.stringify({ tool: "read", path: "src/accepted.ts" }), "---", approval,
			"---", JSON.stringify({ tool: "read", path: "src/accepted.ts" }), "---", approval,
		].join("\n"), "utf8");
		const result = await runCli(baked.project.root, ["verify", "--task", "resume-task"], replay);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('"verdict": "approve"');

		const observer = await openProjectHarness(baked.project.root, "verify-inspect", { readView: true });
		openKits.push(observer);
		const read = await readout(observer.loop.paths, { loop: observer });
		const diagnosticConversations = read.storage?.conversations.filter((conversation) => conversation.role === "verifier" && conversation.toolRounds > 0) ?? [];
		expect(diagnosticConversations).toHaveLength(2);
		for (const conversation of diagnosticConversations) {
			const transcript = await conversationEntries(observer, conversation.id);
			expect(transcript?.entries.some((entry) => entry.kind === "pi.tool-result" && entry.text.includes("export const accepted = true;") && !entry.text.includes("OPERATOR DECOY"))).toBe(true);
		}
		const finalState = await readSessionState(observer.loop.harness);
		expect(finalState.router.tasks[0]?.status).toBe("done");
	});

	it("one-off verify refuses control/policy drift before any paid submission (M1-P01 step d)", async () => {
		const baked = await bakeProject({ buildFauxModels });
		roots.push(baked.project.root);
		openKits.push(baked.kit);
		await scripted(baked.kit, [
			fauxAssistantMessage(JSON.stringify(TASK), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/accepted.ts", content: "export const accepted = true;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			pass("primary reviewed the frozen candidate"),
			pass("skeptic independently reviewed the frozen candidate"),
		], baked.models.faux);
		await accomplish(baked.kit);
		await runWaves(baked.kit, { tasksFilter: [] });
		const before = await readout(baked.kit.loop.paths, { loop: baked.kit });
		const conversationsBefore = before.storage?.conversations.length ?? 0;
		const receiptsBefore = (await baked.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT))?.events
			.filter((event) => event.kind === "pass").length ?? 0;
		await closeKit(baked.kit);

		// Change BOTH a reviewed eval byte and the effective verification policy.
		// Either alone is control drift; verify must refuse before admission.
		await writeFile(join(baked.project.root, "evals", "checklist.md"), "TAMPERED REVIEW CHECKS\n", "utf8");
		await writeFile(join(baked.project.root, ".orch", "config.toml"), demoConfigToml().replace(
			"[gates]\ntimeoutSec = 30",
			"[gates]\ntimeoutSec = 30\nskepticSecondPass = true",
		), "utf8");
		const replay = join(baked.project.root, "verify.replay");
		await writeFile(replay, "", "utf8");
		const result = await runCli(baked.project.root, ["verify", "--task", "resume-task"], replay);
		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(/reviewed controls changed/);
		expect(result.stderr).toMatch(/replan/);
		expect(result.stdout).not.toContain('"verdict"');

		const observer = await openProjectHarness(baked.project.root, "verify-inspect", { readView: true });
		openKits.push(observer);
		const after = await readout(observer.loop.paths, { loop: observer });
		expect(after.storage?.conversations.length ?? 0).toBe(conversationsBefore);
		const receiptsAfter = (await observer.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT))?.events
			.filter((event) => event.kind === "pass").length ?? 0;
		expect(receiptsAfter).toBe(receiptsBefore);
	});

	it("blocks task B when local publication is unknown after the branch CAS", async () => {
		const config = demoConfigToml().replace('mode = "none"', 'mode = "commit"');
		const baked = await bakeProject({ buildFauxModels, configToml: config });
		roots.push(baked.project.root);
		openKits.push(baked.kit);
		await scripted(baked.kit, [
			fauxAssistantMessage(JSON.stringify(DEPENDENT_TASKS), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/a.ts", content: "A\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "line", path: "src/a.ts", line: 1 }] }], notes: "A checked" }), { stopReason: "stop" }),
			fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "line", path: "src/a.ts", line: 1 }] }], notes: "A independently checked" }), { stopReason: "stop" }),
		], baked.models.faux);
		const revision = await accomplish(baked.kit);
		const summary = await runWaves(baked.kit, {
			prPublication: {
				faultInjector(point) {
					if (point === "delivery-cas:after-effect") throw new Error("lost local publication acknowledgment");
				},
			},
		});
		expect(summary.exit).toBe("recovery-required");
		expect(summary.blockedIds).toEqual(["task-a"]);
		const state = await readSessionState(baked.kit.loop.harness);
		expect(state.router.tasks.map((task) => task.status)).toEqual(["in_progress", "todo"]);
		expect(state.rows.some((row) => row.kind === "task" && row.verb === "done" && row.task === "task-a")).toBe(false);
		expect(state.router.tasks.find((task) => task.id === "task-b")?.convId).toBeUndefined();
		const refs = await baked.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		expect(refs?.events.some((event) => event.kind === "delivery" && event.value.taskId === "task-a" && event.value.state === "unknown")).toBe(true);
		expect(await readRef(baked.project.root, `refs/heads/kit/${revision}/result`)).toMatch(/^[0-9a-f]{40}$/);
	});

	it("replays the recorded retry before zero-progress classification after uncertain disposal", async () => {
		const config = demoConfigToml().replace('mode = "none"', 'mode = "commit"');
		const baked = await bakeProject({ buildFauxModels, retryMax: 0, configToml: config });
		roots.push(baked.project.root);
		openKits.push(baked.kit);
		await scripted(baked.kit, [
			fauxAssistantMessage(JSON.stringify(TASK), { stopReason: "stop" }),
			fauxAssistantMessage("temporary implementer outage", { stopReason: "error", errorMessage: "500 transient" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/accepted.ts", content: "export const accepted = true;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			pass("primary reviewed the frozen candidate"),
			pass("skeptic independently reviewed the frozen candidate"),
		], baked.models.faux);
		const revision = await accomplish(baked.kit);

		const interrupted = await runWaves(baked.kit, {
			prPublication: {
				faultInjector(point) {
					if (point === "rollback-discard:before-effect") throw new Error("leave retry disposal unresolved");
				},
			},
		});
		expect(interrupted.exit).toBe("recovery-required");
		const unresolved = await baked.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		expect(unresolved?.events.filter((event) => event.kind === "checkpoint" && event.value.stage === "rollback").at(-1)).toMatchObject({
			kind: "checkpoint", value: { state: "unknown", outcome: "retry", wave: 1 },
		});

		const resumed = await runWaves(baked.kit, { tasksFilter: [] });
		expect(resumed).toMatchObject({ exit: "plan-complete", complete: true });
		const state = await readSessionState(baked.kit.loop.harness);
		expect(state.router.tasks[0]).toMatchObject({ status: "done", waveCount: 2 });
		expect(state.rows.some((row) => row.kind === "governor" && row.verb === "zero-progress-quarantine" && row.wave === 1)).toBe(false);
		const receipts = await baked.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		expect(receipts?.events.filter((event) => event.kind === "checkpoint" && event.value.taskId === "resume-task" && event.value.stage === "terminal").map((event) => event.kind === "checkpoint" && [event.value.wave, event.value.outcome])).toEqual([
			[1, "retry"], [2, "accepted"],
		]);
		expect(await readRef(baked.project.root, `refs/heads/kit/${revision}/result`)).toMatch(/^[0-9a-f]{40}$/);
	});

	it("keeps a task non-done and stops dependents when owned workspace disposal is uncertain", async () => {
		const config = demoConfigToml().replace("retryLimit = 2", "retryLimit = 0");
		const baked = await bakeProject({ buildFauxModels, configToml: config });
		roots.push(baked.project.root);
		openKits.push(baked.kit);
		await writeFile(join(baked.project.root, "eval-gate.cjs"), `const fs = require("node:fs");
		const files = fs.readdirSync("src").filter((name) => name.endsWith(".ts"));
		process.exit(files.some((name) => fs.readFileSync("src/" + name, "utf8").includes("BROKEN")) ? 1 : 0);
		`, "utf8");
		await writeFile(join(baked.project.root, "evals", "recipes.toml"), `[broken]\ncmd = "node eval-gate.cjs"\n`, "utf8");
		await scripted(baked.kit, [
			fauxAssistantMessage(JSON.stringify(DEPENDENT_TASKS), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/broken.ts", content: "export const BROKEN = true;\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
		], baked.models.faux);
		await accomplish(baked.kit);

		const summary = await runWaves(baked.kit, {
			prPublication: {
				faultInjector(point) {
					if (point === "rollback-discard:before-effect") throw new Error("workspace disposal failed");
				},
			},
		});
		expect(summary.exit).toBe("recovery-required");
		expect(summary.blockedIds).toEqual(["task-a"]);
		const state = await readSessionState(baked.kit.loop.harness);
		expect(state.router.tasks.map((task) => task.status)).toEqual(["in_progress", "todo"]);
		expect(state.rows.some((row) => row.kind === "task" && row.verb === "done")).toBe(false);
		const receipts = await baked.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		expect(receipts?.events.some((event) => event.kind === "rollback" && event.value.state === "failed")).toBe(true);
		expect(receipts?.events.some((event) => event.kind === "checkpoint" && event.value.taskId === "task-a" && event.value.candidate)).toBe(true);
		expect(await readFile(join(baked.project.root, "src", "broken.ts"), "utf8").catch(() => "<absent>")).toBe("<absent>");
	});
});

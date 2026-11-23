/**
 * fake-clock tests (§7): the governor's durable sleep resumes on re-open once
 * the injected clock advances; a crash between gate and commit resumes cleanly;
 * identical requestId resubmission is idempotent.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectHarness } from "../src/engine/harness.ts";
import { readSessionState, commitState } from "../src/engine/state.ts";
import { buildFauxModels, fakeClockFor, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { writeConfig, demoConfigToml, prepareDemoProject, gitInit } from "./demo-project.ts";
import { scripted, accomplish } from "./fixtures2.ts";
import { runWaves } from "../src/engine/waves.ts";
import { initProject } from "../src/init.ts";
import { GovernorSleep } from "../src/engine/tasks.ts";
import { BACKGROUND_CONTEXT, convId } from "../src/engine/kit.ts";

async function newProject(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "kit-clock-"));
	await mkdir(join(root, ".orch"), { recursive: true });
	await mkdir(join(root, "evals"), { recursive: true });
	await writeConfig(root, demoConfigToml());
	await writeFile(join(root, "evals", "recipes.toml"), "", "utf8");
	return root;
}

describe("fake clock: pi-durable sleeps + kit governor", () => {
	beforeEach(() => {
		process.env["NO_COLOR"] = "1";
	});

	it("sleep task committed on storage wakes when the clock advances across a process restart", async () => {
		const root = await newProject();
		const clock = fakeClockFor();
		const run1 = await openProjectHarness(root, "sleep-1", { modelsOverride: buildFauxModels([]).models, now: clock.now, setTimer: clock.setTimer });

		// Open the planner-role conversation for a stable task-owner.
		const runKit = run1.loop;
		const conv = await runKit.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: { provider: "faux", modelId: "kit-planner" } },
			},
			BACKGROUND_CONTEXT,
		);

		// Arm a durable sleep 5 minutes into the future.
		const sleepUntil = clock.now() + 5 * 60_000;
		const taskId = await runKit.harness.commit(async (tx) => {
			const created = await tx.createTask(GovernorSleep, { until: sleepUntil, reason: "rate-limit-unit" }, { ownership: { kind: "conversation" }, conversationId: conv.id });
			return created as unknown as number;
		}, BACKGROUND_CONTEXT);

		// Nothing fired yet: task not terminal, still sleeping.
		const sleep1 = await runKit.harness.getTask(taskId as never, BACKGROUND_CONTEXT);
				expect(["sleeping", "pending", "running"]).toContain(sleep1?.state.status);

		await runKit.harness.close(BACKGROUND_CONTEXT);
		run1.lock.release();

		// Re-open (fresh harness, same storage) on the SAME clock+timers: the sleep wakes when due.
		const run2 = await openProjectHarness(root, "sleep-2", { modelsOverride: buildFauxModels([]).models, now: clock.now, setTimer: clock.setTimer });
		run2.loop.harness.resume();
		clock.advance(6 * 60_000); // past the deadline; timers wake the task
		const wake = await run2.loop.harness.waitForTask(taskId as never, BACKGROUND_CONTEXT);
		expect(wake.state.status).toBe("terminal");
		expect((wake.state.outcome as { status?: string }).status).toBe("completed");

		await run2.loop.close();
		run2.lock.release();
	});

	it("crash between gate and commit: reopen continues the wave from the last durable checkpoint (idempotent requestId)", async () => {
		const root = await newProject();
		const run1 = await openProjectHarness(root, "crash-1", { modelsOverride: buildFauxModels([]).models });

		const conv = await run1.loop.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: { provider: "faux", modelId: "kit-impl" } },
			},
			BACKGROUND_CONTEXT,
		);
		const submission = await conv.submit({ type: "input", content: "status", requestId: "task-unit-w1" }, BACKGROUND_CONTEXT);

		// "Crash": close WITHOUT waiting; the submission stays durably admitted.
		await run1.loop.harness.close(BACKGROUND_CONTEXT);
		run1.lock.release();

		// Reopen: same requestId reacquires the same submission (no second message).
		const run2 = await openProjectHarness(root, "crash-2", { modelsOverride: buildFauxModels([]).models });
		const conv2 = await run2.loop.harness.conversation(conv.id, BACKGROUND_CONTEXT);
		const reacquired = await conv2!.submit({ type: "input", content: "status again", requestId: "task-unit-w1" }, BACKGROUND_CONTEXT);
		expect(reacquired.id).toBe(submission.id);

		await run2.loop.close();
		run2.lock.release();
	});

	it("RunStatusDoc sleep round-trips through commitState", async () => {
		const root = await newProject();
		const kit = await openProjectHarness(root, "sleep-doc", { modelsOverride: buildFauxModels([]).models });
		await commitState(kit, {
			runStatus: (d) => {
				d.sleepUntil = 123;
				d.sleepCycleCount = 2;
			},
		});
		const state = await readSessionState(kit.loop.harness);
		expect(state.runStatus.sleepUntil).toBe(123);
		expect(state.runStatus.sleepCycleCount).toBe(2);
		await kit.loop.close();
		kit.lock.release();
	});
});

/**
 * Bounded durable sleeps (M0-P17): the per-task sleep counter is checked
 * BEFORE a timer is created and recorded atomically with it; the cap (incl. 0)
 * exhausted means NO new timer ever — the wave stops once (quarantine); waking
 * a timer resets nothing; an answered submission resets the consecutive-error
 * streak so later tasks never inherit it.
 */
describe("bounded durable sleeps (M0-P17)", () => {
	beforeEach(() => {
		process.env["NO_COLOR"] = "1";
	});

	const ONE_TASK = { tasks: [{ id: "t1", title: "x", spec: "write src/one.ts", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 }] };
	const rateLimit = () => fauxAssistantMessage("provider overloaded", { stopReason: "error", errorMessage: "429 rate_limit resets in 90m" });
	const gateApprove = (path = "src/one.ts", notes = "diff satisfies the criterion") =>
		fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "line", path, line: 1 }] }], notes }), { stopReason: "stop" });

	async function sleepProject(clock: ReturnType<typeof fakeClockFor>, maxSleepCycles: number) {
		const project = await prepareDemoProject();
		await mkdir(join(project.root, "evals"), { recursive: true });
		await writeConfig(project.root, demoConfigToml().replace("maxSleepCycles = 3", `maxSleepCycles = ${maxSleepCycles}`));
		await writeFile(join(project.root, "evals", "recipes.toml"), "", "utf8");
		await initProject(project.root);
		await gitInit(project.root);
		const models = buildFauxModels([]);
		const kit = await openProjectHarness(project.root, "run", { modelsOverride: models.models, retryMax: 0, now: clock.now, setTimer: clock.setTimer });
		return { project, kit, faux: models.faux };
	}

	async function reopenSleepProject(project: { root: string }, clock: ReturnType<typeof fakeClockFor>) {
		const models = buildFauxModels([]);
		const kit = await openProjectHarness(project.root, "run", { modelsOverride: models.models, retryMax: 0, now: clock.now, setTimer: clock.setTimer });
		return { kit, faux: models.faux };
	}

	it("maxSleepCycles = 0: a rate limit quarantines the task once and creates NO sleep task", async () => {
		const clock = fakeClockFor();
		const { kit, faux } = await sleepProject(clock, 0);
		await scripted(kit, [fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }), rateLimit()], faux);
		await accomplish(kit);

		const summary = await runWaves(kit, { tasksFilter: [] });
		expect(summary.exit).toBe("blocked");
		expect(summary.quarantined).toEqual(["t1"]);
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.tasks[0]?.status).toBe("quarantined");
		expect(state.router.tasks[0]?.sleepCycles).toBeUndefined(); // never incremented
		expect(state.runStatus.sleepTaskId).toBeUndefined();
		expect(state.runStatus.sleepUntil).toBeUndefined();
		expect(state.rows.some((r) => r.kind === "governor" && r.verb === "sleep-budget-quarantine")).toBe(true);
		expect(state.rows.some((r) => r.verb === "rate-limit-sleep")).toBe(false); // no timer was ever created
		await kit.loop.close();
		kit.lock.release();
	});

	it("the sleep budget is consumed across restarts; the cap quarantines once with no new timer", async () => {
		const clock = fakeClockFor();
		const baked = await sleepProject(clock, 2);
		const faux = baked.faux;
		await scripted(baked.kit, [
			fauxAssistantMessage(JSON.stringify(ONE_TASK), { stopReason: "stop" }),
			rateLimit(), rateLimit(), rateLimit(),
		], faux);
		await accomplish(baked.kit);

		// run 1: rate limit arms durable sleep 1/2 (exit 42)
		const s1 = await runWaves(baked.kit, { tasksFilter: [] });
		expect(s1.exit).toBe("sleeping");
		let state = await readSessionState(baked.kit.loop.harness);
		expect(state.router.tasks[0]?.sleepCycles).toBe(1);
		expect(state.runStatus.sleepCycleCount).toBe(1);
		expect(state.runStatus.sleepTaskId).toBeDefined();
		await baked.kit.loop.close();
		baked.kit.lock.release();

		// run 2: the timer wakes (clock advanced), the minted attempt dispatches
		// fresh and rate-limits again → arm 2/2. The wake did NOT reset the count.
		clock.advance(91 * 60_000);
		const second = await reopenSleepProject(baked.project, clock);
		await scripted(second.kit, [rateLimit()], second.faux);
		const runner2 = runWaves(second.kit, { tasksFilter: [] });
		const s2 = await settleWithClock(runner2, clock);
		expect(s2.exit).toBe("sleeping");
		state = await readSessionState(second.kit.loop.harness);
		expect(state.router.tasks[0]?.sleepCycles).toBe(2);
		expect(state.runStatus.sleepCycleCount).toBe(2);
		await second.kit.loop.close();
		second.kit.lock.release();

		// run 3: wake, dispatch attempt #a3, rate-limit → the budget is exhausted:
		// NO new timer — the task quarantines once.
		clock.advance(91 * 60_000);
		const third = await reopenSleepProject(baked.project, clock);
		await scripted(third.kit, [rateLimit()], third.faux);
		const runner3 = runWaves(third.kit, { tasksFilter: [] });
		const s3 = await settleWithClock(runner3, clock);
		expect(s3.exit).toBe("blocked");
		expect(s3.quarantined).toEqual(["t1"]);
		state = await readSessionState(third.kit.loop.harness);
		expect(state.router.tasks[0]?.status).toBe("quarantined");
		expect(state.router.tasks[0]?.sleepCycles).toBe(2); // cap: never beyond
		expect(state.runStatus.sleepTaskId).toBeUndefined(); // no new timer
		expect(state.rows.some((r) => r.kind === "governor" && r.verb === "sleep-budget-quarantine" && r.detail?.includes("2/2"))).toBe(true);
		expect(state.rows.filter((r) => r.verb === "rate-limit-sleep")).toHaveLength(2); // exactly the two arms
		await third.kit.loop.close();
		third.kit.lock.release();
	});

	it("a task that succeeds after transient errors does not pass its consecutive-error streak to later tasks", async () => {
		const clock = fakeClockFor();
		const project = await prepareDemoProject();
		await mkdir(join(project.root, "evals"), { recursive: true });
		await writeConfig(project.root, demoConfigToml().replace("maxConsecutiveErrors = 3", "maxConsecutiveErrors = 2"));
		await writeFile(join(project.root, "evals", "recipes.toml"), "", "utf8");
		await initProject(project.root);
		await gitInit(project.root);
		const { models, faux } = buildFauxModels([]);
		const kit = await openProjectHarness(project.root, "run", { modelsOverride: models, retryMax: 0 });
		const transient = () => fauxAssistantMessage("temporary implementer outage", { stopReason: "error", errorMessage: "500 transient" });
		const write = (path: string, content: string) => fauxAssistantMessage([fauxToolCall("write", { path, content })], { stopReason: "toolUse" });
		await scripted(kit, [
			fauxAssistantMessage(JSON.stringify({ tasks: [
				{ id: "t1", title: "one", spec: "write src/one.ts", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 2 },
				{ id: "t2", title: "two", spec: "write src/two.ts", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 },
			] }), { stopReason: "stop" }),
			// t1: transient failure → retry → answered (resets the streak) → done
			transient(),
			write("src/one.ts", "export const one = 1;\n"),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			gateApprove("src/one.ts"),
			gateApprove("src/one.ts", "adversarial pass: no refutation found"),
			// t2: a transient failure here must count 1/2 (retry), not 2/2 (quarantine)
			transient(),
			write("src/two.ts", "export const two = 2;\n"),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			gateApprove("src/two.ts"),
			gateApprove("src/two.ts", "adversarial pass: no refutation found"),
		], faux);
		await accomplish(kit);

		const summary = await runWaves(kit, { tasksFilter: [] });
		expect(summary.exit).toBe("plan-complete");
		const state = await readSessionState(kit.loop.harness);
		expect(state.router.tasks.map((t) => [t.id, t.status])).toEqual([["t1", "done"], ["t2", "done"]]);
		expect(state.runStatus.consecutiveErrors).toBe(0); // reset by the answered submissions
		await kit.loop.close();
		kit.lock.release();
	});
});

/**
 * Drive a run whose first act is waiting out a durable sleep: advance the fake
 * clock (firing the due timer) until the run settles.
 */
async function settleWithClock(run: Promise<Awaited<ReturnType<typeof runWaves>>>, clock: ReturnType<typeof fakeClockFor>): Promise<Awaited<ReturnType<typeof runWaves>>> {
	let done = false;
	run.then(() => {
		done = true;
	}, () => {
		done = true;
	});
	for (let i = 0; i < 40 && !done; i++) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		clock.advance(91 * 60_000);
	}
	return run;
}

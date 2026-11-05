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
import { buildFauxModels, fakeClockFor } from "./fixtures.ts";
import { writeConfig, demoConfigToml } from "./demo-project.ts";
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

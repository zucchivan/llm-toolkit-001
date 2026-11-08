<script lang="ts">
	/**
	 * ActionBar (§7.2): the six mutations as buttons with their enablement rules.
	 * Dialog-needing clicks emit an ActionRequest to App (the single dialog host);
	 * dialog-free ones POST directly through App's reporter.
	 */
	import type { ReadoutSnapshot, JobsPayload } from "../lib/api.ts";
	import { postAction, type ActionBody } from "../lib/api.ts";
	import type { ActionRequest } from "../lib/actions-model.ts";
	import { describeStopTarget, stopAcceptedLine } from "../lib/dialog-requests.ts";
	import type { RouterTask } from "../../../src/engine/infos.ts";

	let { snapshot, jobs, selection = [], planTasks = undefined, request = () => {}, done = () => {}, error = () => {} }: {
		snapshot: ReadoutSnapshot;
		jobs: JobsPayload;
		/** Currently checked review tasks (Run selected). */
		selection?: string[];
		planTasks?: RouterTask[] | undefined;
		/** Hand a dialog request to App (the single dialog host). */
		request: (req: ActionRequest) => void;
		done: (message: string) => void;
		error: (message: string) => void;
	} = $props();

	const running = $derived(jobs.jobs.filter((j) => j.status === "running" && j.kind !== "handoff"));
	const runJob = $derived(running.find((j) => j.kind === "run"));
	const planJob = $derived(running.find((j) => j.kind === "plan"));
	const sleepBanner = $derived(!runJob && snapshot.sleep !== undefined);
	const todoCount = $derived(snapshot.readout.tasks.filter((t) => t.status === "todo").length);
	const quarantinedCount = $derived(snapshot.readout.tasks.filter((t) => t.status === "quarantined").length);
	const lockedBusy = $derived(
		snapshot.mode === "sidecars" && (snapshot.readout.identity.lockedByPid ?? 0) > 0 && jobs.attached !== undefined,
	);

	// M5-slice-3 (§7.2.1): the attached terminal-started run is stoppable when
	// its identity verification came back ok on the last jobs payload — the
	// POST re-verifies server-side and is the authoritative gate.
	const attachedStoppable = $derived(jobs.attached?.stop?.ok === true);

	const canPlan = $derived(planJob === undefined && runJob === undefined);
	const canRun = $derived(runJob === undefined && planJob === undefined && todoCount > 0 && !lockedBusy);
	const canStop = $derived(runJob !== undefined || planJob !== undefined || attachedStoppable);
	const resumeReady = $derived(sleepBanner && !lockedBusy);
	const selectedCount = $derived(selection.length);
	const canRunSelected = $derived(canRun && selectedCount > 0 && selectedCount <= todoCount && selectedCount < todoCount);

	// --- clicks (dialog ones hand off; others POST directly)

	function clickPlan(): void {
		const existing = snapshot.readout.tasks.length;
		request({
			kind: "plan",
			title: existing > 0 ? "Plan — replaces the current plan" : "Plan",
			body:
				existing > 0
					? `planning rewrites router.md and replaces the current graph (${existing} task(s)). Finished tasks stay in the durable paper trail (wave log), not in the new graph.`
					: "the planner turns the PRD into a task graph for review — nothing runs until you approve it.",
			confirmLabel: "Start planning",
			prd: snapshot.prdPath,
		});
	}

	function clickRun(withTasks: boolean): void {
		const selectedMode = withTasks && selectedCount < todoCount;
		const n = selectedMode ? selectedCount : todoCount;
		request({
			kind: selectedMode ? "run-selected" : "run-all",
			title: quarantinedCount > 0 ? "Approve & run — with quarantined tasks in the graph" : "Approve & run",
			body:
				`waves run ${n === todoCount ? `all ${n} todo task(s)` : `only the selected ${n} task(s)`}, paying provider tokens until each passes or the budget/breakers stop it.` +
				(quarantinedCount > 0 ? ` ${quarantinedCount} already-quarantined task(s) will NOT run (there is no retry-quarantined action in the loop).` : ""),
			confirmLabel: `Approve & run (${n})`,
		});
	}

	function clickStop(): void {
		request(describeStopTarget(jobs));
	}

	function clickResume(): void {
		request({
			kind: "resume",
			title: "Resume after provider-reset sleep",
			body: "reruns `run` without --approve: this plan is already approved and the durable sleep task resumes where it stopped.",
			confirmLabel: "Resume run",
		});
	}

	function clickHandoff(): void {
		request({
			kind: "handoff",
			title: "Handoff note",
			body: "queues a note (atomic side-car write, safe during a run); the next wave ingests it for context.",
			confirmLabel: "Queue note",
			note: "",
		});
	}

	// --- dialog-free actions

	async function clickVerify(): Promise<void> {
		const task = selectedCount === 1 ? selection[0] : snapshot.readout.tasks.find((t) => t.baselineTreeSha !== undefined && t.status !== "done")?.id;
		if (!task) {
			error("verify needs a task with a baseline (it never ran a wave) — run a task first or check exactly one card");
			return;
		}
		await tryAction({ kind: "verify", task });
	}

	async function clickExport(): Promise<void> {
		await tryAction({ kind: "export" });
	}

	async function tryAction(body: ActionBody): Promise<void> {
		try {
			const accepted = await postAction(body);
			done(stopAcceptedLine(accepted));
		} catch (err) {
			error((err as Error).message);
		}
	}
</script>

<div class="actionbar" role="toolbar" aria-label="run actions">
	<button class="btn" onclick={clickPlan} disabled={!canPlan} title="plan (planner turns the PRD into the task graph)">Plan</button>
	{#if sleepBanner}
		<button class="btn resume" onclick={clickResume} disabled={!resumeReady} title="rerun after the provider-reset sleep (exit 42)">⏾ Resume</button>
	{/if}
	<button class="btn positive" onclick={() => clickRun(false)} disabled={!canRun} title="run all todo tasks with --approve">
		Approve &amp; run{todoCount > 0 && canRun ? ` (${todoCount})` : ""}
	</button>
	<button class="btn" onclick={() => clickRun(true)} disabled={!canRunSelected} title="run only the selected todo tasks (--tasks)">Run selected</button>
	<button
		class="btn stop"
		onclick={clickStop}
		disabled={!canStop}
		title={canStop
			? attachedStoppable && runJob === undefined && planJob === undefined
				? `SIGINT (Ctrl-C) once to the verified terminal run (pid ${jobs.attached?.pid}) — exit 130, resumable`
				: "SIGINT to the running UI job"
			: jobs.attached !== undefined && jobs.attached.stop !== undefined
				? `cannot verify pid ${jobs.attached.pid} as this project's run loop — nothing will be signalled`
				: snapshot.sleep
					? "a run held the lock recently — nothing to stop right now"
					: snapshot.mode === "sidecars"
						? "a run holds the lock but was not launched by this UI — stop it from its terminal"
						: "nothing running"}
	>
		Stop
	</button>
	<button class="btn" onclick={clickHandoff} title="queue a note for the next wave (safe during a run)">Handoff</button>
	<button class="btn" onclick={clickVerify} disabled={running.length > 0 || snapshot.mode === "sidecars"} title="one-off verifier check on one task (--task)">Verify</button>
	<button class="btn" onclick={clickExport} disabled={running.length > 0 || snapshot.mode === "sidecars"} title="write report.json + report.html into .orch/artifacts">Export</button>
</div>

{#if lockedBusy && !runJob && !planJob}
	<div class="muted" style="font-size:11.5px; margin-top:4px">
		run/verify/export need a free .orch/lock — a run you did not launch is live (pid {jobs.attached?.pid}); the buttons unlock when it exits.
	</div>
{/if}

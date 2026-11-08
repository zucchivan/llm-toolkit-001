<script lang="ts">
	import type { KitTaskView } from "../../../src/engine/inspector.ts";
	import { STATUS_GLYPH } from "../lib/format.ts";
	import { sortedTasks, type TaskSort } from "../lib/view.ts";

	let { tasks, phase, onOpenDiff }: { tasks: KitTaskView[]; phase: string; onOpenDiff: (task: string) => void } = $props();

	// §15.1 task-table sorting: plan order by default (stable rows while the run
	// progresses), or a failing-first status sort. Filter stays a §13/§16 deferral.
	let sort = $state<TaskSort>("plan");
	const shown = $derived(sortedTasks(tasks, sort));
</script>

<section class="panel">
	<div class="panel-header">
		<span>tasks ({tasks.length})</span>
		<button
			class="btn tiny"
			title={sort === "plan"
				? "ordered by the plan — sort failing-first instead (quarantined, in progress, todo, done)"
				: "ordered failing-first — back to the plan's order"}
			aria-label={`sort tasks by ${sort === "plan" ? "failing-first status" : "plan order"}`}
			onclick={() => (sort = sort === "plan" ? "status" : "plan")}
		>
			{sort === "plan" ? "plan order" : "failing first"}
		</button>
		<span class="phase-hint muted">
			{#if phase === "empty" || tasks.length === 0}
				nothing planned yet — run `plan` in the CLI
			{:else if phase === "planned"}
				planned — the review on the left; Approve & run from the action bar
			{:else if phase === "running"}
				live run — the highlighted row is the current in-flight task
			{:else if phase === "complete"}
				queue drained
			{:else}
				{phase}
			{/if}
		</span>
	</div>
	<table class="grid" aria-label="tasks — status, id, title, waves, dependencies, diff">
		<thead>
			<tr>
				<th scope="col" style="width:110px">status</th>
				<th scope="col" style="width:180px">id</th>
				<th scope="col">title</th>
				<th scope="col" style="width:56px">waves</th>
				<th scope="col" style="width:180px">depends on</th>
				<th scope="col" style="width:110px">diff</th>
			</tr>
		</thead>
		<tbody>
			{#each shown as task (task.id)}
				<tr class:row-cur={task.status === "in_progress"}>
					<td class="st-{task.status}">
						{STATUS_GLYPH[task.status]?.glyph ?? "?"} {STATUS_GLYPH[task.status]?.label ?? task.status}
					</td>
					<td class="mono">{task.id}</td>
					<td title={task.targetPaths.length ? `target paths: ${task.targetPaths.join(", ")}` : undefined}>{task.title}</td>
					<td class="mono">{task.waveCount}</td>
					<td class="mono muted">{task.dependsOn.length ? task.dependsOn.join(", ") : "—"}</td>
					<td class="mono">
						{#if task.diff}
							<button class="btn tiny" title={task.status === "quarantined" ? "quarantine patch + its stats (rolled back)" : `task diff — cumulative since baseline, ${task.waveCount >= 0 ? task.waveCount : "?"} wave(s)`} onclick={() => onOpenDiff(task.id)}>
								diff
							</button>
						{:else if task.status === "in_progress"}
							<button class="btn tiny live-diff" title="live preview — the tree vs the task baseline, right now; nothing is persisted" onclick={() => onOpenDiff(task.id)}>
								live
							</button>
						{:else}
							<span class="muted" title="a diff exists once the task reaches done or quarantined">—</span>
						{/if}
					</td>
				</tr>
			{:else}
				<tr><td colspan="6" class="muted" style="padding:14px">no tasks — write the PRD and run `plan` in the CLI first</td></tr>
			{/each}
		</tbody>
	</table>
</section>

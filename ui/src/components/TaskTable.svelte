<script lang="ts">
	import type { KitTaskView } from "../../../src/engine/inspector.ts";
	import { STATUS_GLYPH } from "../lib/format.ts";
	import { sortedTasks, filterTasks, TASK_STATUSES, type TaskSort, type TaskStatusFilter } from "../lib/view.ts";

	let { tasks, phase, onOpenDiff, highlight }: { tasks: KitTaskView[]; phase: string; onOpenDiff: (task: string) => void; /** Conversation-drawer link: the task row the open conversation belongs to. */ highlight?: string } = $props();

	// §15.1 task-table sorting: plan order by default (stable rows while the run
	// progresses), or a failing-first status sort.
	let sort = $state<TaskSort>("plan");
	// M4-c row filter (the §13/§16 deferral, shipped): a status chip plus a
	// case-insensitive text match (id/title/deps/targets) — sibling of the event
	// log's filter; pure filterTasks owns the math. Sort composes on top.
	let status = $state<TaskStatusFilter>("all");
	let text = $state("");
	const active = $derived(status !== "all" || text.trim() !== "");
	const shown = $derived(sortedTasks(filterTasks(tasks, { status, text }), sort));

	const statusLabel = (s: KitTaskView["status"]): string => STATUS_GLYPH[s]?.label ?? s;
</script>

<section class="panel">
	<div class="panel-header">
		<span>tasks ({shown.length}{shown.length !== tasks.length ? ` of ${tasks.length}` : ""})</span>
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
	<div style="display:flex; gap:8px; align-items:center; padding:6px 12px; border-bottom:1px solid var(--border)">
		<input
			class="input input-sm"
			type="text"
			placeholder="filter — id, title, dependency"
			aria-label="filter tasks by id, title, or dependency"
			spellcheck="false"
			bind:value={text}
		/>
		<select
			class="input input-sm"
			style="min-width:130px"
			aria-label="filter tasks by status"
			value={status}
			onchange={(e) => (status = (e.currentTarget as HTMLSelectElement).value as TaskStatusFilter)}
		>
			<option value="all">all statuses</option>
			{#each TASK_STATUSES as s (s)}
				<option value={s}>{statusLabel(s)}</option>
			{/each}
		</select>
		{#if active}
			<button class="btn tiny" onclick={() => { text = ""; status = "all"; }} title="clear the task filter">reset</button>
		{/if}
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
				<tr class:row-cur={task.status === "in_progress"} class:row-link={highlight !== undefined && task.id === highlight}>
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
				<tr><td colspan="6" class="muted" style="padding:14px">
					{#if tasks.length === 0}
						no tasks — write the PRD and run `plan` in the CLI first
					{:else}
						no tasks match{status !== "all" ? ` status “${statusLabel(status)}”` : ""}{text.trim() ? ` “${text.trim()}”` : ""} — clear the filter to see all {tasks.length}
					{/if}
				</td></tr>
			{/each}
		</tbody>
	</table>
</section>

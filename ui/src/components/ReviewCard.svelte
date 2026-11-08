<script lang="ts">
	/** One plan-review card (§8.2 step 3): selection, spec, acceptance, deps, paths, priority. */
	import type { RouterTask } from "../../../src/engine/infos.ts";

	let { task, depsSatisfied, checked, disabled = false, onToggle, index }: {
		task: RouterTask;
		depsSatisfied: boolean;
		checked: boolean;
		disabled?: boolean;
		onToggle: (on: boolean) => void;
		index: number;
	} = $props();
</script>

<article class="review-card" class:card-blocked={!depsSatisfied}>
	<header style="display:flex; align-items:center; gap:8px">
		<label style="display:flex; align-items:center; gap:6px">
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled || !depsSatisfied || task.status !== "todo"}
				onchange={(e) => onToggle((e.currentTarget as HTMLInputElement).checked)}
			/>
			<span class="mono" style="color:var(--accent)">{index}. {task.id}</span>
		</label>
		{#if task.status !== "todo"}
			<span class="badge">{task.status}</span>
		{/if}
		{#if !depsSatisfied}
			<span class="badge" title="its dependencies are not done yet — selectable once they finish">blocked by deps</span>
		{/if}
		<span class="muted" style="margin-left:auto; font-size:11px" title="priority (higher = earlier)">prio {task.priority}</span>
	</header>
	<div style="font-weight:600; margin:6px 0 2px">{task.title}</div>
	<div style="margin-bottom:6px">{task.spec}</div>
	{#if task.acceptance.length}
		<ol class="acceptance">
			{#each task.acceptance as criterion, ai}
				<li>{criterion}</li>
			{/each}
		</ol>
	{/if}
	<div class="mono muted" style="font-size:11px; display:flex; gap:12px; flex-wrap:wrap">
		{#if task.targetPaths.length}<span>paths: {task.targetPaths.join(", ")}</span>{/if}
		{#if task.dependsOn.length}<span>deps: {task.dependsOn.join(", ")}</span>{/if}
	</div>
</article>

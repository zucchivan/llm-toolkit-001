<script lang="ts">
	/**
	 * Plan review (§8.2): task cards in topological order — id, title, spec,
	 * acceptance, target paths, dependencies, priority, selection checkboxes.
	 * Selectable when dependencies are done/empty; selection defaults to all
	 * selectable tasks; Approve & run confirms the count; Run selected runs the
	 * checked subset. Needs the full router (storage mode); degraded note when
	 * it is absent.
	 */
	import ReviewCard from "./ReviewCard.svelte";
	import { topoOrder, defaultSelection, depsDone, type PlanCard } from "../lib/view.ts";
	import type { RouterTask } from "../../../src/engine/infos.ts";

	let { planTasks, selection = $bindable([]) }: {
		planTasks: RouterTask[] | undefined;
		/** two-way bound checked ids (ActionBar reads them for Run selected). */
		selection: string[];
	} = $props();

	const cards = $derived.by((): PlanCard[] => {
		if (!planTasks) return [];
		return topoOrder(planTasks).map((task) => ({ task, depsSatisfied: depsDone(task, planTasks) }));
	});

	let seeded = $state(false);
	$effect(() => {
		// Default selection = every selectable todo task, once (stay user-edited).
		if (planTasks && !seeded) {
			seeded = true;
			selection = defaultSelection(planTasks);
		}
	});

	function toggle(id: string, on: boolean): void {
		selection = on ? [...selection, id] : selection.filter((s) => s !== id);
	}
</script>

<section class="panel">
	<div class="panel-header">
		<span>plan review · {cards.length} task(s)</span>
		<span class="muted">
			{#if planTasks}
				checked {selection.length} / selectable {cards.filter((c) => c.depsSatisfied && c.task.status === "todo").length}
			{:else}
				sidecar mode — the lock is held: full graph unavailable
			{/if}
		</span>
	</div>
	<div style="padding:8px 12px" class="muted">
		ordered topologically · approve stamps the plan (the human review point) · Run selected waves the checked subset
	</div>
	{#if !planTasks}
		<div class="banner">
			full task details (spec, acceptance, deps) live in storage behind <code class="mono">.orch/lock</code> — this view fills in when no run holds the lock.
		</div>
	{:else}
		<div class="review-grid">
			{#each cards as card, i (card.task.id)}
				<ReviewCard
					index={i + 1}
					task={card.task}
					depsSatisfied={card.depsSatisfied}
					checked={selection.includes(card.task.id)}
					onToggle={(on) => toggle(card.task.id, on)}
				/>
			{/each}
		</div>
	{/if}
</section>

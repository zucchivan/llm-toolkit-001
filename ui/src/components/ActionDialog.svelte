<script lang="ts">
	/**
	 * ActionDialog (§7.2/§9): confirmations that state the effect — plan replace,
	 * approve & run (with the count + quarantined badge), run-selected, stop,
	 * resume, handoff (note textarea), plan (editable PRD path prefill).
	 * No silent run: every run/dangerous action passes through here.
	 *
	 * Model readiness (M3+ UX fix): when the action needs models, the dialog
	 * shows the configured role models as chips up front (is a model even set?)
	 * and — when a needed role has none — a kind warning with a paste-ready
	 * TOML block disables the positive button. The server's configPreflight
	 * (422) is the authoritative backstop; this is the same check, earlier.
	 */
	import type { ActionRequest } from "../lib/actions-model.ts";
	import type { RoleModelInfo } from "../lib/api.ts";
	import { modelPreflight, type ModelPreflight } from "../lib/view.ts";

	/** Display order mirrors the kit's ROLES; a missing model gets its own chip state. */
	const DIALOG_ROLES = ["planner", "implementer", "verifier"] as const;


	let { request, models, configError, onConfirm, onCancel }: {
		request: ActionRequest;
		/** The configured role models from the snapshot (undefined on a degraded/config-broken read). */
		models?: RoleModelInfo[];
		/** The config failed to load mid-session (bad TOML edit, schema slip). */
		configError?: string;
		onConfirm: (result: { prd?: string; note?: string }) => void;
		onCancel: () => void;
	} = $props();

	let prd = $state("");
	let note = $state("");
	let sending = $state(false);
	// Seed from the request ONCE per request object. Re-deriving on every run
	// would make the effect's own writes (user typing) a dependency and reset
	// the fields mid-edit — the M3 component test caught exactly that.
	let seededFrom: ActionRequest | undefined;
	$effect(() => {
		if (seededFrom === request) return;
		seededFrom = request;
		prd = request.prd ?? "";
		note = request.note ?? "";
	});

	const preflight = $derived(
		request.kind === "plan" || request.kind === "run-all" || request.kind === "run-selected" || request.kind === "resume"
			? modelPreflight(request.kind, models, configError)
			: undefined,
	);
	// The row renders only with knowledge: configured models (chips) or a broken
	// config (warning). Unknown roles (no snapshot yet) stay permissive —
	// showing speculative "not configured" chips would contradict the server.
	const modelPreflightNeedsModels = $derived(
		request.kind === "plan" || request.kind === "run-all" || request.kind === "run-selected" || request.kind === "resume",
	);
	const showModelsRow = $derived(
		(modelPreflightNeedsModels && (models !== undefined || configError !== undefined)) || configError !== undefined,
	);

	function submit(): void {
		if (sending) return;
		if (preflight && !preflight.ok) return; // the kind warning explains why
		sending = true;
		onConfirm({ prd: prd.trim() || undefined, note });
	}

	function onKeydown(ev: KeyboardEvent): void {
		if (ev.key === "Escape") onCancel();
	}

	let card: HTMLDivElement | undefined = $state(undefined);
	$effect(() => {
		card?.querySelector<HTMLButtonElement>("button.positive:not(:disabled)")?.focus();
	});
</script>

<svelte:window onkeydown={onKeydown} />

<div class="dialog-backdrop" onmousedown={(ev) => { if (ev.target === ev.currentTarget) onCancel(); }} role="presentation">
	<div class="dialog card" bind:this={card} role="dialog" aria-modal="true" aria-label={request.title}>
		<div class="dialog-title">{request.title}</div>
		<div class="dialog-body">{request.body}</div>
		{#if showModelsRow}
			<div class="dialog-models" data-testid="dialog-models">
				{#if !configError}
					<div class="dialog-models-label muted">models (.orch/config.toml)</div>
					<div class="dialog-chips">
						{#each DIALOG_ROLES as role (role)}
							{@const info = models?.find((m) => m.name === role)}
							{@const ready = info !== undefined && !!info.provider?.trim() && !!info.modelId?.trim()}
							<span class="chip chip-{ready ? "ok" : "warn"}" title={ready ? `${info?.provider} · ${info?.modelId}` : `no provider/modelId set for roles.${role}`}>
								{role}
								{ready ? `· ${info?.provider} · ${info?.modelId}` : "· not configured"}
							</span>
						{/each}
					</div>
				{/if}
				{#if preflight && !preflight.ok}
					<div class="dialog-warning" data-testid="dialog-model-warning" role="note">
						<strong>can't start yet: {preflight.reason}.</strong> In <span class="mono">.orch/config.toml</span> add:
						{#if preflight.snippet}
							<pre class="dialog-snippet mono">{preflight.snippet}</pre>
						{/if}
						<span class="muted">the UI never writes the config for you — set the block(s), save, and the dialog re-reads it on the next snapshot.</span>
					</div>
				{/if}
			</div>
		{/if}
		{#if request.kind === "plan"}
			<label style="display:block; margin-top:8px">
				<span class="muted" style="font-size:11.5px">PRD path</span>
				<input class="input mono" bind:value={prd} placeholder="docs/prd.md" spellcheck="false" />
			</label>
		{/if}
		{#if request.kind === "handoff"}
			<label style="display:block; margin-top:8px">
				<span class="muted" style="font-size:11.5px">note for the next wave</span>
				<textarea class="input mono" bind:value={note} rows="3" placeholder="…context the next wave should keep in mind"></textarea>
			</label>
		{/if}
		<div class="dialog-actions">
			<button class="btn" onclick={onCancel} disabled={sending}>cancel</button>
			<button class="btn positive" disabled={(preflight !== undefined && !preflight.ok) || sending} onclick={submit}>
				{sending ? "sending…" : request.confirmLabel}
			</button>
		</div>
	</div>
</div>

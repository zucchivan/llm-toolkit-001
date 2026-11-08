<script lang="ts">
	/**
	 * ProjectSources (M5-a + M5-b, ui/PRD.md §5 + §18): the read-only viewers
	 * for the loop's INPUT documents — `.orch/config.toml`, the PRD at its
	 * resolved path, `PROMPT.md` (the per-wave discipline doc every wave input
	 * embeds), and `evals/recipes.toml` (the gate recipes). Raw text + honest
	 * verdict chips (parse error / missing / capped / binary); never a write
	 * (the CLI is the only mutation path, editing happens in your editor).
	 * Static files, both snapshot modes — no lock, no harness window, no SSE
	 * polling: fetches on open + on refetch (§13: no polling loops in the
	 * browser). router.md stays OUT of here on purpose: its content already
	 * lives in the plan-review cards.
	 */
	import { fetchProjectSources, type ProjectSourcesPayload, type SourceFileView } from "../lib/api.ts";
	import { sourceChip, promptChip, recipesChip, worstSourceChip, type SourceChip } from "../lib/view.ts";
	import { bytesLabel } from "../lib/format.ts";

	let {
		open = false,
		configError,
		onToggle,
	}: {
		open?: boolean;
		/** The snapshot's configError (when loadConfig fails mid-session) — colors the header before any fetch. */
		configError?: string;
		onToggle: () => void;
	} = $props();

	type ReadState = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; payload: ProjectSourcesPayload } | { kind: "error"; message: string };
	let state = $state<ReadState>({ kind: "idle" });
	let seq = 0;

	async function load(): Promise<void> {
		const token = ++seq;
		state = { kind: "loading" };
		try {
			const payload = await fetchProjectSources();
			if (token === seq) state = { kind: "ready", payload };
		} catch (err) {
			if (token === seq) state = { kind: "error", message: (err as Error).message };
		}
	}

	// Fetch on every open (fresh read of static files, cheap — never polled).
	// Closed = zero requests; the refetch button is the only other trigger.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			void load();
		} else if (!open) {
			wasOpen = false;
			return;
		}
		wasOpen = true;
	});

	type EntryKey = "config" | "prd" | "prompt" | "recipes";

	/** One rendered file: the §11.4 facts + its chip + the per-file banner words. */
	interface SourceEntryView extends SourceFileView {
		key: EntryKey;
		chip: SourceChip;
		/** The loader's plain-words verdict when the file fails to parse (config/recipes). */
		parseError?: string;
		/** Lead sentence of the missing banner, before ` <path>.` */
		missingLead: string;
		/** How to fix it (graceful for prank-prompt and recipes — absence there is not a dead end). */
		missingBody?: string;
		/** Lead sentence of the parse-error banner; empty when the file is never parsed. */
		parseLead: string;
		/** Sentence after the verdict message (why the raw text still shows). */
		parseTail?: string;
	}

	/** Per-file banner framing. config/recipes parse; prd/prompt are raw text — no loader to fail. */
	const FRAMES: Record<EntryKey, Omit<SourceEntryView, keyof SourceFileView | "chip" | "key">> = {
		config: {
			missingLead: "no config at",
			missingBody: "run llm-toolkit-001 init in the project root — it scaffolds the config this ui also needs to start.",
			parseLead: "the config doesn't parse (loading it fails — see the dialogs' notes too):",
		},
		prd: {
			missingLead: "no prd at",
			missingBody: "write it (the setup panel names the expected path), or pass --prd <path> in a terminal plan — the plan dialog prefills the same path.",
			parseLead: "",
		},
		prompt: {
			missingLead: "no",
			missingBody: "the engine still runs every wave, but each wave input assembles without the per-wave discipline doc — write it at the project root, or run llm-toolkit-001 init to scaffold one.",
			parseLead: "",
		},
		recipes: {
			missingLead: "no",
			missingBody: "a defined state: zero gate recipes, so gates run the scope check only. llm-toolkit-001 init scaffolds a commented starter to copy blocks from.",
			parseLead: "the recipes don't load — the next wave's gate step fails with exactly this:",
			parseTail: "the raw text follows so you can fix the edit.",
		},
	};

	const entries = $derived.by(() => {
		if (state.kind !== "ready") return [] as SourceEntryView[];
		const p = state.payload;
		const mk = (key: EntryKey, file: SourceFileView & { parseError?: string }, chip: SourceChip): SourceEntryView => ({ ...file, key, chip, ...(file.parseError !== undefined ? { parseError: file.parseError } : {}), ...FRAMES[key] });
		return [
			mk("config", p.config, sourceChip(p.config, p.config.parseError)),
			mk("prd", p.prd, sourceChip(p.prd)),
			mk("prompt", p.prompt, promptChip(p.prompt)),
			mk("recipes", p.recipes, recipesChip(p.recipes, p.recipes.parseError)),
		];
	});

	/** healthchip severity: parse error red, missing/binary amber, cap dashed, ok green. */
	function chipClass(kind: string): string {
		if (kind === "parse-error") return "healthchip-error";
		if (kind === "missing" || kind === "binary") return "healthchip-warning";
		if (kind === "capped" || kind === "unloaded") return "healthchip-skip";
		return "healthchip-pass";
	}

	/** Header summary: the worst fact is visible before opening (severity, not position). */
	const headerNote = $derived.by(() => {
		if (state.kind === "loading") return "reading…";
		if (state.kind === "error") return "unreadable";
		if (configError !== undefined && configError !== "") return "parse error";
		if (state.kind === "ready") {
			const worst = worstSourceChip(entries.map((e) => e.chip));
			return worst !== undefined && worst.kind !== "ok" ? worst.label : "ok · all four";
		}
		return "config + prd + prompt + recipes";
	});
</script>

<section class="panel">
	<button
		class="panel-header healthpanel-toggle"
		type="button"
		onclick={onToggle}
		aria-expanded={open}
		aria-controls="sources-body"
		title="the loop's input documents, read-only — editing happens in your editor (§5: the ui never writes the config, the prd, PROMPT.md or the gate recipes)"
	>
		<span>{open ? "▾" : "▸"} sources · config + prd + prompt + recipes</span>
		<span class={headerNote === "parse error" || headerNote === "unreadable" ? "mono sources-note-bad" : "muted mono"}>{headerNote}</span>
	</button>
	{#if open}
		<div id="sources-body" style="padding:4px 0 6px; max-height:460px; overflow:auto">
			<div class="read-only-note mono">read-only — the ui never writes these files; edit in your editor, the cli stays the only mutation path. <button class="btn tiny" onclick={() => void load()}>refetch</button></div>
			<div id="config-file">
				{#if state.kind === "loading"}
					<div class="muted status-mono" style="padding:10px 12px">reading the sources…</div>
				{:else if state.kind === "error"}
					<div class="banner">
						<strong>the sources didn't load.</strong>
						<span class="mono">{state.message}</span>
					</div>
				{:else if state.kind === "ready"}
					{#each entries as e (e.key)}
						<div class="srcfile">
							<div class="srcfile-head mono">
								<span class="healthchip {chipClass(e.chip.kind)}">{e.chip.label}</span>
								<span class="mono">{e.path}</span>
								<span class="muted">{bytesLabel(e.bytes)}</span>
							</div>
							{#if e.parseError}
								<div class="banner" data-testid={`sources-${e.key}-parse-error`}>
									<strong>{e.parseLead}</strong>
									<span class="mono">{e.parseError}</span>
									{#if e.parseTail}{e.parseTail}{/if}
								</div>
							{/if}
							{#if !e.exists}
								<div class="banner" data-testid={`sources-${e.key}-missing`}>
									<strong>{e.missingLead} <code>{e.path}</code>.</strong>
									{#if e.missingBody}{e.missingBody}{/if}
								</div>
							{/if}
							{#if e.truncated}
								<div class="banner" data-testid={`sources-${e.key}-truncated`}>
									<strong>capped.</strong> the text shown is the first {(5 * 1024 * 1024).toLocaleString("en-US")} bytes; open the file in your editor for the rest.
								</div>
							{/if}
							{#if e.binary}
								<div class="banner"><strong>binary content.</strong> shown as metadata only — not previewed as text.</div>
							{:else if e.exists && e.text !== undefined}
								<pre class="joblog mono" data-testid={`sources-${e.key}-text`}>{e.text}</pre>
							{/if}
						</div>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</section>

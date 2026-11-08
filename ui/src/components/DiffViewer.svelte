<script lang="ts">
	/**
	 * DiffViewer (§9/§7.4): the diff drawer's body — file list (status + +/-),
	 * unified hunks with line coloring, lazy per-file expand, binary/truncated
	 * notices, raw download; the cumulative-since-baseline label; live preview
	 * shows "may be incomplete" and refetches with each snapshot.
	 * It fetches its own data (persisted vs live by the `live` prop); App owns
	 * the drawer chrome.
	 */
	import { fetchTaskDiff, fetchLiveDiff, diffDownloadUrl, normalize, normalizePersisted, type DiffDoc, type ReadoutSnapshot } from "../lib/api.ts";
	import { parseUnifiedDiff, cumulativeLabel, DIFF_FILE_LINE_CAP, statusLabel } from "../lib/diff.ts";
	import type { ParsedDiff, ParsedDiffFile } from "../lib/diff.ts";

	let {
		task,
		live = false,
		snapshot, // live mode: a new snapshot triggers one refetch (event-driven)
		rolledBack = false, // quarantined: the tree no longer matches this diff
		waves = 1, // task.waveCount for the cumulative label
	}: {
		task: string;
		live?: boolean;
		snapshot?: ReadoutSnapshot;
		rolledBack?: boolean;
		waves?: number;
	} = $props();

	let doc = $state<DiffDoc | undefined>(undefined);
	let error = $state<string | undefined>(undefined);
	let loading = $state(false);
	let openFiles = $state<Record<string, boolean>>({});

	let parsed = $derived<ParsedDiff>(doc ? parseUnifiedDiff(doc.diff) : { files: [], truncated: false });
	let waveLabel = $derived(cumulativeLabel(waves));

	async function load(): Promise<void> {
		loading = true;
		error = undefined;
		try {
			if (live) {
				try {
					doc = normalize(await fetchLiveDiff(task));
				} catch (err) {
					// The wave ended (or moved on) while the drawer was open: the live
					// request's 409 falls back to the task's persisted diff when one exists.
					if (!/not the current in-flight/i.test((err as Error).message)) throw err;
					doc = normalizePersisted(await fetchTaskDiff(task));
				}
			} else {
				doc = normalizePersisted(await fetchTaskDiff(task));
			}
		} catch (err) {
			error = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	// (Re)load whenever the drawer's task or mode changes.
	$effect(() => {
		void task;
		void live;
		void load();
	});

	// Live mode: each readout snapshot refreshes the preview once (no polling loop).
	$effect(() => {
		const at = snapshot?.at;
		if (!live || at === undefined) return;
		if (loading) return;
		void load();
	});

	function isOpen(file: ParsedDiffFile): boolean {
		return openFiles[file.path] ?? false;
	}

	function toggle(file: ParsedDiffFile): void {
		openFiles = { ...openFiles, [file.path]: !isOpen(file) };
	}

	function statsFor(file: ParsedDiffFile): { insertions: number; deletions: number; status: string; binary: boolean } {
		const stat = doc?.statsJson?.files.find((f) => f.path === file.path) ?? doc?.statsFiles?.find((f) => f.path === file.path);
		if (stat) return { insertions: stat.insertions, deletions: stat.deletions, status: stat.status, binary: stat.binary };
		return {
			insertions: file.insertions,
			deletions: file.deletions,
			status: file.added ? "A" : file.deleted ? "D" : "M",
			binary: file.binary,
		};
	}

	/** §13 cap: first 2000 lines per file body; the rest stays in the raw download. */
	function lineView(file: ParsedDiffFile): { hunks: { header: string; lines: { kind: string; text: string }[] }[]; shown: number; total: number } {
		let budget = DIFF_FILE_LINE_CAP;
		const hunks: { header: string; lines: { kind: string; text: string }[] }[] = [];
		let shown = 0;
		for (const h of file.hunks) {
			if (budget <= 0) break;
			const lines = h.lines.slice(0, budget);
			budget -= lines.length;
			shown += lines.length;
			hunks.push({ header: h.header, lines });
		}
		const total = file.hunks.reduce((n, h) => n + h.lines.length, 0);
		return { hunks, shown, total };
	}
</script>

<div class="diffviewer">
	<div class="diffmeta">
		<span class="mono">task {task}</span>
		<span class="muted label-cumulative">{waveLabel}</span>
		{#if rolledBack}<span class="badge ph-quarantined" title="the working tree was rolled back to the baseline — this patch is the evidence of what was undone">rolled back</span>{/if}
		{#if live}
			<span class="badge ph-running" title="computed on demand vs the task baseline; nothing is persisted">live preview</span>
			<button class="btn tiny" onclick={() => void load()} disabled={loading}>{loading ? "…" : "refresh"}</button>
		{/if}
	</div>

	{#if live}
		<div class="banner diffbanner">live preview — may be incomplete: the wave is still running; this is the working tree vs the task baseline right now</div>
	{/if}

	{#if error}
		<!-- §15.1: kind wording for the known statuses; everything else stays raw -->
		<div class="banner error">
			{#if /no diff artifacts for task/i.test(error) || /only done\/quarantined/i.test(error)}
			<strong>no diff yet.</strong> this task hasn't reached done or quarantined — the patch persists the moment it does. if it was expected to be terminal, its evidence patch may not have been saved (the health panel's `patches` check says when).
			{:else if /unreadable/i.test(error)}
			<strong>diff unreadable.</strong> {error} — the patch file exists but could not be read; nothing can be shown safely.
			{:else if /not the current in-flight/i.test(error)}
			<strong>live preview ended.</strong> {error} — the wave moved on; reopen for the persisted diff if one exists now.
			{:else if /does not carry this task's baseline/i.test(error)}
			<strong>live preview unavailable.</strong> {error}
			{:else}
			<strong>diff unavailable:</strong> <span class="mono">{error}</span>
			{/if}
		</div>
	{:else if loading}
		<div class="muted" style="padding:4px 0">loading the patch…</div>
	{:else if doc}
		<div class="diffmeta muted" style="font-size:11px">
			<span class="mono">{doc.bytes.toLocaleString("en-US")} bytes</span>
			{#if doc.truncated}
				<span class="badge ph-blocked" title="the stored patch was cut at the 5 MiB cap; the stats side-car records the cut">truncated at the 5&nbsp;MiB cap</span>
			{/if}
			{#if !doc.statsJson && !doc.live}<span class="muted" title="older kit run without the A.2 stats side-car">no stats side-car</span>{/if}
			<a href={diffDownloadUrl(task)} download title="raw patch bytes as an attachment">raw download</a>
		</div>
		{#if doc.note}
			<div class="banner diffbanner">{doc.note}</div>
		{/if}
		<div class="filelist">
			{#each parsed.files as file (file.path)}
				{@const stats = statsFor(file)}
				<div class="diffrow">
					<button class="iffexpand" onclick={() => toggle(file)} title="expand/collapse this file's hunks">
						<span class="mono">{file.path}</span>
						<span class="chip chip-{stats.binary ? 'bin' : stats.status === 'A' ? 'add' : stats.status === 'D' ? 'del' : 'mod'}">
							{stats.binary ? "binary" : statusLabel(stats.status)}
						</span>
						{#if stats.binary}
							<span class="muted">no content shown</span>
						{:else}
							<span class="mono dplus">+{stats.insertions}</span>
							<span class="mono dminus">−{stats.deletions}</span>
						{/if}
					</button>
				</div>
			{#if !stats.binary && isOpen(file)}
				{@const view = lineView(file)}
				<div class="hunks">
					{#each view.hunks as h (h.header)}
						<div class="hunkmeta mono">{h.header}</div>
						{#each h.lines as l, i (i)}
							<div class="diffline {l.kind}">
								<span class="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
								<span class="mono">{l.text === "" ? " " : l.text}</span>
							</div>
						{/each}
					{/each}
					{#if file.hitEndOfStream}
						<div class="muted dcut">hunk ends where the patch was cut (truncated)</div>
					{/if}
				</div>
				{#if view.total > view.shown}
					<div class="muted dcut">showing first {view.shown.toLocaleString("en-US")} of {view.total.toLocaleString("en-US")} lines — use raw download for the rest</div>
				{/if}
			{/if}
			{:else}
				<div class="muted" style="padding:12px">
					nothing displayable in this patch — engine-owned paths (.orch/**, router.md, PROMPT.md) are excluded from diffs and stats.
				</div>
			{/each}
		</div>
	{/if}
</div>

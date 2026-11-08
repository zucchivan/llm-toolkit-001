<script lang="ts">
	/**
	 * The one phase-aware page (§7.1): header strip + action bar + the view the
	 * phase demands (planning / review / monitor / report), jobs list, event
	 * log, dialog host, toasts. One SSE channel + one `now` ticker; the store
	 * replaces on each snapshot.
	 */
	import { fetchReadout, fetchJobs, postAction, type ReadoutSnapshot, type JobsPayload, type ActionBody } from "./lib/api.ts";
	import { decideView, jobOutcome, failureRows, diffDrawerState, latestDiffTask, globalShortcut, escapeTarget, hashDiffTask, type FailureRow } from "./lib/view.ts";
	import type { ToastMessage } from "./components/Toasts.svelte";
	import { actionRequestToBody, describeStopTarget } from "./lib/dialog-requests.ts";
	import type { ActionRequest } from "./lib/actions-model.ts";
	import { focusEventFilter } from "./lib/shortcuts.ts";
	import { msDuration } from "./lib/format.ts";
	import StatusStrip from "./components/StatusStrip.svelte";
	import HealthPanel from "./components/HealthPanel.svelte";
	import ShortcutSheet from "./components/ShortcutSheet.svelte";
	import ActionBar from "./components/ActionBar.svelte";
	import ActionDialog from "./components/ActionDialog.svelte";
	import PlanReview from "./components/PlanReview.svelte";
	import PlanningView from "./components/PlanningView.svelte";
	import CompletionReport from "./components/CompletionReport.svelte";
	import JobList from "./components/JobList.svelte";
	import TaskTable from "./components/TaskTable.svelte";
	import EventLog from "./components/EventLog.svelte";
	import Toasts from "./components/Toasts.svelte";
	import DiffViewer from "./components/DiffViewer.svelte";

	let snapshot = $state<ReadoutSnapshot | undefined>(undefined);
	let jobs = $state<JobsPayload | undefined>(undefined);
	let loadError = $state<string | undefined>(undefined);
	let sseConnected = $state(false);
	let now = $state(Date.now());
	let decision = $derived(decideView(snapshot, jobs));

	// --- plan-review selection (Run selected reads it)
	let selection = $state<string[]>([]);
	let planTasks = $derived(decision.planTasks);

	// --- dialog host: both the toolbar and the job list can open one
	let dialog = $state<ActionRequest | undefined>(undefined);

	function openStopDialog(): void {
		if (!snapshot || !jobs) return;
		dialog = describeStopTarget(snapshot, jobs);
	}

	// --- health panel (§7.1): collapsible, header-dot toggle, #/health deep link
	let healthOpen = $state(false);

	function toggleHealth(): void {
		healthOpen = !healthOpen;
		history.replaceState(null, "", healthOpen ? "#/health" : location.hash === "#/health" ? "#" : location.hash || "#");
	}

	// The page may open with #/health; user-driven hash changes (back/forward,
	// anchor clicks — replaceState ones never fire) sync the panel with it.
	$effect(() => {
		const onHash = (): void => {
			healthOpen = location.hash === "#/health";
		};
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	});

	// --- shortcut sheet ("?") + global keys (§10): Esc sheet > dialog > drawer,
	// "/" focuses the event filter, "?" opens the sheet. No destructive keys.
	let sheetOpen = $state(false);

	$effect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				const target = escapeTarget({ sheetOpen, dialogOpen: dialog !== undefined, drawerOpen: diffDrawerTask !== undefined || unknownDrawerTask !== undefined });
				if (target === "sheet") {
					sheetOpen = false;
					e.preventDefault();
				} else if (target === "drawer") {
					closeDiff();
					e.preventDefault();
				}
				// target === "dialog": ActionDialog closes itself; null: nothing to close.
				return;
			}
			const t = e.target as HTMLElement | null;
			const typing = t !== null && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
			const action = globalShortcut(e.key, typing, e);
			if (action === "filter") {
				e.preventDefault();
				focusEventFilter();
			} else if (action === "sheet") {
				e.preventDefault();
				sheetOpen = true;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	// --- toasts + tab-title badge (failures only for M1)
	let toasts = $state<ToastMessage[]>([]);
	// Rows already on screen when a snapshot first lands are history, not news.
	let rowsSeen = $state(false);
	let lastRowTs = $state(0);

	const failures = $derived<FailureRow[]>(snapshot ? failureRows(snapshot.readout.rows) : []);

	$effect(() => {
		if (!snapshot) return;
		const rows = snapshot.readout.rows;
		const maxTs = rows.reduce((m, r) => Math.max(m, r.ts), lastRowTs);
		if (!rowsSeen) {
			// First snapshot after page load: absorb the existing rows silently.
			rowsSeen = true;
			lastRowTs = maxTs;
			return;
		}
		for (const row of failures) {
			if (row.ts <= lastRowTs) continue;
			pushToast(row.severity, row.text);
		}
		lastRowTs = maxTs;
	});

	let toinst = 0;
	function pushToast(severity: ToastMessage["severity"], text: string): void {
		const id = `t-${++toinst}-${crypto.randomUUID().slice(0, 8)}`;
		toasts = [...toasts, { id, severity, text }];
		setTimeout(() => dismissToast(id), severity === "error" ? 9_000 : 5_000);
	}
	function dismissToast(id: string): void {
		toasts = toasts.filter((t) => t.id !== id);
	}

	// Tab-title badge: live error toasts count on top of the base title (§7.1).
	const BASE_TITLE = "llm-toolkit-001 · ui";
	$effect(() => {
		const errorCount = toasts.filter((t) => t.severity === "error").length;
		document.title = errorCount > 0 ? `✘ ${errorCount} · ${BASE_TITLE}` : BASE_TITLE;
	});

	function doneToast(message: string): void {
		pushToast("info", message);
	}

	// --- diff drawer + hash deep links (#/diff/<task>, §7.1) — M2's evidence view
	// The task id is the drawer state; live/rolledBack/waves derive from the
	// snapshot (lib/view.ts diffDrawerState) so the drawer stays truthful as the
	// run progresses between snapshots.
	let diffDrawerTask = $state<string | undefined>(undefined);
	const drawer = $derived(diffDrawerState(snapshot, diffDrawerTask));
	// A deep link naming a task the readout doesn't know: still show a drawer —
	// a kind note, not silence (M3 verification: #/diff/<unknown> drew nothing).
	let unknownDrawerTask = $state<string | undefined>(undefined);

	function openDiff(task: string): void {
		diffDrawerTask = task;
		unknownDrawerTask = diffDrawerState(snapshot, task) ? undefined : task;
		history.replaceState(null, "", `#/diff/${encodeURIComponent(task)}`);
	}

	function closeDiff(): void {
		diffDrawerTask = undefined;
		unknownDrawerTask = undefined;
		if (location.hash.startsWith("#/diff/")) history.replaceState(null, "", "#");
	}

	// The page may open with #/diff/<task> before the first snapshot lands:
	// re-assert the drawer on every snapshot until it sticks.
	$effect(() => {
		if (!snapshot) return;
		const task = hashDiffTask(location.hash);
		if (!task) {
			unknownDrawerTask = undefined;
			return;
		}
		if (diffDrawerTask !== task) openDiff(task);
		unknownDrawerTask = diffDrawerState(snapshot, task) ? undefined : task;
	});

	$effect(() => {
		const onHash = (): void => {
			const task = hashDiffTask(location.hash);
			if (task) {
				openDiff(task);
			} else {
				diffDrawerTask = undefined;
				unknownDrawerTask = undefined;
			}
		};
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	});



	/** Newest diff-bearing artifact → the jobs panel's "diffs" shortcut. */
	const latestDiff = $derived(latestDiffTask(snapshot?.readout.artifacts));

	// --- job end→toast (exit codes surfaced plainly, §7.3)
	let seenJobEnds = $state<Set<string>>(new Set());
	$effect(() => {
		if (!jobs || !rowsSeen) return;
		for (const job of jobs.jobs) {
			if (job.status === "running" || job.kind === "handoff") continue;
			const key = `${job.id}@${job.exitCode ?? job.status}`;
			if (seenJobEnds.has(key)) continue;
			seenJobEnds.add(key);
			const outcome = jobOutcome(job.exitCode);
			if (outcome === "failed") {
				pushToast("error", `${job.kind} job failed (exit ${job.exitCode}) — see its log tail in the jobs panel`);
			} else if (outcome === "interrupted") {
				pushToast("warn", `${job.kind} job interrupted (exit 130) — durable state stays resumable`);
			}
		}
	});

	// --- first readout + SSE
	$effect(() => {
		let cancelled = false;
		let gotFirstReadout = false;

		fetchReadout()
			.then((snap) => {
				if (!cancelled && !gotFirstReadout) {
					gotFirstReadout = true;
					snapshot = snap;
					loadError = undefined;
				}
			})
			.catch((err: unknown) => {
				if (!cancelled) loadError = (err as Error).message;
			});
		fetchJobs()
			.then((payload) => {
				if (!cancelled) jobs = payload;
			})
			.catch(() => void 0);

		const es = new EventSource("/api/events");
		es.addEventListener("readout", (ev) => {
			const data = (ev as MessageEvent<string>).data;
			if (!data || data === "null") return;
			try {
				gotFirstReadout = true;
				snapshot = JSON.parse(data) as ReadoutSnapshot;
				sseConnected = true;
				loadError = undefined;
			} catch {
				/* ignore malformed frame; the next snapshot replaces the store */
			}
		});
		es.addEventListener("job", (ev) => {
			try {
				jobs = JSON.parse((ev as MessageEvent<string>).data) as JobsPayload;
			} catch {
				/* malformed job event; the poll covers it */
			}
		});
		es.onopen = () => {
			sseConnected = true;
		};
		es.onerror = () => {
			sseConnected = false;
		};

		const tick = setInterval(() => {
			now = Date.now();
		}, 500);
		// The token may still be in the address bar (belt & braces over the 302).
		if (location.search.includes("token=")) {
			history.replaceState({}, "", location.pathname);
		}
		return () => {
			cancelled = true;
			es.close();
			clearInterval(tick);
		};
	});

	// --- the ONE action POST path (dialog confirmations land here)
	async function confirmDialog(result: { prd?: string; note?: string }): Promise<void> {
		const request = dialog;
		dialog = undefined;
		if (!request) return;
		await runAction(actionRequestToBody(request, result, selection));
	}

	async function runAction(body: ActionBody): Promise<void> {
		try {
			const accepted = await postAction(body);
			doneToast(`${accepted.kind} accepted — job ${accepted.jobId}`);
		} catch (err) {
			pushToast("error", (err as Error).message);
		}
	}

	const sleepingTitle = $derived(
		decision.sleeping
			? `until ${decision.sleeping.until !== undefined ? new Date(decision.sleeping.until).toLocaleTimeString() : "?"}` +
				(decision.sleeping.until !== undefined ? ` · resumes in ${msDuration(Math.max(0, decision.sleeping.until - now))}` : "") +
				` · cycle ${decision.sleeping.cycleCount ?? 0} · Resume reruns the loop without re-approval`
			: undefined,
	);
</script>

{#if loadError}
	<div class="banner error">
		<strong>ui could not load a readout:</strong> <span class="mono">{loadError}</span>
	</div>
{/if}

{#if snapshot && jobs}
	<StatusStrip {snapshot} {now} connected={sseConnected} activeJob={decision.activeJob} sleepTitle={sleepingTitle} attachedPid={jobs?.attached?.pid} healthOpen={healthOpen} onToggleHealth={toggleHealth} />
	<ActionBar {snapshot} {jobs} {selection} {planTasks} request={(req) => (dialog = req)} done={doneToast} error={(m) => pushToast("error", m)} />

	<div class="grid-2">
		<div style="display:grid; gap:12px; align-content:start">
			{#if decision.view === "planning"}
				<PlanningView job={decision.activeJob?.kind === "plan" ? decision.activeJob : undefined} {now} attachedElsewhere={!decision.activeJob} />
			{:else if decision.view === "review" && planTasks}
				<PlanReview {planTasks} {selection} />
			{:else if decision.view === "report"}
				<CompletionReport {snapshot} {jobs} {now} onExport={() => void runAction({ kind: "export" })} onOpenDiff={openDiff} />
		<!-- per-task diff access (§8.6) is inside the report -->
			{:else if decision.view === "setup"}
				<section class="panel">
					<div class="panel-header"><span>setup</span><span class="badge ph-empty">no plan</span></div>
					<div style="padding:16px">
						write <span class="mono">{snapshot.prdPath ?? "docs/prd.md"}</span> first, then Plan — the planner stops for review before anything runs.
					</div>
				</section>
			{:else if decision.view !== "monitor"}
				<section class="panel">
					<div class="panel-header"><span>plan review unavailable</span></div>
					<div style="padding:16px" class="muted">full graph needed for the review cards — reopens with the lock free.</div>
				</section>
			{/if}
			<JobList {jobs} {now} onStop={openStopDialog} latestDiffTask={latestDiff} onOpenDiff={openDiff} />
			<HealthPanel health={snapshot.readout.health} open={healthOpen} onToggleHealth={toggleHealth} />
		</div>
		<div>
			<TaskTable tasks={snapshot.readout.tasks} phase={snapshot.readout.phase} onOpenDiff={openDiff} />
			<EventLog rows={snapshot.readout.rows} />
		</div>
	</div>
{:else if !loadError}
	<div class="panel">
		<div class="panel-header">connecting…</div>
		<div style="padding:16px" class="muted">waiting for their first readout snapshot…</div>
	</div>
{/if}

{#if dialog}
	{#key dialog.kind + dialog.title}
		<ActionDialog request={dialog} onConfirm={confirmDialog} onCancel={() => (dialog = undefined)} />
	{/key}
{/if}

{#if sheetOpen}
	{#key sheetOpen}
		<ShortcutSheet onclose={() => (sheetOpen = false)} />
	{/key}
{/if}

{#if drawer}
	<!-- the diff drawer: title bar + the viewer (it owns its data) -->
	<div class="drawer" role="dialog" aria-label={`task diff — ${drawer.task}`}>
		<div class="panel-header">
			<span>diff drawer</span>
			<button class="btn tiny" onclick={closeDiff}>close</button>
		</div>
		{#key drawer.task}
			<DiffViewer task={drawer.task} live={drawer.live} {snapshot} rolledBack={drawer.rolledBack} waves={drawer.waves} />
		{/key}
	</div>
{:else if unknownDrawerTask}
	<!-- a deep link to a task this readout has never had: kind note, not silence -->
	<div class="drawer" role="dialog" aria-label={`diff drawer — no task ${unknownDrawerTask}`}>
		<div class="panel-header">
			<span>diff drawer</span>
			<button class="btn tiny" onclick={closeDiff}>close</button>
		</div>
		<div class="banner">
			<strong>no task <code>{unknownDrawerTask}</code> in this readout.</strong>
			the deep link names a task the current plan doesn't have (it may have been
			re-planned since the link was made). close, or check the task table for the ids that do exist.
		</div>
	</div>
{/if}

<Toasts {toasts} onDismiss={dismissToast} />

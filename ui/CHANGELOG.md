# Changelog — llm-toolkit-001-ui

Manual semver discipline: keep `package.json` version and the newest section
in sync. The UI follows `ui/PRD.md` milestones; the kit's seam it consumes is
`ui/PRD.md` Appendix A.

## 0.4.0 — M3 polish + hardening (health panel, alerts/empty/error states, keyboard + a11y, CI e2e)

- **Health panel** (§7.1): a collapsible `HealthPanel` renders the readout's
  health checks — failing first (errors then warnings), then passing, then
  skipped-in-degraded checks labeled with a `skipped` chip (the engine's "needs
  the lock" / "skipped:" / "degraded read" wording marks them). The header's
  health **dot is now a button** that toggles the panel (aria-expanded), an
  alert text next to it names the first failing check, and a failing
  **error-severity check raises a banner** in the strip. Deep link `#/health`
  opens it; user-driven hash changes keep it in sync. The health payloads are
  unchanged — no new checks in core.
- **Keyboard shortcuts** (§10 floor, M3 full): `Esc` closes the shortcut sheet →
  (dialogs close themselves) → the diff drawer; `/` focuses the event-log
  filter; `?` opens a shortcut sheet listing every binding — and explicitly
  promising there are **no single-key destructive shortcuts**. While typing in
  an input or with Ctrl/Alt/Meta held, none of them fire. Binding decisions
  leak into pure functions (`globalShortcut`, `escapeTarget`, unit-tested).
- **Event log completed** (§7.1): the filter input the PRD always promised is
  now real (case-insensitive match over task(+wave)/kind/verb/detail/reason,
  pure `filterWaveRows`), plus a **pause** control that freezes the tail while
  counting held-back rows, autoscroll preserved, and a `reset` to clear both.
- **Budget bar** (§9): `BudgetBar` — session spend vs ceiling as a read-only
  progressbar (turns red + ⚠ at the ceiling), the wave-warn threshold and spend
  rate spelled out, and the per-model breakdown underneath; the completion
  report gains a per-task spend column. No new endpoints — straight from the
  readout's `usage`.
- **Alerts/empty/error states** (§15.1): every panel has a kind empty state
  (task table, event log incl. filter-no-match + paused-backlog variants, jobs,
  plan review, report, drawer); the diff drawer now phrases its known failures
  in kind words ("no diff yet — the patch persists the moment the task reaches
  done/quarantined", "live preview ended — the wave moved on", "patch unreadable")
  and shows a `loading the patch…` line instead of pulsing blank; a
  **quarantine banner** states the rollback fact + evidence pointers whenever a
  quarantined task exists and no wave is live (the router phase can stay
  `running` after an exited run — the live wave is the freshness signal);
  sleep / degrade banners are unchanged.
- **Accessibility** (§10): global `:focus-visible` outlines, keyboard-only
  traversal tuned (dialog focuses its positive action, the shortcut sheet
  captures focus to its close button), aria labels on the dense tables
  (`aria-label` + `scope="col"` headers), the health dot carries
  `aria-expanded`/`aria-label`, the event log flips `aria-live` off while
  paused, `prefers-reduced-motion` stays honored (no new animations).
- **Testing** (§15.1, F decision): adopted **@testing-library/svelte + jsdom**
  (ui-only devDeps) for six component suites — HealthPanel order/labels,
  ShortcutSheet, Toasts, ActionDialog Esc/confirm, EventLog filter+pause,
  BudgetBar — with state decisions staying in the pure derivations of
  `lib/view.ts` (view.test.ts grew the keyboard/filter/health/budget cases).
  Component testing caught and fixed a real bug: the confirmation dialog's
  **seed effect reset the PRD/handoff fields mid-typing** (its own writes were
  reactively re-applied; it now seeds once per request object).
- **CI** (§16 M3): `.github/workflows/ui.yml` — one pipeline, two jobs: the
  engine suite (root `npm ci` → `npm test` → build) and the ui suites (`npm ci`
  at the root, then ui install/test/typecheck/check/build and the **faux e2e**
  — plan/run jobs, per-task + live diffs, 409, attached-stop 409 — `test:e2e`
  sets `KIT_FAUX=1` itself). Node 22 everywhere (both packages require ≥
  22.19); the ui job builds the kit first because the e2e spawns the real
  `dist/cli.js`.
- **Formal M3 verification finds + fixes** (demo acceptance §15.2/§15.3 against
  slow-gate demo bakes): (1) **stale attached badge** — a terminal-started run
  leaves no job record, so its exit fingerprinted no `job` event and a
  connected client kept "attached · not launched here" until reload; the
  attached run's identity (pid/phase/task) is now part of the job
  fingerprint, with an SSE-jobs regression test. (2) **unknown deep link drew
  nothing** — `#/diff/<task>` for a task the readout never had now renders the
  drawer shell with a kind note (pure `hashDiffTask` + tests). (3) §15.1's
  task-table sorting became a real control: a **status-sort toggle** (plan
  order ⇄ failing-first, pure `sortedTasks` + TaskTable component tests);
  row filtering stays a documented deferral (ui/README).
- Consumed kit seam: **unchanged (0.2.2, A.1–A.3)** — M3 added nothing in core;
  all UI deps remain in `ui/package.json`.

## 0.3.0 — M2 diffs (per-task patches + stats, live in-flight diff)

- **Per-task diff artifacts** (kit seam Appendix A.2): every task that reaches
  `done` gets `.orch/artifacts/task-<id>.patch` + a stats side-car
  `task-<id>.json` written BEFORE delivery; every `quarantined` task keeps its
  `quarantined-<id>-w<N>.patch` and gains the matching stats side-car. The
  patch is **cumulative since the task baseline** (retries never reset the
  tree) and display-oriented: engine-owned paths (`.orch/**`, `router.md`,
  `PROMPT.md`) are excluded and the text is capped at 5 MiB
  (`truncated: true` in stats; rollback stays `restoreTree`, never the patch).
- **Stats side-car shape** (git numstat/name-status vs the baseline):
  `{ task, wave, baselineTreeSha, generatedAt, files: [{ path, status,
  insertions, deletions, binary }], totalInsertions, totalDeletions, bytes,
  truncated }`.
- **Readout diff refs** (Appendix A.3 both modes): `tasks[].diff =
  { task, patch, stats?, bytes, truncated }`; artifact list classifies
  patches/stats as kind `"diff"`; status.json tasks now carry
  `baselineTreeSha` so an attached UI can diff without storage.
- **Diff API** (§11.2 + §11.4): `GET /api/tasks/:id/diff` (patch text + parsed
  stats; `404` when absent), `GET /api/tasks/:id/diff/live` (computed on demand
  vs the task baseline, same exclusions/caps, never persisted, `409` unless the
  task is the current in-flight one), `GET /api/artifacts[:name]` (list / ≤5 MiB
  text / metadata + download for larger), `?download=1` raw attachment for
  patches; names validated `^[A-Za-z0-9._-]+$`, traversal → `400`. The lock is
  never taken for any diff read (side-cars + git plumbing only).
- **Diff drawer** (§7.4/§9): file list with status chips + `+/-` counts, unified
  hunks with add/del/context coloring, lazy per-file expand (first 2000 lines, a
  growth notice), binary/truncated notices with raw download, quarantine patches
  marked **rolled back**, and the label `task diff (cumulative since baseline,
  N waves)`. Open from task rows, completion-report rows, and the jobs panel's
  newest-diff shortcut; deep link `#/diff/<task>` works; `Esc` closes.
- **Live preview**: the in-flight task's drawer shows
  `live preview — may be incomplete` with a manual refresh and one refetch per
  SSE snapshot (event-driven, no polling); an empty diff surfaces the engine's
  note ("nothing changed outside engine-owned paths").
- **Kit fix while landing the seam** (core 0.2.2): the status side-car keeps its
  `wave-running` phase across wave-internal commits (budget/verifier rows), so
  an attached UI's elapsed timer and live diff stay truthful between flushes;
  first-wave quarantines (retryLimit 0) now write their evidence patch (the
  baseline flows through to `quarantine()`).
- Consumed kit seam: **A.2 + A.3** (see root CHANGELOG 0.2.2).


## 0.2.0 — M1 control (detached jobs + plan/approve/run/stop/handoff/verify/export)

- **Detached job runner** (Appendix B): every action is one `llm-toolkit-001`
  invocation as a detached job — the server spawns a small plain-Node runner
  (`server/job-runner.mjs`, argv-only, own process group) which spawns the CLI,
  fd-attaches stdout+stderr to `.orch/ui/jobs/<id>.log`, and atomically writes
  the record (`.orch/ui/jobs/<id>.json`) with the CLI's exit code. The UI
  server is not in the job's process group and can restart independently;
  browser/server death never kills a run.
- **Job records + reattach/stale**: on server start, records whose pid is dead
  become `stale` (dead runners included); history is bounded to the newest 50
  records / 14 days. `/api/jobs` also synthesizes the `attached` entry for a
  terminal-started live run (from `status.json.lockedByPid` + a pid probe) —
  a UI job's own lock holder never shows as attached.
- **Actions POST /api/actions** (`202 { jobId }`, one mutating job at a time):
  `plan` (+ editable PRD path, confirm to replace an existing plan), `run
  --approve` and `run selected (--tasks)` (confirm states the count and the
  quarantined-task warning; no silent run), `resume` (post-sleep rerun without
  `--approve` — the plan stays stamped), `stop` (SIGINT to a UI job's CLI pid
  only; a terminal-started run answers `409` with the terminal hint), `handoff`
  (safe during a run: atomic side-car, serialized against other handoffs),
  `verify --task`, `export`. `plan/run/verify/export` need the free lock else
  `409` with the holder pid/phase (with the readout's brief busy-retry so our
  own snapshot reads never 409 an action).
- **Mutation auth** (Appendix C step 5): session cookie AND the
  `X-Kit-Token` echo (the CSRF companion cookie `kit_ui_csrf` is minted at
  handshake, non-HttpOnly) AND an Origin/Sec-Fetch-Site same-origin check;
  unknown kinds/fields are `400`; argv arrays only, never a shell; the
  action allowlist is hard-coded in `server/actions.ts`.
- **Exit codes surfaced plainly** (§7.3): 0 ok · 42 sleeping (banner with
  countdown + Resume) · 130 interrupted · other failed — as record status
  text, toasts, and the jobs list.
- **Plan review screen** (§8.2): topological cards (spec, acceptance, target
  paths, deps, priority, selectable = deps done/empty), default selection = all
  actionable, Approve & run / Run selected.
- **Phase-aware views**: planning state with elapsed + log tail at exit;
  completion report (tasks done/quarantined, waves, spend vs ceiling,
  wall-clock span, delivery rows, Export, Run again when todo remains).
- **Jobs list** with running/exit/stale chips, log tail on demand, stop button,
  and the attached (not-launch-here) row with Stop disabled.
- **Failure toasts + tab-title badge** for gate/verifier/quarantine/sleep rows
  and failed/interrupted job exits (existing rows never toast after reload).
- **Snapshot extras** read from `.orch/status.json` (never storage): `sleep`
  (armed rate-limit sleep → §8.5 banner) and `prdPath` (Plan prefill).
- **SSE**: new `job` event (list + attached) on spawn/exit/stop; readout
  snapshots unchanged.
- Consumed kit seam: unchanged from M0 (`seam: 1`) — M1 needs no core change;
  the CLI stays the only mutation path (a spawned process, argv-only).

## 0.1.0 — 2026-11-07 — M0 walking skeleton (read-only attach)

- **Status strip**: phase pill (planning / planned / running / complete / no
  plan), current task + wave + locally ticking elapsed timer, budget spent /
  ceiling, `storage` vs `sidecars` (degraded) connection badge, `attached ·
  pid N` badge for runs the UI did not launch, health dot (last-check
  aggregation), `last updated` age.
- **Task table** with status glyphs (+ label), id, title, wave counts,
  dependencies; the in-flight `in_progress` row is highlighted.
- **Event log tail** of `.orch/wave-log.jsonl` (newest last, auto-scroll,
  newest-300 cap in the DOM).
- **Honest degradation**: storage-bound sections hidden under `sidecars` mode
  with the reason shown; `at`/age badge makes staleness visible.
- **Server** (`llm-toolkit-ui`, node built-ins only): loopback bind, per-start
  token → one-time `?token=` handshake → `HttpOnly; SameSite=Strict` cookie →
  `302 /`; `GET /api/readout` (`{ readout, mode, at }`), `GET /api/events` SSE
  (snapshot per change, ≥1/2s while a wave runs, 15s heartbeats), static
  assets without auth; `.orch/lock` acquired per read (brief retry, then
  side-car degradation), never held between requests; no writes to the project.
- **CLI forwarder landed in the kit** (`llm-toolkit-001 ui`, Appendix A.4):
  spawns the `llm-toolkit-ui` bin with inherited stdio/env; prints
  `npm --prefix ui install` when the UI package is absent (exit 1).
- **Packaging**: independent package (Svelte 5 + Vite + TypeScript, vitest,
  tsx for the server shim); own lockfile; NOT a root workspace — the kit's
  dependency footprint is unchanged.
- Consumes the kit's new A.1 seam: `readout.seam = 1`, `readout.live`
  (`startedAt` from the wave-running status flush), wave start/end rows, and
  the newest status.json fields (`startedAt`, `sleepUntil`, generator extras).

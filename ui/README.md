# llm-toolkit-001 ui — local web control surface

A local, loopback-only web control surface for **one** `llm-toolkit-001` loop.
It is a sub-product of the kit: own package, own lockfile, own version/CHANGELOG
(`ui/PRD.md` is the full spec). Scope of **M0**: a truthful, read-only,
attached view of a run started anywhere (terminal first-class). Scope of
**M1**: full control — plan → review → approve & run → stop → handoff →
verify → export, without touching the terminal. Scope of **M2**: diffs as
evidence — per-task patches + stats, quarantine patches, and a live in-flight
preview. Scope of **M3**: operator polish — a health panel,
keyboard shortcuts, the event-log filter, a budget bar, kind empty/error
states, an accessibility pass, and a then-CI pipeline that ran the faux e2e
(removed later at the ship owner's word — see Building/testing).
Scope of **M4-a**: §7.5 conversation visibility — stage 1 (0.5.0) shipped the
summary list + read-only summary drawer; stage 2 (0.5.1) added the bounded
transcript excerpts (Appendix A.5): kind-labeled entry rows, collapsed tool
results, ≤ 2,000-entry window, storage-mode lock-per-read. Scope of **M4-b**
(0.5.2): §7.2's delivery deferral resolved as read-only truth —
the completion report (and the underlying readout, via the additive Appendix
A.6 seam) now shows the configured delivery mode and the delivery outcome
rows; there is deliberately no delivery toggle (see the 0.5.2 CHANGELOG for
the decision). Scope of **M4-c** (0.5.3): the last M4 polish slice before M5 —
the event-log DOM window raised to §13's 2,000 rows with an explicit
truncation notice (the readout still carries the full wave-log tail; no
server-side cap — decision D4 in the 0.5.3 CHANGELOG), and a dense task-table
row filter (text + status chip) closing the §13/§16 deferral. Scope of
**M5-a** (0.6.0): the first M5 slice, deliberately the read
half of the §18 "config/PRD editors" deferral — a `sources` panel (deep link
`#/sources`) shows `.orch/config.toml` and the PRD at its resolved path RAW,
with honest verdict chips (parse error keeps the raw text visible so you can
fix the edit; a missing PRD names the path the plan dialog prefills), real
byte counts, and a stated no-write promise: `GET /api/project/sources` is
read-only in the protocol itself — the UI never writes these files, the CLI
stays the only mutation path (§5; decision D5 in the 0.6.0 CHANGELOG). No
core seam change (`readout.seam` stays 1). Scope of **M5-b** (0.6.1, this
release): the same panel covers the loop's remaining input documents —
`PROMPT.md` (the fixed root file every wave input embeds; absence is amber:
waves still run, just without the per-wave discipline doc, and the panel says
how to fix it) and `evals/recipes.toml` (the gate recipes — the panel reuses
the ENGINE's own gate loader for the verdict, so the shown message is exactly
what the next wave's gate step would throw; an absent file is the runner's
defined "empty gates = scope check only" state, shown green). Same
read-only promise, same static-file/no-lock discipline (a live run reads —
never rewrites — either file), same 5 MiB cap and binary labeling, no new
deps, no core seam change. Scope of **M5-slice-3** (0.7.0, this release):
safe stop for TERMINAL-started runs — the attached Stop affordance ships,
gated behind a full process-identity verification (PRD §7.2.1): live pid,
real working directory, and a command line that names this project's
installed CLI entry followed by a lock-holding subcommand; then EXACTLY ONE
re-verified `SIGINT` — the kit's clean-close path, exit 130, resumable.
Any failed check is a stated plain-words reason and NO signal; SIGTERM and
SIGKILL never happen; Linux-only v1 (the machine needs `/proc`; macOS
variant B stays deferred in §18). No core seam change (`lockedByPid` was
already there; `readout.seam` stays 1), no new deps.

What M1 adds on top of the M0 read (see the M0 list in the 0.1.0 CHANGELOG
entry for the status strip / task table / event log / degradation basics):

- **Actions** — Plan, Approve & run, Run selected, Stop, Handoff, Verify,
  Export in one bar. Every run is a confirm-with-effect dialog (no silent
  run; plan replace is confirmed; approve with quarantined tasks says so).
  Each action spawns the same CLI invocation a human would type — as a
  detached job (Appendix B): the run survives browser AND UI-server death.
- **Jobs list** — one row per record in `.orch/ui/jobs/` (kind, status chip,
  pid, age, log tail, stop). Terminal-started runs show as `attached · not
  launched here`; their row gains `stop (verified)` when the §7.2.1 identity
  check passes, else a stated `⨯ stop unavailable (not verified)` with the
  plain-words reason in the tooltip. Dead-pid records go `stale` on server
  start; history keeps the newest 50 records / 14 days.
- **Plan review** — topological task cards with spec, acceptance, target
  paths, deps, priority; selectable when dependencies are done/empty;
  Approve & run waves all todo tasks, Run selected waves the checked subset.
- **Phase views** — planning (elapsed + job log at exit), completion report
  (tasks, waves, spend, wall clock, delivery mode + outcome rows [§8.6, A.6
  — read-only; no toggle: delivery is a config + CLI decision, editors
  deferred to M5], Export, Run again when todo tasks remain), sleep banner
  (exit 42) with countdown + Resume.
- **Failure surfacing** — toasts for gate fails / verifier rejections /
  quarantines / provider-reset sleeps / failed or interrupted job exits,
  plus a tab-title badge; job records show exit codes plainly
  (0 ok · 42 sleeping · 130 interrupted · other failed).
- **Safety** (Appendix C step 5) — mutations need the session cookie AND the
  `X-Kit-Token` echo (a non-HttpOnly companion cookie minted at handshake)
  AND a same-origin Origin/Sec-Fetch-Site check; one mutating job at a time;
  the CLI response equivalent. The CLI is still the only mutation path —
  the UI spawns it with argv arrays and never re-implements the engine.

What M2 adds on top of M1 control (kit seam genome A.2/A.3 → root 0.2.2):

- **Per-task diffs** — every `done` task has `task-<id>.patch` +
  `task-<id>.json` (files, statuses, +/- counts, bytes, truncated); every
  `quarantined` task keeps its wave patch and gains the side-car. The patch
  is cumulative since the task baseline and never a rollback input; engine
  paths (`.orch/**`, `router.md`, `PROMPT.md`) and anything past 5 MiB are
  excluded/capped by the engine itself.
- **Diff drawer** — file list (status chip + `+N −M I`) + unified hunks with
  line coloring, lazy per-file, 2000-lines/file cap, binary/truncated notices,
  raw download; deep link `#/diff/<task>`; `Esc` closes. Open from task rows,
  completion-report rows, and the jobs panel's newest-diff shortcut.
- **Live preview** — while a task's wave runs, a dashed **live** button opens
  the same drawer marked `live preview — may be incomplete`, refetching on each
  SSE snapshot; computed on demand vs the task's baseline, never persisted,
  `409` with the current holder named unless the task is in flight.

What M3 adds around that core (§16 M3 polish):

- **Health panel** — the header health dot is a button: click it (or deep link
  `#/health`) to open the collapsible panel. Failing checks come first (errors,
  then warnings), passing checks follow, skipped-in-degraded checks are labeled
  `skipped` (`storage-skip`, mirror parity, sha-drift checks that need the
  lock). An error-severity check also raises a banner in the strip, and an
  alert text beside the dot names the first failing check. The payloads are the
  kit's own `inspect --health` semantics — the UI adds no checks.
- **Keyboard** — `Esc` closes sheet/dialog/drawer, `/` focuses the event-log
  filter, `?` opens the shortcut sheet. No single-key destructive shortcuts;
  every effect-bearing action keeps its confirmation dialog. While typing or
  with modifier keys held, none of the global keys fire.
- **Event log** — filter (task/kind/verb/detail/reason, case-insensitive),
  pause (freezes the tail, counts held-back rows), reset, autoscroll.
- **Budget bar** — read-only session spend vs ceiling (red at the ceiling)
  with the wave-warn threshold, the per-wave rate, and a per-model breakdown;
  the completion report adds a per-task spend column.
- **Kind empty/error states** — every panel (table, log, jobs, plan review,
  report, drawer) has a plain-words empty state; the diff drawer explains its
  404/409/unreadable outcomes kindly; a quarantined task with no live wave
  raises a rollback-fact banner; a `#/diff/<task>` deep link to a task the
  readout has never had draws an explanation instead of nothing.
- **Task-table sort (§15.1)** — one toggle: plan order (stable while the run
  progresses) or failing-first by status (quarantined → in progress → todo →
  done, stable within a status). Row filtering shipped in 0.5.3 (M4-c, below).

### Model readiness + failed-job reasons (0.4.1, M4-entry approval feedback)

- Every action dialog that needs a model (plan, approve & run, run selected,
  resume) shows the configured role models as chips and refuses to start —
  disabled button + a paste-ready TOML block — when the needed block is
  missing or the config is unreadable. The server answers `422` first:
  no doomed job, no exit-code mystery.
- A failed/stale/42 job's payload carries its log's last meaningful lines
  (ANSI stripped): the toast quotes the first diagnostic line and the jobs
  panel shows it inline. Hovering a row gives the whole bounded tail.
- The UI still never writes `.orch/config.toml` (CLI-only mutation rule):
  the dialog tells you exactly which block to add and where, then re-reads
  it on the next snapshot.

### Conversation summaries (0.5.0, M4-a stage 1 — §7.5)

- **List panel** — a collapsible panel (deep link `#/conversations`, sibling of
  `#/health`) renders the readout's conversation summaries: role chip,
  entry counts with a compact by-kind breakdown, resets/compactions, tool
  rounds, a `truncated` chip when the entry scan hit its cap (counts are a
  floor), and per-conversation USD + tokens. Groups follow the data:
  planner → one group per task (several implementer conversations can map to
  one task; group order follows the task table) → verifier → other.
- **Summary drawer** — row click opens the read-only drawer in the diff
  drawer's shell (same `Esc` chain + `#/conversations/<id>` deep link): the
  counters, the by-kind table, target paths, spend + tokens — and it
  highlights the linked task row in the task table.
- **Transcript excerpts (0.5.1, stage 2 — Appendix A.5)** — the drawer's lower
  half is the bounded transcript itself: kind-labeled rows (`user`,
  `assistant · write`, `tool-result · failed`), wall-clock timestamps, stop
  reasons, tool calls with their JSON input, and **tool results collapsed**
  behind a show/hide button. The bounds are the contract and say so when they
  bite: the excerpt keeps the **newest ≤ 2,000 entries** (older ones cut — no
  pagination in v1) and each entry's text/tool input is cut at **4 KiB**;
  thinking blocks stay model-internal and never render. Stage 1 shipped with
  no kit.ts imports; stage 2 consumed only the inspector-level A.5 callable —
  the UI server still never imports kit.ts.
- **Storage-mode only, kind about it** — under `sidecars` (a run owns the
  lock) the panel and drawer say "conversation detail returns when the lock
  is free — a run is live"; no spinner — the SSE re-snapshot fills them in.
  The excerpt endpoint (`GET /api/conversations/:id/entries`) takes the same
  lock-per-read window as `/api/readout` and answers `409` in that tone if a
  run grabs the lock mid-view; the next free read fills the excerpt back in.

### Delivery truth (0.5.2, M4-b — §7.2/§8.6, Appendix A.6)

- The report's delivery stat says the CONFIGURED MODE, not just a row count:
  `none` (delivery off — the default), `commit`, `pr`, or
  `N delivery row(s) — mode unknown` (side-car snapshot + unreadable
  config). The outcome tail lists engine verbs verbatim: `delivered`,
  `commit-failed`, `pr-failed`, `pr-skip` (mode `pr` without `--deliver`).
- **Read-only on purpose.** Per §5 delivery stays a config + CLI decision:
  the mode lives in `.orch/config.toml` and the CLI keeps every delivery
  path — including the `--deliver` run qualifier the `pr` mode requires. A
  UI toggle would either be a config editor (M5) or silently change what a
  human would have typed for the same run, so none exists; the deferral is
  stated in the report itself, the PRD (Appendix A.6), and the CHANGELOG.

### Event-log window + task-table filter (0.5.3, M4-c — §13, §7.1)

- **Event-log window raise (§13)** — the DOM window the M3 record deferred
  (300) is raised to §13's **2,000 rows** (windowed, no virtualization —
  §13 accepts either). The cut is never silent: the header counts
  `truncated — showing newest 2,000 of M` and an in-log notice names the
  hidden count, states that the readout carries the full wave-log tail
  (**no server-side cap** — decision D4, 0.5.3 CHANGELOG: a cap would skew
  the report's wall-clock span the moment a log outgrows it), and points at
  the filter and `.orch/wave-log.jsonl` for the complete paper trail. Pure
  `windowedTail`/`EVENT_LOG_DOM_WINDOW` in `lib/view.ts` own the numbers.
- **Task-table row filter (§7.1)** — closes the §13/§16 deferral with a
  dense toolbar sibling of the event log's: a case-insensitive text match
  (id, title, dependsOn, target paths) + a status chip (`all statuses` +
  the four concrete ones). The header counts `tasks (N of M)`, a `reset`
  button appears while a filter is active, and a no-match row names both
  active constraints. Pure `filterTasks` owns the math; it composes with
  the sort toggle. No new global keys: typing in the inputs already
  suppresses `/`/`?` (the `typing` guard) and the Esc chain is untouched.

### Performance window + deferred bits (§13/§16 deferrals, M3 exit record)

- The event log keeps the **newest 2,000 rows in the DOM** — §13's windowed
  tail (M4-c/0.5.3 raised it from M3's 300; §13 accepts "virtualized or
  windowed" and no virtualization ships). When the window bites, the cut is
  explicit: the header says `truncated — showing newest 2,000 of M` and an
  in-log notice names the hidden count plus the honest server-side truth —
  the readout carries the **full wave-log tail, no server-side cap** (D4:
  a cap would skew the report's wall-clock span the moment a log outgrows it,
  so it stays unscoped until one does).
- Task-table row **filtering** shipped in 0.5.3 (a dense toolbar: text match
  over id/title/deps/target paths + a status chip, a counted header, a kind
  no-match state, composing with the sort toggle). Safe stop for attached
  runs shipped in 0.7.0 (§7.2.1, decision D6); per-wave isolated diffs stay
  in the PRD's §18 deferred list.
  Conversation **summaries** shipped in 0.5.0 and transcript **excerpts** in
  0.5.1 (list + drawer above) — the §18 "read-only conversation transcript
  drawer" fast-follow is now fully landed via the Appendix A.5 seam (bounded
  excerpts; conversation *search* and full-history paging remain unscoped).
- Sleep/exit-42 is exercised where it can be honestly reproduced: the
  engine's durable-sleep + fake-clock resume tests (root suite) and the
  view-contract's sleep banner/resume/exit-code mapping (ui suite). A
  full demo-tray incident needs a live provider rate limit — faux replays
  always answer, so the drawer cannot fabricate one.
- The attached terminal-run leaves no job record, so its attach/exit is
  fingerprinted into `job` SSE events too — a connected client sees the
  attached badge appear and clear instead of carrying a stale one until reload.

## Run

From the **kit repo root** (the UI reads the kit engine through `../../src`):

```bash
npm --prefix ui install       # once; creates ui/package-lock.json
npm --prefix ui run build     # client bundle into ui/dist
llm-toolkit-001 ui            # forwarder; spawns llm-toolkit-ui with your args
# or directly:
npm --prefix ui exec -- llm-toolkit-ui --no-open --port 4517 --project /path/to/project
```

`llm-toolkit-001 ui` resolves the `llm-toolkit-ui` bin (kit-repo `ui/node_modules/.bin`,
then the cwd, then `PATH`) and spawns it with inherited stdio/env — a process
boundary, no import cycle. Without the UI package: it prints
`npm --prefix ui install` and exits 1.

The server:

- binds `127.0.0.1` only; default port ephemeral (`--port 0`), `--port n` to pin;
- prints (and opens, unless `--no-open`) `http://127.0.0.1:<port>/?token=<token>`;
- the `?token` handshakes **once** for an `HttpOnly; SameSite=Strict` cookie,
  then `302 /` (the client also strips it from the address bar);
- API + SSE require the cookie; missing/invalid → `401` with the plain
  "reopen the URL printed by llm-toolkit-ui" message; a server restart mints a
  new token and invalidates old sessions;
- reads the project `--project <dir>` (default: cwd); missing
  `.orch/config.toml` → the CLI's error + exit 1, no UI.

## Commands

```bash
npm --prefix ui install          # deps + package-lock.json (own, never a root workspace)
npm --prefix ui run dev          # build client, then start the API server (dev loop)
npm --prefix ui run build        # vite build → ui/dist
npm --prefix ui test             # vitest: server contract + auth + sse + actions/jobs + client logic + components
npm --prefix ui run typecheck    # tsc over server/ + src/lib + test (kit engine included)
npm --prefix ui run check        # svelte-check (components)
npm --prefix ui run test:e2e     # real-CLI faux e2e: plan/run jobs end to end (sets KIT_FAUX=1)
```

`npm --prefix ui test` and `typecheck` do not need the client build; hitting the
UI in a browser needs `npm --prefix ui run build` first (vite app → `ui/dist`).

### Testing policy (M3, §15.1)

Two layers, both in `test/`:

- **Pure derivations** (`lib/view.ts` + friends) are the backbone: view
  decision, plan-selection math, diff-drawer state, failure rows toasts, and —
  since M3 — health ordering, event-filter matching, keyboard-binding
  decisions (`globalShortcut`, `escapeTarget`), and budget-bar math. No DOM,
  unit-tested directly.
- **Component tests with @testing-library/svelte (+ jsdom, ui devDeps)** cover
  the markup the derivations cannot: HealthPanel order/labels, ShortcutSheet,
  Toasts dismissal, ActionDialog Esc/confirm keys, EventLog filter+pause+window
  notice, BudgetBar, and the TaskTable sort toggle + row filter. They mount in vitest via a per-file
  `// @vitest-environment jsdom` docblock; `test/components-*.test.ts` names
  them. (The plan-review/App compositions stay covered by the e2e.)

The faux e2e (`test-e2e`) rides the real CLI in a baked demo project and is
kept out of default `npm test` (it is gated on `KIT_FAUX=1` and runs as
`test:e2e`).

## How it reads the loop

- `GET /api/readout` + `GET /api/events` (SSE) return **one** `KitReadout`
  (the kit's `readout()` seam) wrapped as `{ readout, mode, at }`:
  - `mode: "storage"` — the lock was free: durable truth, full sections;
  - `mode: "sidecars"` — a live run holds `.orch/lock`: only the atomic
    side-cars (`.orch/status.json` + `.orch/wave-log.jsonl` + artifacts).
  The lock is acquired per read, retried ~three times over ~half a second
  around a run's start/exit, then degrades. It is never held between requests.
- Mutations do NOT go through the lock: `POST /api/actions` spawns one detached
  CLI job (`.orch/ui/jobs/<id>.json` + `.log`). plan/run/verify/export need a
  free lock (the server probes it with the same brief retry, then answers 409
  with the holder pid/phase); handoff rides the atomic side-car and is safe
  during a run; stop signals a UI job's CLI pid — or, `target: "attached"`,
  a terminal-started run after the §7.2.1 identity verification (one
  re-verified SIGINT; every failed check is a reason, never a signal). On
  server start, dead-pid
  records are marked stale (history: newest 50 / 14 days). Job env is inherited
  from the server (KIT_FAUX*, provider keys) and no secrets land in records.
- The SSE hub watches `.orch/status.json`, `.orch/wave-log.jsonl` and
  `.orch/artifacts/` (fs.watch + 1s fallback poll, debounced): one full snapshot
  per change, at least one every 2s while a wave runs, heartbeats every 15s.
- The live elapsed timer ticks client-side from `readout.live.startedAt`
  (the A.1 seam field), so a quiet side-car never freezes the strip.
- Compatibility with an older kit (no `readout.seam = 1`): degraded with a
  visible warning (the strip shows the kit's age from `identity.kit`); the UI
  requires the seam for the live strip to be exact.

## Layout

```
ui/
  PRD.md, README.md, CHANGELOG.md, package.json, package-lock.json
  bin/llm-toolkit-ui.js        # bin shim: tsx register → server/cli.ts
  server/                      # node:http only (no runtime deps)
    cli.ts                     # bin entry: args, token, config check, open
    server.ts                  # routes: handshake, /api/readout, /api/events, static
    auth.ts                    # token↔cookie primitives (Appendix C)
    readout.ts                 # lock-per-read acquisition + degrade
    sse.ts                     # watch/poll snapshot hub
    static.ts                  # built-asset serving (inert, no auth)
    browser.ts                 # best-effort --no-open-able opener
  src/                         # Svelte 5 client (vite build)
    App.svelte, main.ts, lib/{api,format}.ts, components/, styles/app.css
  test/                        # vitest server contract + auth + sse + actions/jobs + components + e2e
```

No hosted CI (the M3 workflow was removed at the ship owner's word): the
suites run by hand — the kit's engine suite (root `npm test` + `npm run
build`) and the ui sub-product (`test`, `typecheck`, `svelte-check` via
`check`, `build`, and the faux e2e, which builds the kit first because it
spawns the real `dist/cli.js`). Node 22 — both packages require ≥ 22.19.

Node ≥ 22.19 (same as the kit). Everything is local-machine only — loopback,
one user, no TLS — exactly as scoped in `ui/PRD.md` §12 for v1.

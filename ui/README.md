# llm-toolkit-001 ui — local web control surface

A local, loopback-only web control surface for **one** `llm-toolkit-001` loop.
It is a sub-product of the kit: own package, own lockfile, own version/CHANGELOG
(`ui/PRD.md` is the full spec). Scope of **M0**: a truthful, read-only,
attached view of a run started anywhere (terminal first-class). Scope of
**M1**: full control — plan → review → approve & run → stop → handoff →
verify → export, without touching the terminal. Scope of **M2**: diffs as
evidence — per-task patches + stats, quarantine patches, and a live in-flight
preview. Scope of **M3** (this release): operator polish — a health panel,
keyboard shortcuts, the event-log filter, a budget bar, kind empty/error
states, an accessibility pass, and a CI pipeline that runs the faux e2e.

What M1 adds on top of the M0 read (see the M0 list in the 0.1.0 CHANGELOG
entry for the status strip / task table / event log / degradation basics):

- **Actions** — Plan, Approve & run, Run selected, Stop, Handoff, Verify,
  Export in one bar. Every run is a confirm-with-effect dialog (no silent
  run; plan replace is confirmed; approve with quarantined tasks says so).
  Each action spawns the same CLI invocation a human would type — as a
  detached job (Appendix B): the run survives browser AND UI-server death.
- **Jobs list** — one row per record in `.orch/ui/jobs/` (kind, status chip,
  pid, age, log tail, stop). Terminal-started runs show as `attached · not
  launched here` with Stop disabled (the UI cannot verify what it would
  signal). Dead-pid records go `stale` on server start; history keeps the
  newest 50 records / 14 days.
- **Plan review** — topological task cards with spec, acceptance, target
  paths, deps, priority; selectable when dependencies are done/empty;
  Approve & run waves all todo tasks, Run selected waves the checked subset.
- **Phase views** — planning (elapsed + job log at exit), completion report
  (tasks, waves, spend, wall clock, delivery rows, Export, Run again when
  todo tasks remain), sleep banner (exit 42) with countdown + Resume.
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
  done, stable within a status). Row filtering stays a §13/§16 deferral.

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

### Performance window + deferred bits (§13/§16 deferrals, M3 exit record)

- The event log keeps the **newest 300 rows in the DOM** (a plain windowed
  tail, no virtualization). §13's 2,000-row DOM window is deferred together
  with the virtualization work — 300 keeps sub-second SSE updates snappy on
  the dense table, and pause/pending counting hides nothing from the tail.
- Task-table row **filtering**, conversation drawers, per-wave isolated
  diffs, and safe stop for attached runs stay in the PRD's §18 deferred list.
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
  Toasts dismissal, ActionDialog Esc/confirm keys, EventLog filter+pause,
  BudgetBar, and the TaskTable sort toggle. They mount in vitest via a per-file
  `// @vitest-environment jsdom` docblock; `test/components-*.test.ts` names
  them. (The plan-review/App compositions stay covered by the e2e.)

The faux e2e (`test-e2e`) rides the real CLI in a baked demo project and is
kept out of default `npm test` (it is gated on `KIT_FAUX=1` and runs as
`test:e2e`; CI runs it in the `ui` job — see `.github/workflows/ui.yml`).

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
  during a run; stop signals a UI job's CLI pid only. On server start, dead-pid
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

CI (`.github/workflows/ui.yml`, added in M3): one pipeline, two jobs — the
kit's engine suite (install + test + build at the root) and the ui sub-product
(install, test, typecheck, svelte-check, build, and the faux e2e, which builds
the kit first because it spawns the real `dist/cli.js`). Node 22 — both
packages require ≥ 22.19.

Node ≥ 22.19 (same as the kit). Everything is local-machine only — loopback,
one user, no TLS — exactly as scoped in `ui/PRD.md` §12 for v1.

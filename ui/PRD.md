# PRD — llm-toolkit-001 web UI

Status: draft for implementation · 2026-11-07
Owner: Ivan
Ship target: `ui/` sub-product, independent version from the loop kit

## 1. Summary

A local web control surface for one `llm-toolkit-001` loop. It answers three
questions without a terminal: **where is the loop, what needs a human, and what
did the agents actually change?**

The UI is a sub-product. It does not change loop semantics, config format, or
command behavior. It reads the loop's existing visibility output and invokes the
existing CLI. The only core changes are an explicitly versioned, additive "UI
seam" (Appendix A).

## 2. Problem

The loop is intentionally terminal-first, but the human loop is not a terminal
activity:

- `plan` stops for review in `router.md`; the review is a graph of tasks,
  dependencies, acceptance criteria, and target paths — awkward as prose.
- During `run`, the interesting state is spread across `router.md`,
  `.orch/wave-log.jsonl`, gate logs, verifier verdicts, `.orch/status.json`,
  and git state. `status --follow` gives a coarse panel; `inspect` is a
  snapshot.
- After a wave, knowing *what the agent changed* means reconstructing a diff
  from the task baseline or reading gate output.
- A quarantined task rolls the tree back; the evidence is a patch file and a
  wave-log row.
- Watching a run means babysitting a terminal, and switching context to check
  cost or the current task.

The CLI does all of this correctly; it just does not present it as one
operation surface.

## 3. Users and jobs

Primary user: the developer running one loop locally, on the same machine as
the repo and the provider credentials.

Jobs, in priority order:

1. Review a plan and decide whether to approve it (and which tasks to run).
2. Watch a live run: current task/wave, elapsed, spend, gate and verifier
   outcomes, failures.
3. Inspect what an implementer agent changed (per-task diff), especially after
   a failed wave or quarantine.
4. Intervene: handoff note, one-off verify, stop, export, resume after a
   provider-reset sleep.
5. Do all of the above for a run started in a terminal, not only one started
   from the UI.

## 4. Goals

- One phase-aware page that makes "where are we / what needs a human / what
  happens next" obvious.
- Full plan → review → approve & run flow without a terminal.
- Truthful live state for both UI-launched and terminal-launched runs.
- Per-task diffs, quarantine patches, and a live in-flight diff.
- Actions with exactly the CLI's semantics and safety (lock, exit codes,
  durability, resume).
- Local-only by construction: loopback bind, per-session token, no secrets in
  the browser.

## 5. Non-goals (v1)

- Editing `router.md`, `docs/prd.md`, `.orch/config.toml`, `PROMPT.md`, or
  `evals/recipes.toml` from the UI.
- Creating, deleting, or reordering tasks; overriding the planner's graph.
- Delivery override (`commit` / `pr`); delivery stays a config + CLI decision.
- Multi-project, project switcher, remote/LAN/Tailscale, mobile.
- User accounts, multi-user, shared servers.
- Live conversation token streaming or conversation search (the conversation
  list stays summaries; the drawer serves bounded read-only excerpts —
  Appendix A.5, shipped in 0.5.1).
- Editing git state, resolving conflicts, staging, or committing outside
  the CLI's delivery path.
- Browsing the durable SQLite store directly.
- Replacing the CLI. The CLI remains the engine/automation interface.

## 6. Product principles

1. **Attach first.** A run is a first-class thing whether it was started by
   the UI or by a terminal. The UI must work while a run holds the lock.
2. **The CLI is the contract.** Mutations spawn the CLI with the same flags a
   human would type. No reimplementation of the wave driver, gates, verifier,
   governor, or delivery in the server.
3. **Show truth, mark degradation.** Storage-mode and side-car-mode data look
   different; the UI says which one it is showing (and why) rather than
   pretending.
4. **Density over decoration.** This is an operator console. Tables,
   monospace, status glyphs + labels, restrained color.
5. **Diffs are evidence.** Every completed or quarantined task has a durable,
   viewable diff; the in-flight wave has a clearly-marked live preview.
6. **Nothing surprising.** No auto-approve, no auto-run, no hidden writes, no
   destructive action without a confirmation.

## 7. Scope (v1)

### 7.1 One phase-aware page

A single page, one project per server process, resolved from the `cwd` passed
to the command (default: current directory).

Persistent header:

- project path and kit/pi-durable versions;
- phase pill: `empty | planned | running | complete | blocked | quarantined |
  sleeping | planning`;
- current task + wave + local elapsed timer, when running;
- budget: spent / session ceiling, wave-warn threshold, spend rate;
- connection badge: `storage` (full readout) or `sidecars` (degraded, run owns
  the lock), plus `attached to pid N` when the run was not started by this UI;
- health dot (from `inspect --health` semantics) and alert text;
- actions: Plan, Approve & run, Run selected, Stop, Handoff, Verify, Export.

Main area, by phase:

| phase | main area |
| --- | --- |
| empty / no PRD | setup state: expected PRD path, `init` hint, Plan disabled until a PRD exists |
| planning | planning state: elapsed, cancel hint, last log line |
| planned | plan review: task cards in topological order, dependency chips, spec, acceptance, target paths, priority, selection checkboxes, Approve & run CTA |
| running / sleeping | live monitor: status strip, task table with current row highlighted, wave timeline, event log tail, current-task drawer |
| complete / blocked / quarantined | report: summary, spend, per-task outcomes, quarantine cards, export, "run again" |

Always available, non-modal:

- task detail drawer (task table row click);
- diff drawer (task or quarantine patch);
- event log panel (wave-log tail, filter by task/kind, pause, autoscroll);
- health panel (collapsible; errors and warnings first);
- notification stack (in-page toasts) and tab-title badge.

No router library. Hash deep links only:
`#/task/<id>`, `#/diff/<task>`, `#/plan`, `#/health`.

### 7.2 Actions

The UI exposes exactly these mutations. Every one maps to a CLI invocation
(spawned as a child process, never imported).

| action | CLI equivalent | enabled when | notes |
| --- | --- | --- | --- |
| Plan | `plan [--prd path]` | no run active; router empty, or explicit replace confirmation | phase `planning` while it runs |
| Approve & run | `run --approve` | router planned/running; no other run active | the human approval stamp |
| Run selected | `run --approve --tasks <ids…>` | plan reviewed; selection non-empty | subset of `todo` tasks |
| Stop | SIGINT to the active job | a running UI job, or a terminal-started run whose §7.2.1 identity verification passes | graceful; state stays resumable (exit 130); exactly one re-verified signal |
| Handoff | `handoff "<note>"` | always (atomic side-car, safe during a run) | queued for the next wave |
| Verify | `verify --task <id>` | no run active; task has a baseline | one-off read-only check |
| Export | `export` | no run active | writes `.orch/artifacts/report.{json,html}` |

Guardrails:

- No config, router, PRD, or delivery editing.
- `run` always passes `--approve` from the Approve & run / Run selected
  buttons; there is no silent run.
- Stop for a terminal-started run is offered only through the §7.2.1
  verification; an unverifiable holder is never signalled — the UI states the
  plain-words reason, and "stop it from its terminal" stands.
- Destructive-looking actions (Plan replace, Approve & run with quarantined
  tasks in the graph) require a confirmation dialog that states the effect.

### 7.2.1 Verified attached stop (M5-slice-3; Linux-only v1)

A terminal-started run may be stopped from the UI only when its process
identity verifies. The check runs server-side, straight off the operating
system, with NO seam change: `.orch/status.json` already carries
`lockedByPid`, and `/proc` carries the rest. ALL of the following must pass;
every failure answers with its plain-words reason and sends NO signal:

1. **Holder truth** — a FRESH `.orch/status.json` read names `lockedByPid`
   pid N, and N is alive (`kill(pid, 0)`, the signal-0 probe; a
   `/proc/<pid>` existence probe where `/proc` exists). N is neither this UI
   server's own pid (a brief readout window can flash there) nor a pid a
   running UI job record claims (that is the ordinary Stop).
2. **Platform** — `/proc` exists (Linux). macOS variant B — the runner
   recording `{pid, argv, startedAt}` into `status.json` — is deferred
   (§18); without `/proc` the deeper checks refuse (501) and the UI says so.
3. **Working directory** — `/proc/<pid>/cwd` realpath equals the project
   root. Failure text: "pid N is alive but its working directory is X, not
   this project".
4. **Command identity** — `/proc/<pid>/cmdline` argv contains exactly ONE
   token after `argv[0]` whose realpath equals the CLI entry this UI resolves
   for spawning its own jobs (the same chain: explicit bin override → the
   project's `.bin` → the kit's `dist/cli.js` → PATH → tsx; relative tokens
   resolve against the verified cwd), and the token immediately following it
   is a lock-holding subcommand (`plan` or `run`). Required tokens: the entry
   token and that subcommand token. NOT required: any other token — flags,
   task lists, the node interpreter, `argv[0]` form. Anything else visible in
   the argv is ignored.
5. **One re-verified signal** — immediately before signalling, the full check
   re-runs (the run may have exited, or the holder may have changed between
   the browser's confirmation and now); then exactly one `SIGINT` is sent —
   the kit's SIGINT clean-close path (exit 130, resumable). SIGTERM and
   SIGKILL are never sent. A check that fails on the second round answers
   "… nothing was signalled".

Lock-busy/staleness never auto-kills anything (§17): a stale or missing
holder, a changed pid, or a dead process stops every attempt at the check
that failed. The UI enables the attached Stop affordance only when the
latest `/api/jobs` payload reports the verification ok (that payload carries
the pid + command the confirm dialog shows); the POST re-verifies and is the
authoritative gate.

### 7.3 Run lifecycle

- **Launch:** spawn a detached job (Appendix B). The child keeps running if the
  browser or UI server closes.
- **Attach:** discover a live run from `.orch/status.json` (`lockedByPid`) and
  the wave log; display it identically to a UI-launched run, except for the
  "attached" badge; Stop follows the §7.2.1 verification.
- **Reattach:** on UI server start, scan job records; a job whose PID is alive
  is `running`, otherwise `stale` with its last exit code if recorded.
- **Sleep:** exit code 42 is surfaced as a distinct `sleeping` state with
  `sleepUntil` countdown when available, and a "Resume" action (= `run`, no
  `--approve` needed if already stamped).
- **Exit codes:** 0 complete/stopped-short, 42 sleeping, 1 error, 130
  interrupted. The UI maps them to plain-language states; it never hides a
  non-zero exit.

### 7.4 Diffs

- **Per task (durable):** when a task reaches `done` or `quarantined`, the
  engine persists a patch of the working tree vs the task's `baselineTreeSha`
  plus a stats side-car (Appendix A.2).
- **Quarantine:** the existing `quarantined-<task>-w<N>.patch` is shown in the
  same viewer with a "rolled back" badge.
- **Live (in-flight):** while a wave is running, the UI can request a diff of
  the current tree vs the task baseline. It is marked "live preview — may be
  incomplete" and is never persisted.
- **Content:** file list with status (added/modified/deleted) and insertions /
  deletions; unified hunks with syntax-neutral line coloring; binary and
  oversized entries show stats + a notice, not content.
- **Exclusions:** engine-owned paths (`.orch/**`, `router.md`, `PROMPT.md`)
  are excluded from display and stats.
- **Semantics:** because retries do not reset the tree, the per-task patch is
  cumulative since the task baseline (all attempts), not "only the last wave".
  The UI labels it "task diff" and shows the wave count.
- **Wave scope (A.7, shipped 0.8.0):** when a wave's rows carry recorded
  trees, the drawer offers that wave's own delta — the difference between
  the wave's start and end trees — labeled "wave N — isolated to this
  wave". Computed on demand, never persisted; not isolatable (older rows,
  failed capture, still-running wave) answers a plain-words refusal; the
  cumulative view stays the default.

### 7.5 Conversation visibility

- Conversation list with role (planner/implementer/verifier), task id, entry
  counts, resets, tool rounds, and per-conversation USD.
- Clicking a conversation opens its read-only drawer (and highlights its
  task): the stage-1 summary plus the A.5 bounded transcript excerpt
  (newest ≤ 2,000 entries, per-entry text capped, tool results collapsed;
  the caps state themselves in the drawer copy). Never a chat client.
- The verifier only receives a diff stat + changed-file list from the engine;
  the UI must not imply it saw the full patch.

### 7.6 Local-only operation

- Bind `127.0.0.1` only; no `0.0.0.0`, no LAN, no TLS in v1.
- Per-session random token; the opened URL carries it once and is exchanged
  for an `HttpOnly; SameSite=Strict` cookie (Appendix C).
- Default port: ephemeral (0), printed in the terminal; `--port` to pin.
- Open the browser automatically unless `--no-open`; failure to open prints the
  URL.
- No provider credentials reach the browser. The UI server inherits the
  environment it was started with (same as the CLI).

## 8. UX flows

### 8.1 Cold start

1. `llm-toolkit-ui` (or `llm-toolkit-001 ui`) in the project root.
2. Missing `.orch/config.toml`: same plain-words error as the CLI, with the
   `init` command; exit 1. No UI.
3. Config exists but no PRD: page opens in setup state; Plan disabled with the
   expected path; everything else read-only/empty.
4. Config + PRD: Plan enabled.

### 8.2 Plan review

1. Click Plan (PRD path prefilled from config, editable path input).
2. `planning` state; live "still working" + elapsed.
3. On success: plan review. Tasks are ordered topologically; each card shows
   id, title, spec, acceptance, target paths, dependencies, priority, and
   whether it is selectable (dependencies `done`/empty).
4. Selection defaults to all tasks whose deps are satisfied. "Approve & run"
   confirms the count; "Run selected" runs the checked subset.
5. On planning failure: error state with the CLI's message, a retry button, and
   the log tail.

### 8.3 Live run

- Header shows current task/wave and an elapsed timer that ticks locally.
- Current task row is highlighted; completed rows keep their verdict/outcome.
- Wave timeline shows started/ended spans with outcome; a running span grows.
- Event log streams new rows; filters and pause.
- Current task drawer: spec, acceptance, target paths, feedback history, last
  gate summary, verifier verdict, live diff button.
- A failed gate or verifier rejection raises a toast; the task keeps its
  feedback rows so the next wave is explainable.

### 8.4 Quarantine

- Task turns red with a "quarantined" badge; the drawer explains the cause,
  shows the patch, the baseline sha, and the rollback fact.
- Dependent tasks blocked by it are marked as blocked-by-dependency.
- Available next actions: Handoff, Verify, Export; there is no "retry
  quarantined" in the loop, and the UI must not invent one.

### 8.5 Sleep (exit 42)

- Distinct sleeping banner with `sleepUntil` + countdown when available, and
  the cycle count.
- Resume action runs the CLI again; the durable sleep task resumes without
  losing state.
- The page stays live via side-cars while sleeping.

### 8.6 Completion

- Summary: tasks done/quarantined, waves, total spend vs ceiling, wall-clock
  span, delivery mode/outcome rows.
- Per-task diff access; Export button; "Run again" (only if todo tasks remain).

## 9. UI inventory

- `AppShell` — layout, header, notification stack, drawer host.
- `StatusStrip` — phase, current task/wave/elapsed, budget bar, connection and
  attach badges, alert.
- `PhaseView` — switches setup / planning / review / monitor / report.
- `TaskTable` — dense rows: status glyph + label, id, title, deps, waves,
  spend, last outcome; keyboard-navigable.
- `TaskCard` (plan review) — selection, spec, acceptance, target paths, deps.
- `TaskDrawer` — metadata, feedback timeline, gate summary, verdict, diff link.
- `DiffViewer` — file list, stats, hunks, binary/truncated notices, raw patch
  download.
- `WaveTimeline` — spans from wave-start/end rows; current span pulsing (motion
  reduced respected).
- `EventLog` — virtualized tail, filters, pause/autoscroll.
- `HealthPanel` — checks with severity, detail, and skipped-in-degraded mode.
- `BudgetBar` — spent/ceiling + wave-warn marker + per-model/task breakdown.
- `ActionDialog` — confirmations, PRD path, handoff note, selection.
- `JobsList` — UI-launched and attached runs, reattach/stale state.
- `Toast` / `TabTitle` — in-page notifications and title badge.

## 10. Visual design

- Dark-first, dense, terminal-adjacent; no chat bubbles, no ornamental cards.
- Base 13px UI text, 12px tables, `ui-monospace` for ids, shas, paths, logs,
  diffs.
- Palette via CSS variables: background, panel, elevated panel, border, text,
  muted, accent, ok, warn, bad, running, sleeping. Status is always
  glyph + label; color is secondary.
- Row height 28–32px; 8px spacing grid; one 150ms fade for drawers/toasts;
  honor `prefers-reduced-motion`.
- Desktop-first; usable down to ~1024px; no mobile layout in v1.
- Keyboard: `Esc` closes a drawer/dialog, `/` focuses the event filter, `?`
  opens a shortcut sheet. No single-key destructive shortcuts.

## 11. Data and contracts

### 11.1 Readout

The UI renders one `KitReadout` (the existing visibility seam), extended
additively by the UI seam. No new state model.

New readout fields (all optional, backward compatible):

```ts
interface KitReadout {
  seam?: 1;                       // present when the UI seam is available
  live?: {
    task: string;
    wave: number;
    startedAt: number;
    elapsedMs: number;
    pid?: number;
  };
  tasks: Array<KitTaskView & {
    status: "todo" | "in_progress" | "done" | "quarantined";
    diff?: DiffArtifactRef;
  }>;
  artifacts: Array<ArtifactFile & { kind: "gate" | "quarantine" | "diff" | "other" }>;
}

interface DiffArtifactRef {
  task: string;
  patch: string;                  // artifact file name, not content
  stats?: string;                 // artifact file name for the JSON stats
  bytes: number;
  truncated: boolean;
}
```

Modes:

- `storage`: the UI server acquired `.orch/lock`, read the full readout, released
  it immediately. Full sections present.
- `sidecars`: the lock was busy or acquisition failed; only
  `.orch/status.json`, `.orch/wave-log.jsonl`, artifacts, and live job records
  are used. Storage-only sections are absent; health marks them skipped; the
  UI shows the degraded badge and "last updated".

The server never holds the lock between requests. Readout acquisition retries
briefly on `LockBusyError`, then degrades.

### 11.2 HTTP API

All routes are same-origin, loopback, cookie/token authenticated (Appendix C).
JSON errors: `{ error: string, detail?: string }` with the listed status codes.

| method | path | purpose |
| --- | --- | --- |
| GET | `/` | SPA shell (built assets) |
| GET | `/api/readout` | current `KitReadout` + `mode` + `at` |
| GET | `/api/events` | SSE: `readout` snapshots, `job` updates, `heartbeat` |
| GET | `/api/jobs` | UI-launched + attached runs, with liveness |
| GET | `/api/jobs/:id` | one job record (status, exitCode, logPath) |
| GET | `/api/jobs/:id/log` | tail of a job log (`?n=200`, max 5000 lines) |
| POST | `/api/actions` | `{ kind, ...params }` → `202 { jobId }` |
| GET | `/api/tasks/:id/diff` | persisted patch + stats; `404` if none |
| GET | `/api/tasks/:id/diff?wave=N` | A.7 per-wave isolated diff between the wave's recorded trees; computed on demand, never persisted; `400` bad wave, `409` not isolatable (plain reason) |
| GET | `/api/tasks/:id/diff/live` | live patch vs baseline; `409` if not running |
| GET | `/api/conversations/:id/entries` | A.5 bounded transcript excerpt (≤ 2,000 entries; storage-mode lock-per-read; `404` unknown id, `409` while a run owns the lock) |
| GET | `/api/project/sources` | M5 read-only source viewers' data — M5-a: config + PRD; M5-b: PROMPT.md (fixed root path) + `evals/recipes.toml` (the engine gate loader's verdict; absence = defined empty-gates state). Raw text + verdicts; static files, no lock, ≤ 5 MiB text, `binary` labeled; there is NO mutation route for these files (§5) |
| GET | `/api/artifacts` | artifact list (same as readout) |
| GET | `/api/artifacts/:name` | artifact text; allowlisted names, size cap |

Action body shapes:

```ts
{ kind: "plan", prd?: string }
{ kind: "run", approve: true, tasks?: string[] }
{ kind: "stop", target?: "job" }
{ kind: "stop", target: "attached", pid: number }   // §7.2.1; one re-verified SIGINT
{ kind: "handoff", note: string }
{ kind: "verify", task: string }
{ kind: "export" }
```

Rules:

- One mutating job at a time. `plan`/`run`/`verify`/`export` need the lock; if
  the lock is held or a job is active, `409` with the holder PID/phase.
- `handoff` is allowed during a run; it writes only the atomic side-car.
- `stop` acts on a job launched by this server (`target: "job"`, the
  default), or — with `target: "attached"` — on the terminal-started run
  whose §7.2.1 verification passes. Anything unverifiable stays unsignalled:
  409 with the plain-words reason of the check that failed.
- Validation is explicit per kind; unknown kinds/fields → `400`. Never pass
  user input to a shell; argv arrays only.
- Job records and logs live under `.orch/ui/` (git-ignored with `.orch`).

### 11.3 SSE behavior

- Watch `.orch/status.json`, `.orch/wave-log.jsonl`, and `.orch/ui/jobs/` with
  `fs.watch` plus a 1s fallback poll (filesystem-dependent).
- Debounce 150ms; send a full `readout` snapshot per change (no patch protocol
  in v1). While a run is active, at least one snapshot every 2s so elapsed
  time is fresh even if the side-car is quiet.
- `heartbeat` every 15s. Reconnect sends a full snapshot. `Last-Event-ID` is
  not required in v1.
- The client replaces its store on each snapshot; local elapsed ticks between
  snapshots.

### 11.4 Artifact access

- Artifact names are validated against `^[A-Za-z0-9._-]+$` and resolved under
  `.orch/artifacts/`; path traversal → `400`.
- Text responses capped at 5 MiB; larger files return metadata + a download
  link. Diffs and gate logs are text; binary patches are labeled.
- The UI never executes artifact content.

## 12. Security

- Loopback bind only; no remote access in v1.
- Random 256-bit token per server start:
  - URL `?token=` is exchanged once for an `HttpOnly; SameSite=Strict` cookie,
    then stripped via `302` + `history.replaceState` on the client.
  - API requires the cookie; state-changing requests additionally require an
    `X-Kit-Token` header (or a same-origin `Origin` + `Sec-Fetch-Site` check).
  - SSE uses the cookie.
- Reject `Origin` values that are not the server's own origin for mutating
  requests.
- No secrets in `localStorage`/`sessionStorage`; no provider keys in the client
  bundle.
- Action allowlist is hard-coded; no generic shell/exec endpoint.
- The server runs as the same user as the CLI; it does not elevate.

## 13. Performance and limits

- Initial page load < 1s on the local machine (built assets, no CDN, no web
  fonts).
- Readout build + transfer typical < 250ms; SSE update visible < 1s.
- Storage-mode readout throttled to ≥1s between scans; side-car mode may update
  faster. Elapsed timers are client-side.
- Event log keeps the newest 2,000 rows in the DOM (virtualized or windowed).
- Diff rendering: lazy per file; first 2,000 lines per file; total 5 MiB; show
  truncation explicitly.
- No polling loops in the browser; one SSE connection plus retry/backoff.

## 14. Packaging and layout

`ui/` is an independent package in the same repository. It is **not** a root
workspace by default, so the kit's dependency footprint and `npm i` stay
unchanged.

```
ui/
  PRD.md
  README.md
  CHANGELOG.md
  package.json            # name: llm-toolkit-001-ui, private, own deps
  package-lock.json       # own lockfile
  vite.config.ts
  index.html
  src/                    # Svelte 5 app
    main.ts
    App.svelte
    lib/
      api.ts
      sse.ts
      stores.ts
      diff.ts
      format.ts
    components/
    styles/
  server/
    cli.ts                # bin: llm-toolkit-ui
    server.ts
    auth.ts
    jobs.ts
    readout.ts
    diff.ts
    static.ts
  test/                   # vitest + server contract tests + e2e
```

Commands:

```bash
npm --prefix ui install
npm --prefix ui run dev        # Vite + API server, for development
npm --prefix ui run build      # static assets into ui/dist
npm --prefix ui test
llm-toolkit-ui [--port 0] [--no-open] [--project .]
```

`llm-toolkit-001 ui` is a convenience forwarder in the kit CLI: it resolves the
`llm-toolkit-ui` bin and spawns it (process boundary, no import), passing the
arguments through. If the UI package is not installed, it prints the install
command and exits 1. The UI package owns the real entry point, so the
sub-product can move or be published independently without a cycle.

Stack: Svelte 5 + Vite + TypeScript, hand-written CSS, no component library, no
router, no state library. Charts are hand-rolled SVG. Icons are inline SVG.

Compatibility: `llm-toolkit-001-ui` declares a compatible kit range; the UI
requires `readout.seam === 1`. Against an older kit without the seam, it runs
in a degraded mode: live task/wave is unknown and per-task diffs are absent,
with a visible warning. Node >= 22.19, same as the kit.

## 15. Testing and acceptance

### 15.1 Automated

- **Engine seam tests:** wave-start sets `in_progress` + `wave-running` +
  `startedAt`; wave end clears/updates it; status.json carries the new fields;
  plan flushes `planning`; task patch + stats written on `done`; quarantine
  patch unchanged; engine-owned paths excluded; caps/truncation; no behavior
  change when the UI is absent.
- **Server tests:** token exchange + cookie, bad/missing token (401), cross-
  origin mutation (403), action allowlist, argv construction (no shell),
  lock-busy 409, job spawn/exit/reattach/stale, verified attached stop
  (§7.2.1: identity match signals once; every failed check signals nothing),
  artifact path traversal,
  SSE snapshot delivery and heartbeat.
- **UI tests:** task table sorting/filtering, plan selection, diff parser
  (hunks, binary, truncation), status strip states, phase switching,
  empty/error states, confirmation dialogs.
- **E2E (faux):** the demo replay end to end through the UI.

### 15.2 Demo acceptance (no API keys)

```bash
cp -r examples/demo-prd /tmp/demo && cd /tmp/demo
npm i <kit repo>
llm-toolkit-001 init . --with-demo
# [roles.*] -> provider "faux", modelId kit-planner|kit-implementer|kit-verifier
# evals/recipes.toml -> [broken-gate]\ncmd = "node smoke-gate.cjs"
git init -q && git add -A && git commit -qm base

npm --prefix <kit repo>/ui install
npm --prefix <kit repo>/ui run build
KIT_FAUX=1 KIT_FAUX_SCRIPT=smoke.replay llm-toolkit-001 ui
```

Pass criteria:

1. Plan completes; review shows the demo's tasks and dependencies.
2. Approve & run starts a detached job; the current task/wave and elapsed time
   appear within 2s.
3. Wave 1 fails its gate; feedback and the failed gate log are visible; wave 2
   starts and fixes it; the run completes.
4. The completed task's diff drawer shows the expected files and hunks; a
   quarantine (if exercised in a variant) shows its patch + rollback.
5. Budget spent, waves, and health match `inspect --json`.
6. Closing the browser does not kill the run; reopening the UI reattaches and
   shows the correct final state.
7. Starting `run --approve` in a terminal while the UI is open shows the same
   live state with an "attached" badge; Stop is disabled until the §7.2.1
   identity check passes, then sends one verified SIGINT (exit 130,
   resumable).
8. Export produces the same `.orch/artifacts/report.{json,html}` as the CLI.

### 15.3 Manual checks

- Token in the URL is exchanged and removed from the address bar.
- A second browser without the cookie gets 401.
- A malicious cross-origin POST is rejected.
- Large diff and large gate log stay responsive and say "truncated".
- Sleep/exit-42 state and resume work against the fake clock or a simulated
  replay.
- Keyboard-only operation for drawers, dialogs, and the event filter.

## 16. Milestones (execution option 1: vertical slices)

Each milestone is independently demoable and shippable. The UI seam lands
together with the milestone that consumes it.

### M0 — Walking skeleton (read-only, attach + launch)

- Core seam S1: truthful live wave status (`in_progress`, `wave-running`,
  `startedAt`, wave start/end rows, status.json extras).
- `ui/` package scaffold (Svelte + Vite + server), token/cookie auth, static
  serving, `GET /api/readout`, SSE, degraded-mode handling.
- Minimal page: header status strip, task table, event log tail; attach to a
  terminal-started run; `llm-toolkit-ui` bin + `llm-toolkit-001 ui` forwarder.
- Exit: a terminal-started `run` is visible live within 2s, including current
  task/wave and spend; the UI survives UI-server restart and reattaches.

### M1 — Control

- Detached job runner + job records + reattach/stale handling.
- Actions: plan, approve & run, run selected, stop (UI jobs), handoff, verify,
  export; confirmations; lock-busy errors.
- Plan review screen; planning state; sleep/exit-42 banner + resume; completion
  report.
- Exit: plan → review → approve & run → complete via the UI on the faux demo;
  close/reopen reattaches; stop interrupts gracefully and the next run resumes.

### M2 — Diffs

- Core seam S2: per-task patch + stats artifacts; live diff computation.
- Readout diff refs; diff API + artifact serving.
- Diff drawer (files, hunks, binary/truncated), quarantine patch view, live
  preview; diff access from the task table and completion report.
- Exit: every done/quarantined task in the demo has a correct diff; live diff
  works during a wave; caps and exclusions verified.

### M3 — Polish and hardening

- Health panel, alerts/toasts + tab-title badge, empty/setup/error states,
  keyboard shortcuts, accessibility pass.
- Faux E2E in CI, README/CHANGELOG, manual acceptance checklist.
- Exit: all acceptance criteria above pass; no known security or lock issues;
  docs describe degraded vs full mode and the core seam.

## 17. Risks and mitigations

| risk | mitigation |
| --- | --- |
| Core seam changes loop behavior | additive fields only; tests assert unchanged wave/gate/verifier/quarantine behavior; UI absence changes nothing |
| Lock contention with CLI runs | acquire/release per read, retry then degrade to side-cars; never hold the lock |
| Detached jobs orphaned | job record + PID liveness + stale state; stop for UI jobs; clear log path; no auto-kill |
| Side-car drift / stale view | `at` timestamp, "last updated", degraded badge, health checks |
| Huge diffs/logs block the UI | caps, lazy file rendering, truncation notices, virtualized log |
| Localhost attack surface | loopback bind, per-session token/cookie, origin checks, hard-coded action allowlist |
| Svelte 5 ecosystem churn | core Svelte + Vite only; no UI kit/router/state libs |
| Scope creep into a chat client | the transcript drawer is read-only and bounded (A.5: newest ≤ 2,000 entries, per-entry caps, no pagination, no writing); live token streaming and conversation search stay deferred; the list stays summaries |
| Diff semantics misunderstood | label "task diff (cumulative since baseline, N waves)"; per-wave isolated diffs deferred |

## 18. Deferred (explicitly not v1)

- Read-only conversation transcript drawer — shipped in ui 0.5.1 (Appendix
  A.5; bounded excerpts, no kit change); the §18 menu caught up at 0.9.0.
  What remains deferred: live token streaming + conversation search.
- Per-wave isolated diffs — shipped in ui 0.8.0 (Appendix A.7; kit 0.2.3).
- Light theme.
- Browser notifications (opt-in Notification API).
- LAN/Tailscale access with the same token model.
- Multi-project switcher.
- macOS variant B for attached stop — the runner recording `{pid, argv,
  startedAt}` into `status.json` (the Linux `/proc` path ships in
  M5-slice-3, §7.2.1).
- Delivery toggle and config/PRD/router EDIT editors — the read half shipped in M5 (decision D5): `/api/project/sources` serves `.orch/config.toml`, the PRD, PROMPT.md and `evals/recipes.toml` raw + read-only; router.md stays plan-review-only; no editing route exists for any of them.
- Mobile/responsive layouts.

## 19. Decision log

| decision | choice |
| --- | --- |
| user / context | local, single-user control surface |
| core job | supervise and control a live run |
| run relation | launch + attach; terminal runs are first-class |
| launched-run lifetime | detached and reattachable |
| packaging | in-repo `ui/` sub-product, own PRD/package/version |
| read path | in-process `readout()` + watchers, lock held only per read |
| frontend | Svelte 5 + Vite + TypeScript, hand-written CSS |
| project scope | one project per `ui` process |
| actions | plan, approve & run, run selected, stop, handoff, verify, export |
| diffs | per task + quarantine + live preview; cumulative semantics labeled |
| app shape | one phase-aware page + drawers, hash deep links |
| conversations | summaries in the list; bounded read-only transcript excerpts in the drawer (Appendix A.5, shipped 0.5.1; the §18 close-out is 0.9.0) — live token streaming + conversation search stay deferred |
| auth | loopback + per-session token/cookie |
| visual | dense dark operational dashboard |
| alerts | in-page + tab-title badge |
| execution | vertical slices, walking skeleton first |
| attached stop | verified single-SIGINT for terminal-started runs, shipped in M5-slice-3 (decision D6, 2026-11-08, §7.2.1): live pid + cwd + installed-entry argv match; a failed check is a stated reason and NO signal; never SIGTERM/KILL; Linux-only v1 — macOS needs the deferred status.json runner extra |
| per-wave isolated diffs | shipped as Appendix A.7 (drafted alongside 0.7.1, implemented at the explicit go-ahead in the same wrap-up): wave start/end rows carry the wave's own git tree (optional additive `treeSha`; failed capture → row without the field, never a failed run; quarantine captures BEFORE the rollback), a tree-to-tree display wrapper with the A.2 exclusions/caps, readout spans echo start/end trees, and `GET /api/tasks/:id/diff?wave=N` + a wave selector in the drawer — the isolated view is labeled, the cumulative default stays, display diffs are never a rollback input (kit 0.2.3; readout.seam stays 1) |

## Appendix A — Core seam (required, additive)

The seam is versioned (`readout.seam = 1`). It must not change existing loop
semantics, config, docs, or CLI output for users who never open the UI.

### A.1 Live wave status

- `StatusPhase` gains `{ phase: "wave-running"; task: string; wave: number;
  startedAt: number }`. `StatusPayloads.phase` already includes
  `wave-running`; add `startedAt?: number`.
- At wave start, before `submitAndAwait`:
  - set the task's router status to `in_progress`;
  - append a wave-log row `{ kind: "wave", task, wave, verb: "start" }` with
    `ts = startedAt`;
  - flush `status.json` with the wave-running phase, task, wave, and
    `startedAt`.
- On every wave outcome (retry, done, quarantined, sleeping, budget):
  - append `{ kind: "wave", task, wave, verb: "end" }` with the outcome in
    `detail`;
  - set the task back to `todo` on retry, or the terminal status otherwise;
  - flush `idle` (or the existing terminal phase) with the message.
- `status.json` also carries `sleepUntil`, `activeAlert`, `consecutiveErrors`,
  `sleepCycleCount`, and `prdPath` when available, so an attached UI can render
  the governor state without storage.
- Planner: flush `{ phase: "planning" }` before the planning conversation;
  keep the existing `planned` commit after.
- `buildTimeline` uses the start/end rows so spans have real start times; rows
  remain append-only and mirrors stay byte-compatible.

### A.2 Diff artifacts

- Reuse `savePatch` semantics (throwaway index, untracked files included,
  binary allowed) with a display-oriented wrapper:
  - exclude engine-owned paths: `.orch/**`, `router.md`, `PROMPT.md`;
  - cap the stored patch at 5 MiB, write `truncated: true` in stats, and never
    use a truncated patch for rollback (rollback uses `restoreTree`);
  - stats via `git diff --numstat` / `--name-status` against the baseline:
    `{ task, wave, baselineTreeSha, generatedAt, files: [{ path, status,
    insertions, deletions, binary }], totalInsertions, totalDeletions, bytes,
    truncated }`.
- On `done`: write `.orch/artifacts/task-<id>.patch` and
  `.orch/artifacts/task-<id>.json` before delivery (the task's final tree).
- On quarantine: keep the existing `quarantined-<task>-w<N>.patch`; write the
  stats side-car for it. The rollback behavior is unchanged.
- Live diff endpoint: compute vs the task baseline on demand with the same
  exclusions/caps; do not persist; return `409` when the task is not the
  current in-flight task.
- Do not store diffs in durable docs or the wave log (no DB migration).

### A.3 Readout

- Add `seam: 1`.
- Add `live` from the status side-car (merged in both modes; in storage mode
  the side-car is still the freshest source for elapsed time).
- Add `tasks[].diff` refs and the `"diff"` artifact kind.
- In storage mode, read `.orch/status.json` for live fields and health parity;
  do not change the single-owner rule.
- Health: add a `seam` check (present/absent) and a `live` check (startedAt is
  within the expected window when a run holds the lock).

### A.4 CLI forwarder

- `llm-toolkit-001 ui [args…]` resolves `llm-toolkit-ui` from PATH or
  `ui/node_modules/.bin`, then spawns it with the same args and inherited
  stdio/env. No import of UI code from the kit.
- Missing UI package: print `npm --prefix ui install` (repo) / the package
  install hint and exit 1.
- No other core CLI changes.

### A.5 Conversation transcript excerpts (additive, inspector-level)
- The UI may show bounded, read-only transcript excerpts: `inspector.ts` gains `conversationEntries(loop, id, opts)` returning plain JSON-able entry shapes (kind, timestamps, and content fields as strings — no pi-durable types cross the module boundary; the UI server never imports kit.ts).
- Entry caps mirror the summary scan: at most MAX_ENTRY_PAGES_PER_CONV pages × ENTRIES_PER_PAGE entries per request (≤ 2,000), plus a `truncated` flag; no pagination protocol in v1 — the cap is the contract.
- Storage-mode only, lock-per-read: the excerpt is read inside the same brief `openProjectHarness` window the readout uses; side-cars mode answers with the established "conversation detail returns when the lock is free — a run is live" empty state. Never hold the lock between requests.
- Read-only: the callable only scans entries (same BACKGROUND_CONTEXT gated pattern as collectConversations); no writes, no CLI surface change, no behavior change when the UI is absent. Seam version stays `readout.seam = 1` (A.5 is additive surface, not a new seam version — note this choice in the PRD edit).

### A.6 Delivery truth (additive, read-only)
- `KitReadout` gains an additive `delivery` section: `mode` — the configured `delivery.mode` (§4.6: `none | commit | pr`) — and `rows` — the wave log's kind `"delivery"` rows echoed as plain JSON-able shapes (`ts`, `task`, `verb`, `wave?`, `detail?`). Both modes serve it: storage reads the mode from the open config; side-car mode best-effort re-reads `.orch/config.toml` (a static file, not the owned storage) and omits `mode` when the config itself is unreadable, while the outcome rows still come from the wave log.
- Read-only, and deliberately WITHOUT a UI mutation: per §5 delivery stays a config + CLI decision. The CLI's only delivery paths are the config's `delivery.mode` and the `--deliver` run qualifier the `pr` mode requires (a per-run override of what a human typed, not a safe toggle) — exposing either as an action would be the §5 non-goal and a §7.2 action-table change. No config write, no new CLI flag/command, no behavior change when the UI is absent. Delivery/config editing stays deferred to M5 (§18). Seam version stays `readout.seam = 1` (A.6 is additive surface, not a new seam version).

### A.7 — Per-wave isolated diffs (additive; shipped — kit 0.2.3 + ui 0.8.0)

Drafted during the 0.7.1 wrap-up; implemented at the owner's explicit
go-ahead in the same wrap-up (the kit 0.2.3 seam + this UI's 0.8.0 route and
drawer).

- **The gap:** the engine already snapshots a git tree per task baseline
  (throwaway index; the project's real index is never touched —
  `captureBaselineTree` in `util/git.ts`). What one wave added to a task is
  derivable but never recorded, so the UI cannot name a wave's own change.
- **Engine change (additive):** at every wave START and wave END, capture the
  tree with the SAME `captureBaselineTree` call, made inside the wave's
  existing `commitState` windows (no new lock discipline, no extra window),
  and record it as an optional additive `treeSha` on the `wave` start/end
  rows (`WaveRow` gains `treeSha?: string`). Old readers ignore the field;
  no CLI output, config, or docs change. Cost: two throwaway-index git
  snapshots per wave; the objects live in `.git` — no new artifact dir, no
  retention policy beyond git's own. A quarantine captures the wave's
  produced tree BEFORE its rollback, so the isolated diff names the wave's
  evidence, not the empty post-restore tree. Shipped-out fix: the throwaway
  index is now uniquely named and removed after each capture (a pid-named,
  never-removed one leaked staged state between captures, so files deleted
  between captures wrongly survived every later tree).
- **Display wrapper (additive):** `util/git.ts` gains a tree-to-tree diff +
  stats wrapper with the A.2 exclusions and caps (`.orch/**`, `router.md`,
  `PROMPT.md` excluded; 5 MiB cap, `truncated: true`), endpoints being
  immutable shas — pure `git diff --binary <tree> <tree>` (including
  untracked-relevant states already captured in the trees). Existing
  `savePatch` semantics are unchanged; rollback still uses `restoreTree`.
- **Read path:** wave-log rows and the readout's wave timeline spans pass
  `treeSha` through as plain JSON-able shapes (`startTreeSha`/`endTreeSha`; the
  A.6 echo style). `seam` stays 1: additive surface only.
- **UI (§7.4 gains a wave scope):** `GET /api/tasks/:id/diff?wave=N` serves
  wave N's isolated patch + stats — the wave's end tree vs its start tree
  (both recorded by that same wave's rows) — computed on demand, stored
  nowhere new, labeled "wave N — isolated to this wave". Task views offer
  the wave numbers they already carry from the wave log. The default "task
  diff" view KEEPS its cumulative label. Quarantine rollback, gate and
  delivery behavior are untouched; display patches are never used for
  rollback.
- **Failure posture:** a failed wave-tree capture never fails the wave — the
  row is written WITHOUT `treeSha` and the UI labels that wave "not isolated
  (no wave tree recorded)". (Deliberately softer than the baseline path,
  which throws: a missing baseline is fatal, a missing wave tree is only a
  missing view.) Git is a precondition the loop already has.
- **Non-goals:** no per-wave rollback or wave-level approve/regate, no
  wave-log format version bump, no delivery change (D3/D5 hold), no CLI
  output change, no new UI deps.

## Appendix B — Detached job runner

## Appendix B — Detached job runner

- Job record: `.orch/ui/jobs/<id>.json`
  `{ id, kind, argv, cwd, pid, startedAt, endedAt?, exitCode?, status:
  "running" | "exited" | "failed" | "stale", logPath }`.
- Log: `.orch/ui/jobs/<id>.log` (stdout + stderr, line-buffered).
- Spawn a small Node runner detached (no shell), which spawns the CLI, pipes
  its output to the log, writes the exit code atomically, then exits. The UI
  server is not in the child's process group and can restart independently.
- On server start: mark records with dead PIDs as `stale`; keep records for
  history (bounded, e.g. last 50 or 14 days).
- Attached runs are discovered from `status.json.lockedByPid`; liveness is a
  best-effort PID check. They are not job records unless launched by the UI.
- Env is inherited from the UI server (including `KIT_FAUX*`, provider keys).
  No secrets are written to job records.

## Appendix C — Auth flow

1. `llm-toolkit-ui` generates `token = base64url(32 random bytes)` and starts
   the server on `127.0.0.1:<port>` with `--port 0` by default.
2. It opens `http://127.0.0.1:<port>/?token=<token>` (or prints the URL).
3. `GET /?token=…` validates, sets `kit_ui=<token>` (`HttpOnly`,
   `SameSite=Strict`, `Path=/`, no `Secure` on loopback), responds `302 /` and
   drops the query from the address bar.
4. Static assets: no auth (they are inert); API/SSE: require the cookie.
5. Mutations: require the cookie **and** an `X-Kit-Token` header (the SPA
   obtains the token value from a non-HttpOnly companion cookie set at
   handshake, or a same-origin `GET /api/session` that returns a CSRF token),
   plus `Origin`/`Sec-Fetch-Site` validation. Never accept cross-origin
   mutations.
6. A missing/invalid cookie returns `401` with a plain "reopen the URL printed
   in the terminal" message. Restarting the server invalidates all sessions.
7. The token never appears in logs after the initial URL; the server redacts it
   from access logs.

## Appendix D — File/ownership boundaries

- **Core (kit):** `src/engine/waves.ts`, `src/engine/state.ts`,
  `src/engine/harness.ts` (`StatusPayloads`), `src/engine/planner.ts`,
  `src/engine/inspector.ts`, `src/util/git.ts`, `src/cli.ts` (forwarder),
  plus tests. All seam changes are additive.
- **UI sub-product:** everything under `ui/`, its own `package.json`,
  lockfile, tests, version, and CHANGELOG.
- **Runtime:** `.orch/ui/` for job records/logs; `.orch/artifacts/` for
  patches/stats/exports; no other writes.
- **Docs:** root README links to `ui/README.md`; this PRD owns the UI's scope;
  core docs mention only the seam and the `ui` forwarder.

# Changelog — llm-toolkit-001-ui

Manual semver discipline: keep `package.json` version and the newest section
in sync. The UI follows `ui/PRD.md` milestones; the kit's seam it consumes is
`ui/PRD.md` Appendix A.

## 0.9.0 — §18 close-out #1: the read-only conversation transcript drawer is declared shipped

The drawer's functionality landed back in 0.5.0/0.5.1 (M4-a: the summary
drawer + the bounded transcript excerpt over the Appendix A.5 seam); this
cut ships the §18 deferral menu catching up with the code, plus the e2e
witness the faux suite was missing. No new server or client behavior; no kit
change (`readout.seam` stays 1; kit 0.2.3); no new deps.

- **`ui/PRD.md` bookkeeping (the A.7 precedent)** — §18's "read-only
  conversation transcript drawer (first fast-follow)" moves to shipped
  (0.5.1, Appendix A.5); what REMAINS deferred is narrowed to the two
  things the owner still holds back: live token streaming and conversation
  search. §2/§5's "full conversation transcripts … (summaries only)"
  non-goal line narrows to exactly those two (the conversation list stays
  summaries); §7.5's "no transcript content in v1" now describes the
  shipped drawer (bounded excerpt, caps stated in the copy, never a chat
  client); §17's chat-client risk row and §19's decision log say the same
  sentence.
- **Faux-CLI e2e step for the drawer** — after the real-CLI plan/run
  completes, the suite fetches the planner's and an implementer
  conversation's `GET /api/conversations/:id/entries` through the cookie
  session and asserts the bounded excerpt end to end (the plan JSON visible
  in the excerpt, `truncated: false`, plain-JSON shapes) plus the drawer's
  404 posture for an unknown id — the read path now has a real-run witness,
  consistent with the KIT_FAUX patterns the suite already uses.
- **Non-goals kept** — no live streaming, no conversation search, no chat
  client, no pagination protocol (the ≤ 2,000-entry cap stays the
  contract), no editing of any project file from the drawer (D5 holds).
- **Validation** — root `npm test` (49/49) + `npm run build`; ui `npm test`
  (224 passed/4 skipped — unchanged; the new assertions ride inside the
  existing e2e cut), `typecheck`, `check` (0/0), `build`, `test:e2e`
  (4/4).

## 0.8.0 — M5-slice-4: per-wave isolated diffs ship Appendix A.7

The §18 deferral "per-wave isolated diffs (wave-start snapshots)" — the A.7
proposal drafted during this wrap-up and implemented at the owner's explicit
go-ahead. The kit side is 0.2.3's additive seam (`readout.seam` stays 1):
every wave start/end row carries its own git `treeSha`, a tree-to-tree
display wrapper diffs two captured trees, and readout wave spans echo
`startTreeSha`/`endTreeSha`. What the UI gains:

- **`GET /api/tasks/:id/diff?wave=N`** — one wave's isolated delta: computed
  on demand between that wave's own recorded trees (start row's vs end
  row's), the A.2 exclusions and 5 MiB cap applied; never persisted, never
  a rollback input, the lock never taken. Failure postures answer in plain
  words and never invent data: a wave without a start tree (rows predate
  A.7 or the capture failed), an end row without a tree, and a
  still-running/short-cut wave (no end row yet — the in-flight view is the
  live diff) answer 409 with the reason; a wave whose raw delta is only
  engine-owned churn (the router.md mirror) answers 200 empty with the
  stated reason.
- **The diff drawer gains a wave scope** — when the readout's timeline
  carries spans with recorded trees for the task, a small select offers
  "task (cumulative)" plus each wave; picking one labels the view "wave N —
  isolated to this wave" and names the two trees. The default view stays
  the cumulative "task diff" with its raw download; the wave scope is
  computed ("never persisted") so its raw-download anchor is replaced by
  that statement. A task switch resets the scope to cumulative.
- **Non-goals kept** — no per-wave rollback or wave-level approve/regate,
  quarantine rollback behavior unchanged (the quarantined wave's tree was
  captured BEFORE the rollback, so its isolated diff still names the
  evidence), no delivery change (D3/D5), no editors, no new ui deps, no
  router/hash changes, the {kind:"stop"} paths unchanged.
- **Validation** — new route-level wave tests (real captured trees in a
  baked project: the isolated delta is exactly the wave's own files; the
  400/409 plain-words refusals; the 200-empty note), the client
  `normalizeWaveDiff` shapes, and the kit's A.7 tests (row treeShas across
  real waves, span echo, the caught captureBaselineTree stale-index bug).
  All suites green locally: root `npm test` (49/49) + `npm run build`; ui
  `npm test` (224 passed/4 skipped), `typecheck`, `check` (0/0), `build`,
  `test:e2e` (4/4).

## 0.7.1 — attached stop: §7.2.1 check 1's "ui-job" refusal enforced at the POST gate

Post-ship inspection of 0.7.0 found an enforcement gap in §7.2.1 check 1: the
refusal for a lock holder "a running UI job record claims" lives in
`verifyAttachedStop()` behind the caller-supplied `uiJobPids`, and only the
enablement path passed them — the authoritative `POST /api/actions`
`{ kind: "stop", target: "attached" }` route did not, so a hand-crafted or
stale POST naming a UI-launched run's CLI pid verified through the /proc
checks and sent the SIGINT instead of refusing with "use its ordinary Stop
button". No wrong-target signal ever resulted: the record's pid IS the CLI
child holding `.orch/lock` (the runner patches it in — `ui/server/
job-runner.mjs`) and the ordinary Stop sends the same one SIGINT to that same
pid — but the shipped §7.2.1 + 0.7.0 text promised the refusal comes first.
Now the route reads a FRESH record list and passes `runningJobPids()` — one
new helper in `ui/server/jobs.ts` that ports the enablement path's exact
filter (running, not a handoff, pid known), so both call sites enforce the
clause identically. A failed claim answers its plain-words reason and signals
nothing, as every §7.2.1 check does. New route-level test: a live holder a
running record claims → 409 with the ordinary-Stop wording and the holder
survives (no signal). Also: `ui/package-lock.json`'s root version, stale at
0.4.0 since before 93488bb, syncs to 0.7.1 (bundled, explicit word given).
Kit stays 0.2.2; `readout.seam` stays 1; no new deps; the plain
`{ kind: "stop" }` UI-job path is byte-for-byte unchanged.

## 0.7.0 — M5-slice-3: verified attached stop — Ctrl-C (SIGINT) to terminal-started runs (§7.2.1, decision D6)

The third M5 slice lifts the §18 deferral "safe stop for attached
(terminal-started) runs, with PID/command verification" — the last
control-shaped gap between a UI-launched run and an attached one. Variant A
(§7.2.1): NO core seam change (kit stays 0.2.2; A.1–A.3 + A.5 + A.6 are
untouched — `lockedByPid` was already in the side-car; `readout.seam` stays
1), no new deps, no CLI surface change, and the CLI is still the only thing
that writes loop state. What changes: the UI server can now, after proving
the identity of the process that owns the lock, send it exactly one Ctrl-C.

- **The verification (all of it server-side, off `/proc`)** — every stop
  attempt first proves the runner, and every failed check is a stated
  plain-words reason with NO signal: (1) a FRESH `.orch/status.json` read
  names a live `lockedByPid` that is neither this server's own readout
  window nor a pid a running UI job record claims; (2) Linux only (v1):
  `/proc` present — macOS variant B (the runner writing `{pid, argv,
  startedAt}` into status.json) stays deferred, and machines without `/proc`
  refuse with a 501; (3) `/proc/<pid>/cwd` realpaths to the project root
  ("pid N is alive but its working directory is X, not this project");
  (4) `/proc/<pid>/cmdline` carries EXACTLY ONE token (after `argv[0]`)
  whose realpath equals the CLI entry this UI resolves for its own jobs
  (override → project `.bin` → kit dist → PATH → tsx — the same chain the
  job spawner uses; relative tokens resolve against the verified cwd)
  followed by a lock-holding subcommand (`plan`/`run`) — flags, task lists
  and the interpreter are NOT required tokens, the entry + subcommand are;
  (5) the whole check re-runs immediately before signalling, then EXACTLY
  ONE SIGINT goes out — the kit's SIGINT clean-close path, exit 130,
  durable state left resumable. SIGTERM/SIGKILL never happen; stale, missing
  or changed holders never auto-kill anything (§17).
- **Enablement is earned, then re-verified** — the jobs payload (`/api/jobs`
  + SSE `job` events) carries `attached.stop`: `ok` with the verified pid +
  command (what the dialog shows) or the plain-words reason why not. The
  ActionBar's Stop and the jobs list's `stop (verified)` button are enabled
  only when that verification is ok (`⨯ stop unavailable (not verified)`
  with the reason in the tooltip otherwise); the confirm dialog states the
  full identity — "verifies: pid N runs this project's installed CLI … sends
  Ctrl-C (SIGINT) once; the run stays resumable (exit 130)" — and the POST
  (`{ kind: "stop", target: "attached", pid: N }`) re-verifies server-side
  as the authoritative gate, answering 202 `{ kind, target, pid }` or 409
  with the reason. A holder that changed between confirm and POST is told
  plainly ("it is pid X now, not the pid N you confirmed"). The ordinary
  `{ kind: "stop" }` (UI jobs) path is byte-for-byte unchanged.
- **Non-goals untouched** — no per-wave isolated diffs (still §18; the NEXT
  slice's Appendix A.7 proposal is NOT started here), no editors of any
  project file (D5; sources stay GET-only), no delivery toggle (D3), no new
  UI deps, no router/hash changes, Linux-only v1 documented in §7.2.1.
- **Testing** — new `test/attached-stop.test.ts` (identity of a real spawned
  child verifies and one re-verified SIGINT lands exactly once — a fixture
  counts received SIGINTs and exits 130; wrong cwd, foreign command, wrong
  subcommand, mismatched/changed holder pid, dead holder, the server's own
  readout window, and a UI-job-held pid all refuse with their reasons and
  signal nothing; route-level 400 shapes, 409 without a signal, and the 202
  happy path) and `test/dialog-requests.test.ts` (the request-builder shapes:
  job / verified-attached pid+command+Ctrl-C+exit-130 / unverified reason /
  nothing-running; body mapping; accepted lines). `e2e-real-cli.test.ts`
  gained the end-to-end scene: the real faux runner is spawned TERMINALLY
  (outside the job runner), its identity verifies on the jobs payload, the
  POST sends one SIGINT, and the process exits 130 — while the
  unverifiable-holder scene now proves the refusal never signals (the
  foreign sleeper survives). All suites green: root `npm test` (46/46) +
  `npm run build`; ui `npm test` (217 passed/4 skipped), `typecheck`,
  `check` (0/0), `build`, `test:e2e` (4/4).

## 0.6.1 — M5-b: PROMPT.md + gate recipes join the read-only sources panel (§5/§18)

The second M5 slice completes the read half of the §18 deferral across the
loop's INPUT documents: 0.6.0 shipped `.orch/config.toml` + the PRD; this one
adds `PROMPT.md` and `evals/recipes.toml` to the SAME panel, SAME endpoint,
SAME no-write promise (D5 stands — viewing ships, editors stay deferred;
router.md stays plan-review-only; D3's no-delivery-toggle is untouched). No
core seam change (still kit 0.2.2, A.1–A.3 + A.5 + A.6; `readout.seam` stays
1), no new deps, no CLI surface change.

- **One endpoint, four files** — `GET /api/project/sources` now serves
  `prompt` (`.orch`-sibling fixed root path `PROMPT.md`, the per-wave
  discipline doc every wave input embeds — same fixed path the engine reads)
  and `recipes` (`evals/recipes.toml` with a `parseError` verdict from the
  ENGINE's own `loadRecipes`, so the shown message is exactly what the next
  wave's gate step would throw). Still static-file reads with NO lock and NO
  harness window in both snapshot modes: a live run reads — never rewrites —
  either file (the harness blocks agents from writing `.orch/**`, `evals/**`,
  `router.md` or `PROMPT.md` anyway — engine-owned paths). §11.4 discipline
  carries over verbatim: 5 MiB text cap with
  a stated `truncated` flag (never silent), NUL-byte content labeled
  `binary`, byte counts always the file's real size. Still no POST: read-only
  in the protocol itself.
- **Honest verdict semantics per file** — the two new files have DIFFERENT
  absence meanings and the panel honors both: `PROMPT.md` missing is a WARN
  (amber `absent`) — waves still run, but every wave input assembles without
  the per-wave discipline doc; the banner names the fix (write it at the
  root, or `llm-toolkit-001 init`). `evals/recipes.toml` missing is a
  DEFINED state (green `ok · absent`) — zero recipes means gates run the
  scope check only, exactly what `loadRecipes` returns for `ENOENT`; the
  banner says so rather than crying red. A recipes TOML that parses but lacks
  `cmd` (or fails to parse) keeps the raw text visible under the red
  `parse error` chip — showing the text is how you fix the edit.
- **Panel + header** — the sources panel renders all four files through one
  generalized per-file row (chip, path, bytes, banners, raw text) driven by
  the pure chips in `view.ts`: `promptChip` / `recipesChip` (new) join
  `sourceChip`, and a new `worstSourceChip` makes the closed-panel header
  note severity-ordered (parse error > missing > binary > capped > ok) so a
  red recipes verdict outranks an amber prompt absence regardless of
  position. Header label is now `sources · config + prd + prompt + recipes`
  and never lies about a file it merely carried raw. Fetch-on-open +
  `refetch` only (no polling — §13); closed = zero requests. router.md
  deliberately stays unlisted: its content already lives in the plan-review
  cards.
- **Non-goals unchanged** — no write path for ANY of the four files (§5;
  D3/D5 hold), no delivery toggle, no per-wave isolated diffs, no
  mobile/LAN/light theme, no new UI deps.
- **Testing** — `test/project-sources-server.test.ts` gains the four-file
  happy path (prompt text = the init scaffold, recipes = the commented
  starter with no parseError), prompt-absent (warn, others stay clean),
  recipes unparseable (raw text + the loader's unreadable/invalid verdict),
  recipes missing `cmd` (the loader's needs-cmd message verbatim), and
  recipes-absent (defined state, no parseError); `test/components-sources.test.ts`
  covers the two new files' render (`text`/`missing`/`parse-error` states,
  the config's parse banner unchanged) plus new pure cases for
  `promptChip`/`recipesChip` and the severity-ordered header
  (`worstSourceChip`). All suites green: ui `npm test`, `typecheck`,
  `check`, `build`, `test:e2e` (3/3), root `npm test` and `npm run build`.

## 0.6.0 — M5-a: read-only project sources (config + PRD viewers, §5/§18)

The first M5 slice is deliberately the HALF of the §18 deferral ("config/PRD
editors") that §5 permits: viewing, not editing (decision recorded 2026-11-08,
D5 — a UI editor that writes `.orch/config.toml` or the PRD would be a §5
non-goal AND a §7.2 action-table change; the honest M5-a ships the read side
and keeps the edit side deferred, as M4-b did for delivery). No core seam
change (still kit 0.2.2, A.1–A.3 + A.5 + A.6; `readout.seam` stays 1), no new
deps, no CLI surface change. Delivery reading shipped in M4-b (A.6) — M5-a
adds the two remaining input documents: the config and the PRD.

- **`GET /api/project/sources` (§11.2 shape)** — one read-only endpoint
  serving both static sources: `config` (`.orch/config.toml` raw text + a
  best-effort parse verdict in the CLI's own plain words) and `prd` (the
  resolved path: status.json's A.1 `prdPath` flush first, then the config's
  `[paths] prd`, then the engine default `docs/prd.md`). Both modes serve it
  with NO lock and NO harness window — these are static files (the A.6
  precedent for reading the config path without the lock), and a live run
  rewrites neither. Text is capped at 5 MiB (§11.4 discipline) with a
  `truncated` flag; NUL-byte content is labeled `binary` and not shown; byte
  counts are always the file's real size. There is no POST for this route:
  read-only in the protocol itself, never a UI write path (the CLI stays the
  only mutation path).
- **Sources panel** — a collapsible left-column panel (deep link `#/sources`,
  sibling of `#/health` and `#/conversations`) rendering both files raw in
  scrollable pre blocks: per-file chip (ok / parse error / missing /
  `ok · capped` / binary), path, real byte count, and stated bounds. The
  header shows the worst fact (`parse error`, `unreadable`, a non-ok chip
  label) — and the snapshot's existing `configError` colors it even before a
  fetch, consistent with the dialogs' 422 preflight. Fetches on open + an
  explicit `refetch` button only (§13: no polling loops); closed = zero
  requests. Parse errors keep the raw text visible — showing the text is how
  you fix the edit. A missing PRD gets the established kind sentence (write
  it, or pass `--prd`; the plan dialog prefills the same path).
- **The promise is on the panel** — `read-only — the ui never writes these
  files; edit in your editor, the cli stays the only mutation path` — so the
  §5 guardrail is stated where the files are shown, not only in the PRD.
- **Non-goals unchanged** — no config/PRD/router editing (the §18 deferral
  stays deferred; so do PROMPT.md, evals/recipes.toml and router.md viewing —
  router content already lives in the plan review cards), no delivery toggle
  (D3), no per-wave isolated diffs, no mobile/LAN, no new UI deps.
- **Testing** — new `test/project-sources-server.test.ts` (shape happy path,
  missing PRD, broken TOML with status.json prd fallback, config-less root,
  the >5 MiB cap with the real byte count preserved, binary labeling, 401/405);
  new `test/components-sources.test.ts` (closed = zero fetches, ready render
  + read-only note, missing/parse-error/capped/error states, refetch retry,
  header pre-coloring from the snapshot's configError) + `sourceChip` cases;
  `format.test.ts` grows `bytesLabel`. All suites green: root `npm test`
  (46), ui `npm test`, `typecheck`, `check`, `build`, `test:e2e` (3/3).

## 0.5.3 — M4-c: event-log window raise (§13) + task-table row filter (§7.1)

The last M4 polish slice before M5. Two operator-console gaps closed, both
UI-only: no core seam change (still kit 0.2.2, A.1–A.3 + A.5 + A.6;
`readout.seam` stays 1 — nothing here needed even an additive Appendix
subsection), no new deps, no CLI surface change.

- **Event-log window raise (§13)** — the M3 record deferred §13's 2,000-row
  DOM window together with virtualization ("300 keeps sub-second SSE updates
  snappy"). M4-c ships the windowed half without virtualization, which §13
  explicitly accepts ("virtualized or windowed"): the DOM now keeps the
  **newest 2,000 rows** (was 300), and when the window bites the cut is
  announced, never hidden — the header says
  `truncated — showing newest 2,000 of M` and an in-log notice names the
  hidden count and the honest server-side truth: **the readout carries the
  full wave-log tail (no server-side cap)**, narrow the filter or read
  `.orch/wave-log.jsonl` for the complete paper trail. Pure `windowedTail` in
  `lib/view.ts` owns the numbers (`EVENT_LOG_DOM_WINDOW = 2_000`).
- **Decision (recorded 2026-11-08, D4)** — no server-side row cap ships in
  this slice. The readout path is the engine's (`inspector.ts` reads the whole
  `wave-log.jsonl`), and capping rows in the UI server would silently skew the
  completion report's wall-clock span (it reads `rows[0].ts`/`rows.at(-1).ts`)
  the moment a log outgrows the cap. Loopback transfer of the full tail stays
  "typical" per §13 at demo/realistic run sizes; a server-side tail cap (with
  a preserved run-start timestamp) stays unscoped until a real log outgrows
  it. The notice naming "no server-side cap" is the honest half of the deal.
- **Task-table row filter (§7.1)** — the §13/§16 deferral the M3 record
  documented ("row filtering stays a documented deferral") ships as a small,
  dense toolbar sibling of the event log's: a case-insensitive text match
  (id, title, dependsOn, target paths) + a status chip (`all statuses`,
  `todo`, `in progress`, `done`, `quarantined`), with a counted header
  (`tasks (2 of 12)`), a `reset` button while active, and a kind no-match
  state naming both active constraints. Pure `filterTasks` in `lib/view.ts`
  owns the math; it composes with the existing sort toggle (filter, then
  plan/failing-first order). Keyboard/a11y patterns unchanged: the inputs are
  plain Tab-reachable controls, typing in them already suppresses the global
  `/`/`?` shortcuts (the `typing` guard), the Esc chain is untouched, no new
  global keys exist.
- **Testing** — `view.test.ts` grows `windowedTail` (under/at/over the window,
  empty, the §13 default contract) + `filterTasks` (blank → all, status chip,
  id/title/dependency/target matches, AND composition) cases;
  `components-eventlog.test.ts` renders 2,005 rows and asserts exactly 2,000
  in the DOM, the explicit notice text, and its absence under the window;
  `components-tasktable.test.ts` covers text/status/combined filtering, the
  counted header, reset, the no-match kind state, and filter∘sort
  composition. All suites green: root `npm test`, ui `npm test`, `typecheck`,
  `check`, `build`, `test:e2e` (3/3).
- **Non-goals unchanged** — no M5 (config/PRD/router/delivery editors), no
  conversation search/paging, no per-wave isolated diffs, no mobile/LAN, no
  server-side row cap (D4), no new UI deps, no CLI behavior change.

## 0.5.2 — M4-b: delivery truth (§7.2 deferral, §8.6 rows, Appendix A.6)

The §7.2 "Delivery override" deferral is resolved the honest way — by NOT
inventing a mutation. Consumed kit seam: **A.6 (additive read-only readout
section; `readout.seam` stays 1 — A.6 is additive surface, not a new seam
version; the kit itself stays 0.2.2)**. No new deps, no CLI surface change.

- **Decision (recorded 2026-11-08, D3)** — there is no safe delivery toggle
  for the UI to own. Per §5, delivery stays a config + CLI decision; the
  CLI's only delivery paths are `.orch/config.toml`'s `delivery.mode`
  (config editing → M5) and the `--deliver` run qualifier the `pr` mode
  requires (delivery.ts: a per-run override of what a human typed — a UI
  that passes it silently changes run semantics vs the same command in a
  terminal, which is exactly the §5 non-goal and would also be a §7.2
  action-table change). So M4-b ships the READ-ONLY truth instead of a
  mutation, and the deferral is documented here, in the PRD's Appendix A.6,
  and in the report itself (stat title + kind empty note).
- **Core seam A.6** — `KitReadout` gains an additive `delivery` section:
  `mode` (the configured `none | commit | pr` from config; storage reads it
  from the open config, side-car mode best-effort re-reads the static config
  file and omits `mode` when it is unreadable) and `rows` (the wave log's
  kind `"delivery"` rows echoed as plain JSON shapes — ts, task, verb, wave?,
  detail). Root tests: 3 new A.6 cases in `test/ui-seam.test.ts` (a full
  commit-mode faux run echoing a real `delivered` row, side-car echo + mode
  from config, broken-config side-car keeping rows and omitting mode).
- **Completion report (§8.6)** — the delivery stat now says the MODE, not
  just a row count: `commit · 2 row(s)` / `none` / `1 delivery row(s) — mode
  unknown`; the outcome `pre` lists engine verbs verbatim (`delivered`,
  `commit-failed`, `pr-skip`) joined with their detail. A read-only, kind
  explanation rides the stat's title, and a `no delivery rows yet` details
  note appears only when the configured mode is `commit`/`pr` but no row has
  landed yet. There is deliberately NO delivery button in the ActionBar.
- **Notes** — delivery already surfaced as generic wave-log rows in the
  event log; it still does. The §8.6 "delivery mode/outcome rows" item is
  now fully true in one place (the readout's delivery section + the
  report's delivery stat/tail). Non-goals unchanged: no config/PRD/router
  editors (M5), no M4-c, no new UI deps.
- **Testing** — pure `deliveryReport` derivations in `lib/view.ts` (4 cases
  in `view.test.ts`); new `components-report.test.ts` mounts
  `CompletionReport` and covers mode·rows, the none/unknown/empty states,
  and the absence of any delivery mutation control. All suites green:
  root `npm test`, ui `npm test` (faux e2e 3/3 included).

## 0.5.1 — M4-a stage 2: transcript excerpts (§18 fast-follow, Appendix A.5)

Second half of the §18 fast-follow — the conversation drawer now shows bounded
transcript content, not just counters. Consumed kit seam: **A.5 (additive;
`readout.seam` stays 1 — A.5 is additive surface, not a new seam version; the
kit itself stays 0.2.2)**. Still no new deps, no CLI surface change.

- **Core seam A.5** (`src/engine/inspector.ts`, root tests in
  `test/ui-seam.test.ts`): `conversationEntries(loop, id, opts)` — a bounded,
  read-only transcript excerpt. Same BACKGROUND_CONTEXT gated table scan as
  `collectConversations` (never writes); plain JSON-able shapes only (entry ids
  as numbers, model-message timestamps as ms numbers, content/tool input as
  strings — no pi-durable types cross the module boundary, and the UI server
  still never imports kit.ts). The window is the summary scan's cap — at most
  4 pages × 500 = **≤ 2,000 entries** per request with a `truncated` flag; no
  pagination protocol in v1, the cap is the contract. Default order keeps the
  **newest** 2,000 (where the outcome lives); per-entry text/tool input is cut
  at 4 KiB with a visible marker. Thinking blocks stay model-internal and
  never render.
- **Endpoint** `GET /api/conversations/:id/entries` (§11.2 shape,
  `{ at, conversation, entries, truncated }`): storage-mode only, the same
  lock-per-read window as `/api/readout` — the harness opens, the excerpt
  scans inside it, the lock releases before the response completes; never held
  between requests. Unknown id → `404`; a live run owning the lock → `409` in
  the established tone ("conversation detail returns when the lock is free —
  a run is live"); same cookie auth as every other GET.
- **Drawer excerpt** — the stage-1 "transcripts stay deferred" banner is gone,
  replaced by the real thing: kind-labeled rows (`user`, `assistant · write`,
  `tool-result · failed`), wall-clock timestamps, assistant stop reasons, tool
  calls with their JSON input, **tool results collapsed** behind a
  show/hide button, and honest notices when a bound bites (the 2,000-entry
  window cut, per-entry 4 KiB cut). A mid-view lock loss swaps the excerpt for
  the established empty state and it fills back in on the next free read.
  Everything from stage 1 stays: summary fields, truncation-floor note,
  by-kind table, target paths, task-row highlight, `Esc` chain, both hash deep
  links.
- **Testing** — engine: 3 new A.5 cases in `test/ui-seam.test.ts` (shape after
  a completed run incl. tool calls + stability/read-only re-read, the
  >2,000-entry truncation both directions, at-cap-isn't-truncated + thinking
  omission). Server: new `test/conversation-entries-server.test.ts`
  (200/404/409/405/401, plain-JSON shapes, lock-per-read recovery). Client:
  `view.test.ts` gains `excerptErrorState` + `entryKindLabel`;
  `components-conversations.test.ts` mounts the drawer on a stubbed fetch and
  covers ready/truncated/empty/lock-busy/error states + the collapsed tool
  result. The faux e2e (3 cuts) is unchanged and stays green.

## 0.5.0 — M4-a stage 1: conversation visibility (§7.5 summaries)

First §18 fast-follow, stage 1 of 2 — summaries only, no core change (still
kit 0.2.2, A.1–A.3; no PRD edit, no new deps):

- **Conversation list** (§7.5) — a collapsible panel renders
  `readout.storage.conversations`: role chip, entry counts with a compact
  by-kind breakdown (`msg×8 tool×3 …`), resets/compactions, tool rounds, a
  `truncated` chip when the entry scan hit its page cap (counts are a floor,
  not exact), and per-conversation USD + tokens. Grouped sensibly: planner →
  one group per task with implementer conversations (several can map to one
  task; groups follow the task table's order) → verifier → other. Deep link
  `#/conversations` (sibling of `#/health`).
- **Summary drawer** — clicking a conversation opens the read-only drawer in
  the diff drawer's shell (same `Esc` chain, close button, hash deep link
  `#/conversations/<id>`): role, id, linked task, the counters, the by-kind
  table, target paths, spend + tokens — and an honest note that transcript
  CONTENT stays deferred (§18). The linked task row highlights in the task
  table (`row-link`, secondary to the live `row-cur`).
- **Storage-mode only, kind about it** — without `storage` (a run owns the
  lock) the panel and drawer show the established tone: "conversation detail
  returns when the lock is free — a run is live" — no spinner, no extra
  requests; the SSE re-snapshot fills it in.
- **Stage 2 is transcript content**, pending the Appendix A.5 seam session
  (bounded read-only entry excerpts; the A.5 proposal is drafted in this
  slice's handoff). The drawer labels the deferral instead of faking content.
- **Testing** — pure derivations in `lib/view.ts` (`conversationGroups`,
  `conversationById`, `hashConversationDrawer`, `isConversationListHash`,
  all strict/edge-proof like `hashDiffTask`) plus a component suite
  (`components-conversations.test.ts`): panel grouping/empty states/row→
  drawer callback, drawer fields + truncation note, task-table highlight.

## 0.4.1 — M3+ verification feedback (model readiness + failed-job reasons)

Found during the M4-entry approval walk: clicking **Plan** on a project whose
config has no role models spawned a doomed job that died at boot — the only
evidence was a toast with an exit code and a log file nobody opens. Three
fixes, all in `ui/`, no seam change (still kit 0.2.2, A.1–A.3), no deps:

- **Models are visible** — plan/run/resume dialogs render the configured role
  models as chips (`planner · anthropic · claude-sonnet-4-5`, or `· not
  configured`) from a new readout extra (`roles`, config-derived per snapshot —
  the same UI-only pattern as `sleep`/`prdPath`; the server reads
  `.orch/config.toml` per read, never writes it).
- **Preflight instead of a doomed job** — `POST /api/actions` for
  plan/run/verify answers `422` in kind words when the config misses the role
  block(s) the action needs (or the file itself is unreadable): `plan can't
  start yet: roles.planner has no model configured. In .orch/config.toml add:
  [roles.planner] provider = "openrouter" modelId = "openai/gpt-5-nano" …`.
  The dialog mirrors the same check (pure `modelPreflight` in `lib/view.ts`),
  disables the positive button, and quotes the block verbatim — unknown role
  info stays permissive (unknown is not missing; the server is authoritative).
  The kit's own loader diagnostic (`roles.planner: needs provider and
  modelId — e.g. …`) maps onto the prescriptive shape.
- **Failed jobs say why** — job payloads (`/api/jobs` + the SSE `job` event)
  carry a bounded, ANSI-stripped log tail on diagnostic outcomes (failed,
  stale, exit 42, runner-detail records; none for plain 0-exits/interrupts).
  The failed-job toast quotes the first diagnostic line; failed rows in the
  jobs panel show it inline with the full tail on hover.


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

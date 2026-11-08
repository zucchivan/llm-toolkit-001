# changelog

Manual semver discipline: keep `package.json` version and the newest section in sync.

## 0.2.2 — 2026-11-07

- **UI seam A.2/A.3 — display diffs (consumed by `ui/` 0.3.0, additive)**:
  - every task that reaches `done` writes `.orch/artifacts/task-<id>.patch`
    plus a stats side-car `task-<id>.json` BEFORE delivery, and every
    `quarantined` task keeps its `quarantined-<id>-w<N>.patch` and gains the
    matching `.json` side-car; reduces to the same `savePatch` throwaway-index
    semantics with a display wrapper (`src/util/git.ts`
    `computeDisplayPatch`/`saveDisplayPatch`):
    - engine-owned paths excluded (`.orch/**`, `router.md`, `PROMPT.md`),
    - 5 MiB cap (capped patch stored, `truncated: true` in stats),
    - stats via `git diff --numstat/--name-status` vs the baseline tree
      (untracked included, binary flagged),
    - ROLLBACK never reads these patches (`restoreTree` keeps the tree truth).
  - the per-task patch is CUMULATIVE since the baseline (retries don't reset
    the tree); it is rewritten at each terminal outcome.
  - `status.json` task entries carry `baselineTreeSha` (A.3) so an attached
    process can compute a live diff vs the baseline while a run owns the lock;
    the side-car's `wave-running` phase is now sticky across wave-internal
    commits (budget/verifier rows) so elapsed/live views stay truthful.
  - `readout()` gains `seam`'s `tasks[].diff` refs (`{ task, patch, stats?,
    bytes, truncated }`) and a `"diff"` artifact kind in both modes; no DB
    migration, no wave-log rows, no CLI output changes.
  - fix: the wave driver's `quarantine()` now receives the in-scope baseline
    (a wave-1 quarantine previously saw the stale task object and silently
    skipped the evidence patch; visible only when retryLimit = 0).
- No behavior change for users without the UI: the whole root suite
  (guards/breakers/e2e.smoke/inspect) passes unchanged.
- **UI seam A.5 (additive, 2026-11-08; consumed by `ui/` 0.5.1)**:
  `inspector.ts` gains `conversationEntries()` — bounded, read-only transcript
  excerpts for the conversation drawer: a ≤ 2,000-entry window (the summary
  scan's page caps) plus a `truncated` flag, per-entry 4 KiB text bound,
  plain JSON-able shapes (no pi-durable types cross the module boundary),
  same BACKGROUND_CONTEXT gated table scan as `collectConversations`.
  `readout.seam` stays 1 — A.5 is additive surface, not a new seam version;
  no CLI surface change, no behavior change when the UI is absent (root
  suite gains the A.5 cases in `test/ui-seam.test.ts`).
- **UI seam A.6 (additive, 2026-11-08; consumed by `ui/` 0.5.2)**:
  `readout()` gains an additive read-only `delivery` section — `mode` (the
  configured `delivery.mode`, echoed from config; never writable from the
  readout) and `rows` (the wave log's kind `"delivery"` rows as plain JSON
  shapes). Side-car mode best-effort re-reads the static config file and
  omits `mode` when the config is unreadable. Deliberately no delivery
  mutation surface exists in the CLI or the readout: delivery stays a
  config + CLI decision (the `--deliver` run qualifier the `pr` mode
  requires is a per-run override, not a toggle). No CLI output change, no
  behavior change when the UI is absent (root suite gains the A.6 cases in
  `test/ui-seam.test.ts`).

## 0.2.1 — 2026-11-06

- **fix**: a run whose queue drained with quarantined tasks no longer reports
  plain success — the terminal check counted terminal `quarantined` tasks as
  "done", so a fully-rolled-back session read `exit "complete"` with router
  doc phase "complete" and the green `STATUS: COMPLETE` line. Now:
  - a quarantine-free drain is unchanged: exit "complete", phase
    "complete", wave-log detail "queue empty", CLI `STATUS: COMPLETE`
  - drained with ≥1 quarantined → the run stops short (mirroring
    arrived-blocked): `RunSummaryInfo` gains `quarantined: string[]` with
    `complete` staying false (exit keeps its plain value — the id list is the
    truth), the router doc phase does NOT advance to "complete",
    status.json surfaces `complete — N task(s) quarantined: t3, t7`, the
    terminal wave-log row carries `queue empty; quarantined: t3, t7`, and the
    run-end console line names the quarantined ids (exit code stays 0) — no
    more bare "run stopped" line for the stop-short case; new progress event
    kind `quarantine-stop` with the ids
  - `statusPhase.message` now actually reaches `.orch/status.json` (the
    payload shape always declared `message`; `postCommit` dropped it)
  - todo tasks merely blocked by quarantined dependencies keep the existing
    arrived-blocked path; the `--tasks` filtered stop is untouched

## 0.2.0 — 2026-11-06

- **visibility**: one read-only `readout()` seam (`src/engine/inspector.ts`) that
  every view renders from — one `KitReadout` with identity, phase, tasks,
  wave-log rows, usage splits (session / per-model / per-task + spend rate), a
  wave timeline from the JSONL rows, artifact listing, conversation summaries:
  - **`inspect [--json] [--health] [section…]`** — the full lock-holder snapshot
    (tasks · usage · conversations · timeline · artifacts · health); while a
    live run holds `.orch/lock` it degrades to side-cars only, never touching
    storage, and health marks every storage-bound check skipped
  - **health checks**: version pin, PRD existence + sha drift vs the planned
    digest, status.json task parity, router.md / wave-log.jsonl mirror
    byte-parity, orphaned `in_progress` tasks, pending durable sleep task +
    cycle cap, quarantine patch coverage, active governor alert, consecutive
    error cap
  - **conversation summaries**: role via each unit's `loop.guard` doc, per-task
    `convId` join, entry counts by kind, resets, tool rounds, per-conversation
    usage from each conversation's `pi.usage` doc (where per-task USD joins come
    from)
  - **`export`** now writes report.json = the readout verbatim (+ generatedAt)
    and a richer report.html (wave timeline, usage by model, health table)
  - engine-owned `.orch/status.json` now records `lockedByPid` (the lock
    holder's identity survives into cross-process views)
- strictly read-only throughout: the inspector writes nothing; its one durable
  read is a writeless commit (`scanConversations`/`scanEntries` table scans)
- visibility opens (`status`/`export`/`inspect` when the lock is free) wire
  role providers leniently (`readView`): they never send model requests, so
  projects configured on unwired providers (e.g. `faux`) stay viewable; plan/
  run/verify still fail fast on unknown providers at boot
- the `patches` health check exempts zero-progress quarantines (their reverted
  diff is empty by definition — no patch file exists legitimately)

## 0.1.0 — 2026-11-05

First release.

- **engine** on `@earendil-works/pi-durable@1.5.0` (exact pin, boot-time PD
  version assert against `[engine] piDurable`):
  - sequential wave driver (one implementer wave at a time, topological task
    order, priority + id tie-breaks) — no parallel model fan-out beyond tool use
  - durable state via session docs: RouterDoc / WaveLogDoc / RunStatusDoc, with
    `router.md` + `.orch/wave-log.jsonl` mirrors and atomic `.orch/status.json`
  - planner: one read-only conversation, PRD → task graph (EARS-style
    acceptance, targetPaths, DAG validated before waves)
  - gates: scope check vs the task baseline tree (temp-index snapshot, never
    touching the user's git index) + argv-simple recipes from
    `evals/recipes.toml` with timeouts, match regexes and path fast-skip
  - verifier: read-only conversation per verdict, strict JSON parsing with
    `needs_human` on any deviation
  - governor: session USD ceiling, wave warn, zero-progress and
    duplicate-gate-hash breakers, consecutive-error cap, rate-limit durable
    sleep (`kit.sleep` via `sleepUntil`, exit 42 resume semantics)
  - quarantine: patch saved to `.orch/artifacts/` + exact baseline rollback
  - delivery modes `none` (default) / `commit` / `pr` (`--deliver`)
- **CLI** (`llm-toolkit-001`): init · plan · run · status · verify · export ·
  handoff; `node:util#parseArgs` only; exit 0/42/1 semantics; `.orch/lock`
  single-store-owner gate with live-PID recovery + polite busy errors
- **tests** (vitest, faux provider + injectable fake clock): fake-clock
  durability (sleep resume across re-open, crash resumption, requestId
  idempotence), e2e smoke on `examples/demo-prd` (gate-fail wave →
  conversation.reset → fixed wave), guard/breaker suite (beforeTool role
  boundaries, empty gates, budget stop, quarantine rollback, verdict parsing)
- **templates**: PROMPT.md, evals/checklist.md + recipes.toml (commented),
  annotated `.orch/config.toml`, router.md placeholder, .gitignore appends;
  `init` idempotency + `.orch/kit-version` provenance
- **faux overlay** (`KIT_FAUX=1`, optional `KIT_FAUX_SCRIPT`) for the 5-minute
  quickstart without API keys, incl. per-role replay sections and tool-call
  chunks

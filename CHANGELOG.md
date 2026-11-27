# changelog

Manual semver discipline: keep `package.json` version and the newest section in sync.

## Unreleased

- **M1-P03 preparation, not containment release:** fixed interrupted fencing
  recovery and fresh post-reopen fence observations; hardened journal identity
  decoding and canonical bounded complete inventories; added full projected-delta
  validation using the existing scope matcher, and a standalone bounded helper
  ABI/stdio adapter. These are offline preparation, not a wired local backend.
- **M1-P03 S1–S2:** added optional `installation.localLauncher` and a standalone
  Rust clone3 launcher with a pinned offline build and a single-use launch gate.
  Native placement and fencing tests passed on the Linux development host. S3
  starts with the versioned bundle format and offline validator. The launcher
  has no production caller and P03 conformance remains open.

- **M0 release gate**: `test/m0-release.test.ts` proves the prerequisite
  with a black-box run of the BUILT CLI (`node dist/cli.js`) over the
  shipped demo fixture — temp repos, faux replay re-read from disk by
  separate plan/run processes, independent full-run and subset projects
  (faux queues are process-local), ignored coverage plus sentinel
  staged/unstaged operator bytes asserted unchanged, and the product
  outcome asserted by executing `node bin/render.js '/a/-b'` inside the
  detached accepted result (stdout/stderr/status captured, not grepped
  from a mirror). A subset grant records no second task wave and no
  whole-plan completion; grant and outcome are never reconstructed from
  an edited `router.md` mirror across a locked/unlocked inspection
  window. Any red prerequisite suite blocks the release; there is no
  red-test suppression.
- `docs/project-contract.md` gains the M0 release & migration checklist:
  the exact verification commands, explicitly recorded compatibility
  breaks (v1→v2 payload migration and grant protocol, the M0-P14
  output-location cutover, receipt-backed `done`, budget admission), the
  exact no-key offline smoke command, and the admitted
  trusted-project-only security posture before M1 containment.
  `README.md` links the gate; no performance claim, no live PR creation.

- **opt-in shadow Jev failure triage**: `[gates] jevFailureTriageShadow`
  (default `false`) assesses existing deterministic gate failures and verifier
  rejection/needs-human feedback after their authoritative commits. Independent
  evidence, typed-category, implementation-feedback, and human-review questions
  share one bounded, secret-filtered failure-evidence request; no patch text is
  sent. Code owns conservative thresholds, categorization, and aggregation.
- Completed triage persists separately in `.orch/failure-triage-assessment.json`
  with model, evidence fingerprint, typed answers/probabilities, thresholds,
  token usage, and task/wave/source metadata—never raw failure text, patches,
  or credentials. Uncertain, conflicting, stale, missing-key, malformed, and
  network-error outcomes remain unknown. The assessment cannot change existing
  feedback, retries, quarantine, verdicts, task/adoption state, delivery, human
  approvals, or command execution.

- **opt-in shadow Jev verifier assessment**: `[gates] jevVerifierShadow`
  (default `false`) adds a separate System One assessment alongside the existing
  primary and skeptic verifiers. Three independent Noul questions per acceptance
  criterion cover evidence sufficiency, satisfaction, and concrete violation
  over one bounded, filtered task/diff/gate evidence state and one batched
  request. Code applies conservative 0.85/0.15 thresholds and leaves uncertain
  or conflicting conclusions `unknown`.
- Successful assessments persist `.orch/verifier-assessment.json` with model,
  evidence fingerprint, typed probabilities, thresholds, token usage, and
  per-criterion aggregation. Raw diff text and `TYPESAFE_API_KEY` are never
  persisted; changed evidence invalidates conclusions as stale. Missing keys,
  malformed answers, and network errors fail soft without client construction
  when no key exists, and no Jev outcome can change verdicts, gates, task state,
  retries, quarantine, delivery, or wave-log transitions. The existing judgment
  client/fake adapter provides injection; no commands are generated or executed.

- **interactive existing-project adoption**: deterministic read-only discovery
  (`discoverProject`) inventories npm scripts/lockfiles/workspaces, common
  test/tool config, project surfaces, and conservative CI command evidence.
  `gates list` reports factual human/generated/effective gates plus evidence and
  covered/missing/present-but-unwired/partial/N/A/unknown cross-cutting gaps.
- `gates refresh` adds recommended/individual/evidence/defer/reasoned-N/A flows,
  remembered evidence fingerprints, and approval previews for generated recipe
  additions/changes/removals. It writes `evals/recipes.auto.toml` only after
  approval, preserves human `evals/recipes.toml` (duplicate names override),
  supports workspace recipe `cwd`, and never executes the adopted checks.
- Missing implementations and unresolved commands can become explicitly
  approved `.orch/gate-remediations.json` planning input; the PRD is not edited,
  tests/dependencies are not generated, and normal RouterDoc approval remains.
  E2E/accessibility are surface-sensitive and excluded from fast recommended
  selection; libraries without browser journeys are not offered E2E.
- `gates probe` separately consents baseline execution (`--yes` when
  non-interactive) and reports pre-existing failures without changing adoption.
  Bare non-interactive refresh writes nothing; only explicit
  `--accept recommended` or `--skip-gates` records an adoption decision.

- **default-on adversarial verification**: `[gates] skepticSecondPass` now
  defaults to `true` in both the loader and scaffold template; an explicit
  `false` remains the opt-out. A primary approval opens a fresh read-only
  conversation on the existing verifier role with a dedicated brief that tries
  to refute approval across acceptance criteria, regressions, edge cases,
  missing tests, target-path scope, and security/data-loss risks.
- adversarial `reject` verdicts use the existing wave feedback/retry path;
  malformed, incomplete, unverifiable, or `needs_human` second-pass responses
  fail closed to `needs_human`. Both conversations append separate wave-log
  rows (`verify:*` and `verify:skeptic:*`) with their actual verdict, model,
  token, and USD usage.
- demo replays and faux end-to-end fixtures now script both approvals; focused
  tests cover omitted-config execution, explicit opt-out, rejection/retry,
  malformed output, inconclusive approval, and per-pass usage accounting.

## 0.2.3 — 2026-11-08

- **UI seam A.7 — per-wave isolated diffs (consumed by `ui/` 0.8.0, additive;
  `readout.seam` stays 1)**:
  - every wave's start and end rows capture the wave's own git tree (the same
    `captureBaselineTree` throwaway-index snapshot the baseline path uses,
    made inside the wave's existing commit windows — no new lock
    discipline) and record it as an optional additive `treeSha` on the
    `WaveRow`. A failed capture degrades to a row WITHOUT the field — that
    wave is simply not isolatable, never a failed run (deliberately softer
    than the baseline path's throw: a missing baseline is fatal, a missing
    wave tree is only a missing view). The runner's tree objects live in
    `.git` — no new artifact dir, no retention policy beyond git's own.
  - quarantine captures the wave's produced tree BEFORE the rollback, so
    the isolated wave diff names the evidence the wave made, not the empty
    post-restore tree.
  - `util/git.ts` gains `diffDisplayTrees` (tree-to-tree display diff; the
    exclusions/5 MiB-cap/stats tail is now the shared `displayPatchBetweenTrees`);
    `computeDisplayPatch` semantics are unchanged.
  - readout wave timeline spans echo `startTreeSha`/`endTreeSha` (plain
    JSON-able shapes; the A.6 echo style). No CLI output, config, or doc
    changes; the wave log stays at `version: 1` (an optional field).
  - fix (visible now because captures repeat per wave per task):
    `captureBaselineTree` named its throwaway index by pid and never removed
    it — a REPEATED capture in one process inherited the previous capture's
    staged state, so files deleted between captures wrongly survived in
    every later tree. Per-capture unique index + cleanup.
- the UI's consumption of all this (route + drawer) is `ui/` 0.8.0; the
  A.7 spec lives in `ui/PRD.md` Appendix A.7.

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

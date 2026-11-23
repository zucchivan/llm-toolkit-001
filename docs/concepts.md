# concepts

The vocabulary of the implementation loop kit, and how the pieces map onto the
durable harness.

## Roles

| role | conversation | tools | model source | purpose |
| --- | --- | --- | --- | --- |
| planner | ONE per plan (`kit-plan-v1` request id) | `[read]` only | `roles.planner` | PRD → RouterDoc tasks (id/spec/dependsOn/acceptance/targetPaths) |
| implementer | fresh ownerless conversation per new wave; same conversation/request reused only to reconcile that wave | read, write, edit, bash | `roles.implementer` | one private workspace lease per wave; PROMPT.md comes from the committed start tree |
| verifier | fresh per pass; adversarial pass follows a conclusive, evidence-backed primary approval by default | `[read]` only (+ beforeTool guard) | `roles.verifier` | strict-JSON verdict `approve`/`reject`/`needs_human`; approval requires per-criterion evidence on the checked tree (M0-P11) |

The implementer's final `STATUS: COMPLETE` / `STATUS: BLOCKED` line is only a
nonbinding report to the driver/operator. It is not criterion evidence and does
not itself change the task status.

## Four domain distinctions

- **Task** — a planned unit of work with its reviewed definition and dependencies.
- **Wave** — one numbered implementation attempt at a task; a retry is another
  wave, not a new task.
- **Gate** — a deterministic check run against one frozen candidate tree. Scope is the integration-parent→candidate delta; wave progress is the start-of-this-wave→candidate delta.
- **Verdict** — a read-only review judgment about specified criteria. A verdict
  is distinct from both an implementer's status report and a gate result.

Boundary hook (`kit-boundaries` extension, installed once, enforced everywhere):

- implementer: `write`/`edit` against `.orch/**`, `evals/**`, `router.md`,
  `PROMPT.md` is BLOCKED; with a non-empty `targetPaths` (per task, mirrored into
  the durable `loop.guard` doc) anything outside those paths is BLOCKED.
- planner/verifier: any non-read tool is BLOCKED (belt & suspenders over the
  `[read]`-only tool selection).

These guards are tool-policy checks, not security containment. Implementer bash
commands and gate/probe recipes execute project code on the host with the CLI's
permissions; no shell-free spawn or target-path check makes an untrusted project
safe to run.

## Stages

- **adopt** (optional, before/between plans) — deterministic `discoverProject`
  reads package scripts/lockfiles/workspaces, tool config, project surfaces, and
  conservative literal CI evidence without executing them. `gates list` exposes
  the factual human/generated/effective inventory and an evidence-based report.
  `gates refresh` requires human selection and diff approval before writing
  `evals/recipes.auto.toml`; human `evals/recipes.toml` always wins on duplicate
  names. Missing implementations/unresolved commands become approved planning
  remediations, not generated tests. `gates probe` is a separate execution
  consent step and reports pre-existing failures; it runs the same no-shell
  runner as wave gates with the same `[gates] timeoutSec` deadline, so wave
  and probe observe identical literal argv tokens and match results. Invalid
  recipes (both command forms, shell syntax in `cmd`, invalid `match` regex,
  escaping cwd) refuse before any command starts. Remembered evidence
  fingerprints suppress repeated nagging but reopen on meaningful changes.
- **plan** — one planner conversation parses the PRD plus any explicitly
  approved gate-gap remediations into tasks; the engine validates the graph
  strictly (empty plan, unsafe ids after normalization, colliding normalized
  ids, duplicate/unknown/cyclic deps, and missing or invalid `targetPaths`
  all reject with plain-words errors BEFORE any state is replaced — `[]` is
  the explicit "unrestricted admissible paths" marker, so a missing field is
  an error, not a silent default), then commits RouterDoc
  (`phase: "planned"`) with a FRESH plan identity + `router.md` mirror +
  wave-log row, and stops. The identity (`planRevision`) is a review id — a
  new UUID per plan, even for identical replans — not the storage schema
  version, and the CLI and the mirror both echo it. A replan archives the
  replaced plan's identity reference and invalidates prior grants in the
  same commit, so the second plan lacks the first grant. The mirror is not
  editable plan input: revise the PRD and rerun `plan` to replace the graph;
  a grant acts on durable RouterDoc state for the current revision.
  A stored plan from before identity existed (v1 payload) stays readable but
  is never executed — the documented upgrade is to replan, review, and
  approve.
- **grant** — the human approval of one reviewed plan revision (ADR 01):
  `{planRevision, selected, humanApprovedAt}` committed atomically with the
  phase flip to running and the review wave-log row. A new grant requires
  `run --approve --revision <uuid>` (no hidden default revision) and is
  refused while `router.md` is missing or differs from the canonical durable
  render — the approval binds to the reviewed bytes, never to hand-edited
  mirror text. Omitting `--tasks` grants every task id, stored EXPLICITLY
  (the full list is not a wildcard); repeated `--tasks <id>` grants exactly
  that subset, whose dependencies must be done or inside the selection —
  they are never auto-included. A bare `run` resumes the stored grant
  exactly (mirror edits are never imported); an explicitly supplied set
  without `--approve` must equal the grant. Only a changed grant (a new
  approval) admits different work.
- **base** — the reviewed starting point of a plan: the git HEAD commit (and
  its branch) captured at planning. Uncommitted operator edits (staged,
  unstaged, untracked) are EXCLUDED from that base — they are operator
  working files, never plan input, and before the first commit the base is
  recorded as absent rather than guessed. P14 execution requires a non-null
  committed base; create the intended seed/base commit and replan first.
- **wave** — the driver picks the next GRANTED `todo` task whose `dependsOn`
  are all `done` (dependency lookup sees every plan task; candidates come
  only from the grant; topological, priority then id). It opens a private
  workspace from the accepted integration commit, or the prior failed candidate
  on retry, then fences and freezes one candidate. The operator checkout is
  never captured or restored. Scope is parent→candidate; progress is this
  wave's start tree→candidate. A stable revision/task/wave/stage request key
  and checkpoint let resume reconcile the same submission instead of starting
  a second wave. The driver re-reads latest
  durable state before each selection and after completion. A satisfied
  subset reports selection-complete while the plan keeps its remaining work;
  only whole-plan fulfillment flips the router phase to complete (recorded
  once). A quarantined granted task stops the selection immediately; an
  uncertain receipt/effect returns `recovery-required` (CLI exit 2), leaves the
  task non-done, and stops before any dependent wave.
- **gate** — deterministic checks run as plain code phases (simpler diagnostics
  than an `afterRun` hook; both are viable, see api-map): scope check first on
  the immutable integration-parent→candidate delta, then effective recipes
  captured from the committed wave-start tree (`evals/recipes.auto.toml` plus
  human-overriding `evals/recipes.toml`). Recipes run in a private read view of
  that exact candidate (one command form per recipe — legacy whitespace-split
  `cmd` with shell syntax refused, or literal `argv` tokens; ALL stdout
  `match` regexes must match, empty list vacuously true; `on` path fast-skip;
  project-relative real-path-contained cwd). stdout past the 256 KiB capture
  cap with `match` present fails `output_capped` instead of matching on a tail;
  match evaluation runs in a bounded worker under the recipe's remaining
  deadline. Failures become compact feedback text and a `lastGateHash` for the
  breaker. Host execution is not an OS sandbox or containment boundary.
- **verify** — a fresh read-only verifier conversation is fed spec + criteria +
  per-file diff summary for this wave's start tree→candidate delta + the checked tree, the gate
  receipt id and the non-skipped gate outcomes. When that primary pass approves
  with valid criterion evidence, a SECOND fresh read-only conversation uses the
  same `roles.verifier` model but a dedicated adversarial brief: refute approval
  by checking every criterion, regressions, edge cases, missing tests,
  target-path scope, and security/data-loss risks. This skeptic pass is DEFAULT
  ON when `[gates] skepticSecondPass` is omitted; explicit `false` opts out.
  Both passes must approve, and approval is enforced SYMMETRICALLY (M0-P11):
  every reviewed criterion must be marked pass and cite valid evidence against
  the checked tree — an executed, non-scope, non-skipped passing gate, or a line
  in a regular text blob of that tree. Missing, malformed, duplicated, or
  unknown criterion ids, missing proof, malformed JSON, prose around the JSON,
  or an inconclusive answer refuse the approval as `needs_human`; a well-formed
  explicit `reject` stays reject. No skeptic runs after an invalid or
  nonapproving primary. Adversarial rejection becomes verifier feedback for the
  normal wave retry path. Each pass commits its own verdict row
  (`verify:*` / `verify:skeptic:*`) with its provider, model, tokens and USD
  usage — and its `loop.receipts` pass receipt (criteria, effective verdict,
  checked tree, gate id, policy) — BEFORE the next pass is dispatched. The
  one-off `verify --task` diagnostic owns its operation key: it records no
  wave-keyed pass receipts, and with no gate receipts a gate reference can
  never be evidence there. An explicit `[gates] jevVerifierShadow = true`
  adds a separate, non-authoritative Jev System One assessment after those
  verdict rows commit. Three batched Noul questions per criterion cover evidence
  sufficiency, satisfaction, and concrete violation over filtered, bounded
  task/diff/gate evidence. Code owns the 0.85/0.15 thresholds and aggregation;
  insufficient, conflicting, malformed, stale, or unavailable judgments remain
  `unknown`. Successful provenance goes only to
  `.orch/verifier-assessment.json` (without raw diff text or
  `TYPESAFE_API_KEY`), never to RouterDoc, gates, delivery, or wave control flow.
- **failure triage (optional shadow)** — `[gates] jevFailureTriageShadow = true`
  separately assesses existing deterministic gate failures and final verifier
  `reject`/`needs_human` feedback after their authoritative state commits. One
  batched request per failure event asks evidence/category/actionable/human-review
  questions over bounded, secret-filtered task, changed-file, gate-output, and
  verifier evidence (never patch text). Code applies conservative thresholds,
  categorization, and aggregation. Completed provenance goes only to
  `.orch/failure-triage-assessment.json`; raw failure text and credentials are
  not stored. Uncertain, conflicting, stale, missing-key, malformed, and network
  outcomes remain `unknown` and cannot change feedback, retries, quarantine,
  task/adoption state, delivery, human approvals, or any command execution.
- **deliver** — acceptance, integration, workspace recovery, and publication
  are separate receipted effects. `none` records `not_requested` and leaves the
  accepted lineage at `refs/kit/<revision>/accepted`; inspect it in a separate
  detached worktree. `commit` publishes the named local branch
  `refs/heads/kit/<revision>/result` without checking it out. `pr` requires
  `--deliver` and the operator's allowlisted GitHub origin before implementation
  starts; stacked PRs use verified create-only refs and are never auto-merged.
  The operator's HEAD, index, and working files remain unchanged in every mode.

## The governor (budgets + breakers)

All decisions append to `.orch/wave-log.jsonl` with a `reason`.

- **Session ceiling** (`budgets.sessionUsd`): cumulative estimated spend from
  `harness.usage()` — provider/catalog `Usage.cost.total` when reported, else
  `tokens × roles.*.costPerMillion*` rates. On an observed breach the loop ends
  gracefully (`resumable`; CLI prints the resume hint). This is not a hard bill
  cap: pricing can be incomplete, and one admitted in-flight request can overrun
  the ceiling.
- **Wave warn** (`budgets.waveUsdWarn`): warn row when one wave's estimated
  spend crosses the threshold.
- **Zero-progress breaker**: a wave that produces no changes from its own
  start tree to its frozen candidate is quarantined immediately — no
  `retryLimit` burn, even if the task has cumulative changes from prior waves.
- **Duplicate-failure breaker**: identical failing-gate hash two waves running
  (`lastGateHash`) → immediate quarantine.
- **Consecutive-error breaker** (`budgets.maxConsecutiveErrors`): unanswered
  run failures increment the persisted counter; reaching the cap quarantines
  with an alert. M0-P14 does not reset it on an answered wave, so it is not a
  strict back-to-back failure window.
- **Rate-limit sleep**: rate-limit-shaped errors parse a reset delay (or fall
  back to 30 min) and arm a DURABLE sleep task (`kit.sleep` via
  `runtime.sleepUntil`) — the driver exits 42; the next `run` waits out the
  sleep (real clock or the injected fake one) and resumes without cron code.
  `budgets.maxSleepCycles` caps the round-trips per task.

## Quarantine + workspace recovery

A failed/rejected frozen candidate is retained under its private Git pin and
receipted for review. The driver discards only the owned private workspace
lease, then records `discarded` after confirming the lease is absent and the
integration ref is unchanged. It does not reset, clean, stage, or restore the
operator checkout. A failed/unknown disposal is blocking: the task cannot be
done and dependents cannot start. Revision-qualified flat candidate artifacts
are display evidence only; checkpoint/rollback receipts are the recovery facts.

## Visibility

Every view of the kit renders the same snapshot. `readout()` (`src/engine/inspector.ts`)
assembles ONE `KitReadout` — identity, latest `planRevision`, receipt-state
projection, latest frozen `{wave,baseTree,candidateTree,asOf}` checkpoint,
phase, tasks, wave-log rows, usage splits (session / per-model / per-task + spend
rate), wave timeline, artifacts, conversation summaries, health checks — and
every surface consumes it:

| surface | command | mode |
| --- | --- | --- |
| live panel | `status [--follow]` | side-car first; storage briefly when the lock is free |
| full snapshot | `inspect [--json] [--health] [section…]` | storage under the lock; side-cars only while a run owns it |
| report files | `export` | storage under the lock; report.json = the readout verbatim |

Two readable modes, one rule: pi-durable storage is single-owner, so while a
run holds `.orch/lock` the inspector never opens it — it degrades to the atomic
side-cars (`.orch/status.json` + `.orch/wave-log.jsonl`), and its health
section marks every storage-bound check as skipped. `status` stays deliberately
cheap (side-cars first, no usage joins); `inspect` is the full lock-holder
snapshot. The inspector is strictly read-only: it writes nothing, and its one
storage table read is a writeless commit (`scanConversations`/`scanEntries`).

Health checks (`inspect --health`), id → meaning:

- `pin` — installed pi-durable vs the tested pin (and the `[engine] piDurable` claim)
- `prd` — PRD exists; sha drift vs `RunStatusDoc.prdSha` (planned digest)
- `status-sidecar` — .orch/status.json parses; task statuses match the RouterDoc
- `mirrors` — router.md / wave-log.jsonl byte-parity vs the durable docs render
- `orphan` — `in_progress` tasks with no live run (resumable)
- `pending-sleep` — the governor's armed durable sleep task + cycle cap
- `patches` — quarantined tasks missing their `.orch/artifacts/*.patch` artifact
- `alert` / `consecutive-errors` — governor alert + error cap surfaced
- `storage-skip` — degraded-mode marker (why sections are absent)

Conversation summaries (storage mode only): role attribution from each unit's
`loop.guard` doc (planner / implementer / verifier), per-task `convId` join,
entry counts by kind, resets, tool rounds, and per-conversation usage from each
conversation's `pi.usage` doc — that is where per-task USD joins come from.

## Why side-cars

pi-durable's SQLite is local-only and single-owner (§ one-process rule), so
`status --follow` in another process reads the ATOMIC `.orch/status.json`
side-car, and the local paper trail is `router.md` + `.orch/wave-log.jsonl`
(+ gate artifacts). Storage stays the durable truth; side-cars are best-effort
mirrors re-rendered after state commits, not guaranteed committed evidence.
The receipt journal—not a status color or display patch—records confirmed
workspace disposal, integration, and publication effects.

## Repository hygiene — three ownership classes

ADR 04 assigns every project path one ownership class, independent of
authorship (see `docs/project-contract.md` for the exact file lists):

- **reviewable** — project code, PRD, `PROMPT.md`, recipes, checklist, and the
  three kit controls (`.orch/config.toml`, `.orch/gate-decisions.json`,
  `.orch/gate-remediations.json`). Committable; never auto-staged by the kit.
- **optional local paper trail** — `router.md`, `.orch/wave-log.jsonl`,
  `.orch/kit-version`. Ignored by default: `init` writes one bounded
  `.gitignore` block (`/.orch/*` with the three reviewable negations and
  `/router.md`), so `git add -A` never sweeps the trail or private state into
  a commit. After review the human may explicitly retain any trail file with
  `git add -f <path>` — a tracked trail file is legal manual retention, not a
  hygiene violation.
- **private** — all other `.orch/**` runtime state (SQLite/WAL/SHM, lock,
  notes, projections, workspaces, assessments, telemetry, exports, UI jobs).
  Ignored by default; never published by kit action.

Hygiene conflicts are reported, never repaired: a pre-existing `.gitignore`
pattern that excludes the `.orch/` directory itself defeats the reviewable
exceptions (Git cannot re-include files under an excluded directory), and a
private file that is ALREADY TRACKED stays tracked because ignore rules do not
apply to tracked files. The kit never modifies the git index or history — no
forced `git rm --cached`, no history cleanup. Remediation is manual: adjust
the parent-excluding pattern, or run `git rm --cached -- <path>` yourself after
saving anything you need.

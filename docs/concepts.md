# concepts

The vocabulary of the implementation loop kit, and how the pieces map onto the
durable harness.

## Roles

| role | conversation | tools | model source | purpose |
| --- | --- | --- | --- | --- |
| planner | ONE per plan (`kit-plan-v1` request id) | `[read]` only | `roles.planner` | PRD → RouterDoc tasks (id/spec/dependsOn/acceptance/targetPaths) |
| implementer | ONE per task (`task-<id>`, resumed across waves) | read, write, edit, bash | `roles.implementer` | one wave = one task; PROMPT.md discipline attached |
| verifier | fresh per pass; adversarial pass follows a conclusive, evidence-backed primary approval by default | `[read]` only (+ beforeTool guard) | `roles.verifier` | strict-JSON verdict `approve`/`reject`/`needs_human`; approval requires per-criterion evidence on the checked tree (M0-P11) |

The implementer's final `STATUS: COMPLETE` / `STATUS: BLOCKED` line is only a
nonbinding report to the driver/operator. It is not criterion evidence and does
not itself change the task status.

## Four domain distinctions

- **Task** — a planned unit of work with its reviewed definition and dependencies.
- **Wave** — one numbered implementation attempt at a task; a retry is another
  wave, not a new task.
- **Gate** — a deterministic check run against the current baseline working-tree
  candidate (immutable candidate trees are proposed later, not current behavior).
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
  recorded as absent rather than guessed.
- **wave** — the driver picks the next GRANTED `todo` task whose `dependsOn`
  are all `done` (dependency lookup sees every plan task; candidates come
  only from the grant; topological, priority then id), captures the git
  working tree as `baselineTreeSha` (temp-index snapshot in `.orch/`, never
  touching the user's index), and submits one wave input
  (`requestId: "<task>-w<N>"`, idempotent). The driver re-reads latest
  durable state before each selection and after completion. A satisfied
  subset reports selection-complete while the plan keeps its remaining work;
  only whole-plan fulfillment flips the router phase to complete (recorded
  once). A quarantined granted task stops the selection immediately as a
  policy stop (CLI exit 2 with ids), never a drained-queue success.
- **gate** — deterministic checks run as plain code phases (simpler diagnostics
  than an `afterRun` hook; both are viable, see api-map): scope check first
  (diff-vs-baseline file set minus engine-owned paths), then effective recipes
  from `evals/recipes.auto.toml` + human-overriding `evals/recipes.toml`
  (one command form per recipe — legacy whitespace-split `cmd` with shell
  syntax refused, or literal `argv` tokens; ALL stdout `match` regexes must
  match, empty list vacuously true; `on` path fast-skip; project-relative
  real-path-contained workspace `cwd`). stdout past the 256 KiB capture cap
  with `match` present fails `output_capped` instead of matching on a tail;
  match evaluation runs in a bounded worker under the recipe's remaining
  deadline. Failures become compact feedback text and a
  `lastGateHash` for the breaker. These checks run directly on the host working
  tree and provide no sandbox or containment boundary.
- **verify** — a fresh read-only verifier conversation is fed spec + criteria +
  per-file diff summary vs the task baseline + the checked tree, the gate
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
- **deliver** — off by default (`delivery.mode = "none"`): approved waves stay
  in the operator's working tree, with diffs measured from each task's baseline.
  `commit` mode attempts one commit per approved task on the checked-out branch. `pr` mode
  optionally branches, commits, pushes, and calls `gh pr create --fill` when the
  run also has `--deliver`; it never merges the pull request.

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
- **Zero-progress breaker**: a wave that produces no file changes outside
  engine-owned paths (`router.md`, `.orch/**`, `PROMPT.md`) is quarantined
  immediately — no `retryLimit` burn.
- **Duplicate-failure breaker**: identical failing-gate hash two waves running
  (`lastGateHash`) → immediate quarantine.
- **Consecutive-error breaker** (`budgets.maxConsecutiveErrors`): that many
  back-to-back unanswered runs quarantine with an alert.
- **Rate-limit sleep**: rate-limit-shaped errors parse a reset delay (or fall
  back to 30 min) and arm a DURABLE sleep task (`kit.sleep` via
  `runtime.sleepUntil`) — the driver exits 42; the next `run` waits out the
  sleep (real clock or the injected fake one) and resumes without cron code.
  `budgets.maxSleepCycles` caps the round-trips per task.

## Quarantine + rollback

When a task is quarantined, the engine attempts to save the wave's diff against
`baselineTreeSha` to `.orch/artifacts/quarantined-<task>-w<N>.patch`, then
attempts `git read-tree` + `checkout-index` + `git clean -fd -e .orch` to restore
the working tree toward the baseline while preserving `.orch/`. Capture and
restore failures are currently best-effort and can be swallowed. Consequently,
a `quarantined` status, wave-log row, or patch does not prove complete rollback,
and subsequent tasks must not be described as guaranteed to see a clean tree.

## Visibility

Every view of the kit renders the same snapshot. `readout()` (`src/engine/inspector.ts`)
assembles ONE `KitReadout` — identity, phase, tasks, wave-log rows, usage splits
(session / per-model / per-task + spend rate), wave timeline, artifacts,
conversation summaries, health checks — and every surface consumes it:

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
mirrors re-rendered after state commits, not guaranteed committed evidence or
proof of an external effect such as rollback or delivery.

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

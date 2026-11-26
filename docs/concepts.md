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

## Local containment and provisioning (approved design, not active)

M1-P03 selects a small kit-owned Rust launcher to create the sandbox process in
its exact journaled cgroup before execution, plus Linux bubblewrap namespaces and
a versioned complete toolchain bundle. Rust is a maintainer/source-build tool;
ordinary users should use verified prebuilt assets. It reduces memory-safety risk,
not the need for syscall/FD/admission/owner-loss proof. Local remains shared-kernel
containment, not a VM, and is not yet certified or wired as the default.

**Provisioning** prepares/acquires, verifies and explicitly enrolls trusted tools
outside the project. It is separate from **execution**, which stays offline and
cannot install/fetch dependencies. Optional setup downloads and supplied offline
bundles are both planned; neither `init` nor a project run grants setup authority.
D1 means the operator reviews exact assets/provenance/hashes/paths/commands and
profile edits before host changes. Versioned installs are side-by-side and selected
explicitly; recovery retains its recorded bundle rather than silently upgrading.

A **sealed local result** will mean retained host-validated bytes from the complete
fenced projection, not a guest manifest claim or frozen JS object. It is privately
constructed and exposed through the existing lease candidate-ref CAS, with a
separately durable/reconciled receipt. This does not atomically commit Git and the
journal together or move integration/delivery ownership. Scanner/seal/publication
and real launch/conformance remain implementation work. See
[local status](../sandbox/local/README.md) and the
[operator contract](project-contract.md#linux-local-sandbox--approved-p03-provisioning-contract).

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
- **user handoff notes (M0-P17)** — `handoff "note"` publishes ONE atomically
  written note file under `.orch/handoffs/inbox/<uuid>.json` (≤ 2,000 chars;
  one file per invocation, so concurrent writers never race a shared queue).
  At each wave boundary the driver claims the oldest (ts,id) notes up to
  3,000 chars in total and binds the consumed ids AND text to that pending
  wave in the same state transaction that starts it (`HandoffDoc`); the files
  unlink only after the commit lands, so a crash between commit and unlink is
  a no-op on resume: the note is already bound — never lost, never redelivered
  to a later wave. Notes arriving after a wave's claim (including budget
  overflow left queued) apply to the NEXT wave. The pre-P17
  `.orch/pending-handoff.json` side-car imports once per unique content hash
  under the owner lock; invalid notes are diagnosed and quarantined under
  `.orch/handoffs/invalid/`. The UI keeps spawning the `handoff` CLI; it has
  no inline writer.
- **human resolution (M0-P18)** — `resolve` is the ONLY way a blocked
  (`quarantined`) task returns to work, and the only place a human — not a
  model — authorizes a tree. It requires the current plan revision, the current
  grant covering the task (it never broadens a grant), an eligible task state
  (quarantined, sealed wave), and verified recovery (rollback `discarded`, owned
  lease observed absent, unchanged accepted integration head).
  `resolve --revision R --task T --retry --reason TEXT` opens ONE fresh retry
  cycle: the task goes back to `todo`, `blockReason`/`lastGateHash`/
  `consecutiveErrors` are cleared, the task's durable sleep counter
  (`sleepCycles`) starts fresh, and the next wave is `waveCount + 1` starting
  from the CURRENT accepted head — never the failed candidate. Every earlier
  receipt, wave and feedback entry is preserved, and nothing is dispatched:
  the next authorized `run` does the work.
  `resolve --revision R --task T --accept-tree OID --evidence FILE --reason TEXT`
  is only for an inconclusive verifier block (`needs_human`, a typed
  `RouterTask.blockReason`, never a fifth status) with that wave's pinned
  candidate: lineage and the reviewed control bundle must be unchanged, the
  deterministic gates are RERUN on the exact frozen candidate, and the evidence
  document must prove every reviewed criterion. The recorded acceptance carries
  `authority: "human"` (policy `human-v1`) — never model approval — integrates
  locally, and leaves publication to an authorized `run` (PR still needs
  `--deliver`). Both forms derive a deterministic operation id from the request
  identity + tree + reason/evidence digest, so replaying one (a crash, or an
  operator rerunning it) reconciles instead of deciding twice. Every refusal
  prints the remedy. `verify --task` remains diagnostic: it writes review/usage
  history but never sets a task's status or unblocks dependents.
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

- **Paid-submission admission** (`budgets.sessionUsd`, M0-P16): ONE
  `admitSubmission(stage, checkpoint)` gate guards every paid submission — the
  planner conversation, every implementer retry, each verifier pass, and
  one-off `verify` — reading the fresh session high-water before any call. It
  refuses at `>=` (a zero ceiling refuses all paid work) and when observed
  spend is unpriceable; the stop is recorded (governor row + status) and no
  call is made. A `Models` dispatch guard wraps the session's Models object so
  EVERY provider dispatch inside a submission — the first request, tool
  follow-ups, SDK transport retries, compaction calls — passes the same
  high-water check; an after-response hook folds each finished turn's priced
  usage into the snapshot, so a submission that spends its allowance
  mid-flight is stopped before its next dispatch. Denial is a distinctive
  error the driver maps back to a budget pause — never a model failure, never
  a sleep, never a reject: the paused stage checkpoint and the verified
  candidate persist, and raising the ceiling resumes the same pass.
- **Pricing, never free**: provider/catalog `Usage.cost.total` when reported,
  else the Models catalog (per-class rates incl. cache classes), else
  `roles.*.costPerMillion*` config rates for input/output only. An unpriced
  cache delta is NEVER folded into the input rate (no flat-input
  approximation) — it pauses submissions; a previously used nonzero class
  with no price anywhere is likewise never labeled free. Fixture/faux
  providers may legitimately report simulated zero.
- **Stop ≠ reject; resume reconciles first**: an interrupted submission is
  reacquired by its exact request identity first (no second wave, no double
  charge — prior usage is always counted). A terminal failure is never
  replayed and its key never reused: the driver checkpoints a NEW submission
  attempt for the unfinished pass only. The wave warn compares the ACTUAL
  before→after delta of one submission attempt; the accumulator keeps the
  session-sum so resume never re-charges.
- **Session ceiling** (`budgets.sessionUsd`): the loop-top check uses the
  same fresh account (`>=`, incl. zero). Recorded spend is an estimate, not
  a hard bill cap: hidden transport retries and external services inside a
  provider implementation are visible only once usage lands, and one admitted
  in-flight request can overrun the ceiling. There is no speculative cost
  reservation and no provider-level midstream credit enforcement.
- **Wave warn** (`budgets.waveUsdWarn`): warn row when one submission
  attempt's before→after spend delta crosses the threshold.
- **Zero-progress breaker**: a wave that produces no changes from its own
  start tree to its frozen candidate is quarantined immediately — no
  `retryLimit` burn, even if the task has cumulative changes from prior waves.
- **Duplicate-failure breaker**: identical failing-gate hash two waves running
  (`lastGateHash`) → immediate quarantine.
- **Consecutive-error breaker** (`budgets.maxConsecutiveErrors`): unanswered
  run failures increment the persisted counter; reaching the cap quarantines
  with an alert. M0-P17: a successful ANSWERED submission resets the streak
  (never a mere timer wake), so a later task does not inherit an earlier
  task's transient failures.
- **Rate-limit sleep (bounded, M0-P17)**: rate-limit-shaped errors parse a
  reset delay (or fall back to 30 min). Each task owns a durable sleep counter
  (`RouterTask.sleepCycles`), checked BEFORE the durable sleep task
  (`kit.sleep` via `runtime.sleepUntil`) is created and incremented in the
  SAME transaction that records the task id and deadline. The counter is
  never reset just because a timer woke — it clears for the next task or an
  explicitly granted human retry. `budgets.maxSleepCycles` (incl. 0) caps the
  round-trips per task across restarts; when the cap is reached NO new timer
  is created — the wave quarantines once (exit 2) instead. A rate-limited
  submission is terminal: the invocation ends (exit 42) after checkpointing
  the NEXT attempt's unique request key under the same task's counter, so the
  post-sleep resume dispatches a fresh request instead of replaying the same
  request id forever.

## Quarantine + workspace recovery

A failed/rejected frozen candidate is retained under its private Git pin and
receipted for review. The driver discards only the owned private workspace
lease, then records `discarded` after confirming the lease is absent and the
integration ref is unchanged. It does not reset, clean, stage, or restore the
operator checkout. A failed/unknown disposal is blocking: the task cannot be
done and dependents cannot start. Revision-qualified flat candidate artifacts
are display evidence only; checkpoint/rollback receipts are the recovery facts.

A quarantined task does not decay into “done” and no model may self-accept it.
Two binding human decisions exist (`resolve`, above): `--retry` requeues the
wave from the accepted head with a fresh attempt quota, and `--accept-tree`
records a `human-v1` acceptance of a retained `needs_human` candidate after
re-running the deterministic gates on it. Both are refused without a matching
revision, the current grant, eligible task state, and verified recovery; both
are idempotent; and neither publishes. `quarantined` therefore means “waiting
for a human decision or a repair”, not “finished”: a run keeps reporting the
blocked ids with exit 2 until either a resolution or an authorized wider grant
changes the durable state.

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

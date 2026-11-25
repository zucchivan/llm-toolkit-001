# project-contract

What `<kit> init` writes in a target project, and how versions move.

## Files created (idempotent, never clobbered)

| file | purpose | engine-owned? |
| --- | --- | --- |
| `PROMPT.md` | per-wave discipline appended into each implementer wave input | template (user-editable) |
| `evals/checklist.md` | human-editable acceptance-criteria template aligned with the RouterDoc schema | template (user-editable) |
| `evals/recipes.toml` | human gate recipes — COMMENTED defaults; empty = scope-check-only; same names override generated recipes; one command form per recipe (`cmd` legacy simple, or literal `argv` tokens) | template (user-editable; snapshotted into the reviewed plan and read from each wave-start tree) |
| `evals/recipes.auto.toml` | approved discovered gate recipes; supports project-relative `cwd` for workspaces | generated only by approved `gates refresh`; absent initially |
| `router.md` | human-readable MIRROR of RouterDoc; engine rewrites it on router commits; review it, but revise the PRD and replan instead of editing it as input | engine |
| `.orch/config.toml` | annotated project config (roles, budgets, gates, delivery, paths) | config |
| `.orch/kit-version` | provenance line: `kit=<kit> pi-durable=<pinned>`; `<kit>` is the package version (see below) | engine |
| `docs/prd.md` | placeholder when `--with-demo`, otherwise absent (user brings the PRD) | user |
| `.gitignore` | appends ONE bounded, idempotent `llm-toolkit-001` hygiene block — `/.orch/*`, `!/.orch/config.toml`, `!/.orch/gate-decisions.json`, `!/.orch/gate-remediations.json`, `/router.md` — preserving existing comments/custom patterns (never removed) | appended |

Adoption state is written only by approved `gates refresh`:
`.orch/gate-decisions.json` remembers accepted/deferred/skipped/N/A findings,
evidence fingerprints, and N/A reasons; `.orch/gate-remediations.json` contains
approved planning recommendations. They are deliberate project decisions, not
runtime caches, and may be committed. Refresh never edits `docs/prd.md`.

Opt-in Jev shadow verification writes separate `.orch/verifier-assessment.json`
provenance after successful judgment calls. It contains model, evidence
fingerprint, typed Noul probabilities, thresholds, usage, and code-owned
aggregation, but no raw diff or credentials. A fingerprint mismatch makes its
conclusions stale/unknown. It is never an adoption decision or verifier verdict.

Private runtime paths are ignored by the init template through one bounded
block (`/.orch/*` plus the reviewable exceptions and `/router.md` above).
These artifacts are best-effort local evidence, not guaranteed commits or
effect receipts.

## config.toml fields (role identities required; other settings defaulted)

- `[engine]` — `piDurable` (pinned release, asserted against the installed
  package at boot), `maxTurns` (tool rounds per run, default 50), `retryLimit`
  (waves per task before quarantine, default 3)
- `[roles.planner|implementer|verifier]` — each role block requires string
  `provider` and `modelId` identities; these fields are not optional. Optional
  `thinkingLevel`, `costPerMillionInput`, and `costPerMillionOutput` provide
  thinking configuration and USD-rate fallback for budget estimates when
  providers/catalogs do not report cost.
- `[budgets]` — `sessionUsd` is the paid-submission ceiling (M0-P16): the
  planner, every implementer retry, each verifier pass, and one-off `verify`
  are admitted fresh and refused at `>=` (zero refuses all paid work); the
  Models dispatch guard also covers every provider dispatch inside a
  submission (tool follow-ups, SDK retries, compaction). Unpriceable observed
  spend pauses submissions with a distinct reason — never approximated,
  never labeled free. A stop is a pause, not a reject: the paused stage
  checkpoint and verified candidate persist, and raising `sessionUsd`
  resumes the same pass (terminal failures are never replayed; request keys
  are never reused). Also `waveUsdWarn` (per-attempt before→after delta),
  `maxConsecutiveErrors`, `maxSleepCycles`. Not a hard provider-bill cap: an
  admitted in-flight request can exceed the ceiling and there is no cost
  reservation.
- gate recipes — `[name]` tables in `evals/recipes.toml` and approved
  `evals/recipes.auto.toml`: EXACTLY ONE command form each — legacy `cmd`
  (trimmed and split on whitespace only; shell quoting/pipes/redirections/
  expansions are refused with a pointer at argv) or literal `argv` tokens
  (spaces, empty values and metacharacters are data). Optional stdout `match`
  regexes (ALL must match; compiled before any recipe runs; never stderr),
  path fast-skip `on`, and optional project-relative `cwd` (real-path
  contained: symlink escapes refuse). Human duplicate names override
  generated entries. Wave gates and `gates probe` share one no-shell runner
  and its deadline rules; stdout past the 256 KiB capture cap with `match`
  present fails `output_capped`. Invalid input fails before any command
  starts; failures become compact feedback text and a `lastGateHash` for the
  breaker. Recipe cwd cannot be absolute or escape the root.
- `[gates]` — `timeoutSec` (per recipe; also the `gates probe` deadline), `enforceTargetPaths` (parent→candidate scope check + write/edit guard; neither is OS containment and bash/recipes still execute on the host),
  `skepticSecondPass` (default `true`, including when omitted): after a conclusive,
  evidence-backed primary approval, a fresh read-only adversarial verifier must
  also approve. Explicit `false` is the single-pass opt-out. The adversarial pass
  checks criteria, regressions, edge cases, missing tests, scope, and
  security/data-loss risks; malformed or inconclusive output becomes
  `needs_human`, never approval. Approval is enforced SYMMETRICALLY (M0-P11):
  every pass must mark each reviewed criterion pass and cite valid evidence
  against the checked tree — an executed, non-scope, non-skipped passing gate, or
  a line in a regular text blob of that tree; scope alone proves nothing. Wave
  log rows `verify:*` and `verify:skeptic:*` record each pass's verdict and
  usage, and each pass commits a `loop.receipts` pass receipt (criteria, checked
  tree, gate id, policy) BEFORE the next pass is dispatched; the wave's gate
  outcome commits a gate receipt binding the checked tree and every check
  outcome (including skips and failures). The one-off `verify --task` diagnostic
  records no wave-keyed pass receipts, and without gate receipts a gate
  reference is never evidence there.
  `jevVerifierShadow` (default `false`) separately opts into a batched,
  shadow-only Jev assessment over filtered task/diff/gate evidence. Successful
  assessments persist `.orch/verifier-assessment.json`; uncertain, stale,
  missing-key, malformed, and network-error outcomes remain unknown and cannot
  alter verdicts, gates, task state, retries, quarantine, or delivery. Raw diff
  evidence and credentials are not stored in the assessment.
  `jevFailureTriageShadow` (default `false`) independently opts into batched,
  shadow-only triage of existing gate failures and verifier rejection/needs-human
  feedback after the authoritative failure commit. Successful assessments persist
  `.orch/failure-triage-assessment.json` with typed provenance, not raw failure
  text, patches, or credentials. All thresholds, categories, aggregation, and
  effects remain in code; uncertain, conflicting, stale, missing-key, malformed,
  and network-error outcomes remain unknown and cannot alter feedback routing,
  retry limits, quarantine, task/adoption state, delivery, or approvals.
- `[delivery]` — `mode`: `none` (default) | `commit` | `pr`. M0-P14 activates journaled publication: `none` leaves the accepted lineage at `refs/kit/<revision>/accepted`; `commit` publishes `refs/heads/kit/<revision>/result` without checking it out; `pr` requires the operator host-policy GitHub origin and explicit `run --deliver` preflight before grant/work dispatch. PRs are stacked, create-only, validated, and never merged.
- `[paths]` — `prd` (default `docs/prd.md`), `specs`

NO SECRETS live in config.toml: providers read credentials from the
environment, exactly as pi-ai expects (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`). The optional Jev shadows use
`TYPESAFE_API_KEY` from the environment as well; no API key is a config field or
assessment property.

Idempotency: `init` writes a file only when it is absent or empty; when a
user-edited file exists it is LEFT UNTOUCHED and reported under
"kept existing (not clobbered)". The `.gitignore` hygiene block appends only
when its marker is missing; running `init` twice appends it once. Init does not run
discovery adoption or create `recipes.auto.toml`.

## Project adoption contract

1. `gates list` performs deterministic read-only discovery and prints a factual
   inventory plus covered/missing/present-but-unwired/partial/N/A/unknown
   findings with evidence. No discovered script or CI YAML is executed.
2. Interactive `gates refresh` supports recommended selection (fast checks only),
   individual selection, evidence inspection, defer/skip, and reasoned N/A.
   Selection is followed by an explicit generated-file diff and write approval.
3. Refresh writes only `evals/recipes.auto.toml` and the two adoption JSON files.
   Missing implementations and unresolved commands become reviewed planner
   input, never silently generated tests or blocking heuristic commands.
4. `gates probe` separately confirms execution. Non-interactive probe needs
   `--yes`; failures remain pre-existing baseline failures and change no
   adoption state.
5. Non-interactive refresh is read-only unless `--accept recommended` or
   `--skip-gates` is explicit. New evidence fingerprints reopen remembered
   findings; refresh additions/changes/removals require approval.
6. On the next `plan`, approved remediations are additional planning
   requirements. Review the durable RouterDoc through its `router.md` mirror;
   to change the graph, revise the PRD/remediations and replan rather than
   treating mirror edits as input. A grant approves RouterDoc state for the
   plan's durable `planRevision`, which `plan` prints and the mirror shows:
   `run --approve --revision <uuid>` (there is no hidden default revision),
   with repeated `--tasks <id>` for an explicit subset or none for every
   task, stored explicitly. Approval binds to the reviewed mirror bytes — a
   missing or edited mirror refuses the grant (replan to refresh) — and a
   bare `run` resumes exactly the stored grant, never importing edits.

## Plan identity (review ID ≠ schema version)

Every successful `plan` mints a fresh identity for the reviewed graph:
`planRevision` (a new UUIDv4 per plan, even for identical replans),
`definitionSha256` (canonical SHA256 over the immutable task definitions —
recursively sorted keys, order-preserving arrays, UTF-8 JSON; status,
counters, and receipts are not part of it), `baseCommit`/`baseBranch` (git
HEAD and its branch at planning; `baseCommit` is `null` before the first
commit, and uncommitted operator edits are excluded from the reviewed base),
normalized project-relative `prdPath` + `prdSha256`, and `controlsSha256`
over the reviewed control bundle captured ONCE before the PRD is disclosed:
every regular-file byte under `evals/**` (executable assertion scripts and
binary fixtures included), `PROMPT.md`, the approved gate remediations, the
actual configured/`--prd` file, and the effective verification, delivery,
routing and admission policy settings. `budgets.sessionUsd` is deliberately
not part of it — raising only the session ceiling resumes the same reviewed
plan. `controlsSha256` is ABSENT only when no control input exists at all —
distinct from a digest over empty controls, and absent remediations hash
differently from an approved empty list. Unreadable, symlinked, hard-linked,
non-regular or malformed review controls refuse rather than becoming absent
inputs. Approval, resume and every fresh wave/retry boundary refuse a moved
HEAD, a changed actual PRD or changed reviewed bytes/settings; already-journaled
effects reconcile only against their recorded identities and never rewrite a
receipt. A plan created before this widened coverage must be replanned (the
recorded old digest is compared as recorded, never silently recomputed). The
PRD must be a regular project file before reading or model submission. M0-P14
execution requires a non-null `baseCommit`; if planning records no committed
HEAD, make the intended local seed/base commit and replan before granting a
run. Staged/unstaged/untracked operator data is never used to fill a missing
base.

The `planRevision` is a REVIEW identity, not a schema version: the durable
document payload versions (`loop.router`/`loop.run` at version 2) describe
storage shape, and bumping them is a migration concern, not a new plan.
Grants are the ADR 01 triple (`approvedPlanRevision` + `approvedSelected` +
`humanApprovedAt`); a stamp missing any leg — including a migrated v1
timestamp or a pre-grant v2 revision+time pair — authorizes no run, and a
successful replan clears the whole triple atomically while archiving the
replaced plan's identity references (references only, never receipts;
legacy v1 plans had no identity, so replacing one archives nothing).

A mutating `run` refuses — before any wave or model dispatch — and never
broadens a refused grant:

- an unmigrated legacy plan (a task graph with no `planRevision`), even with
  a well-formed `--approve --revision` — the documented v1 upgrade is:
  reconcile any operator edits manually, commit the intended base, `plan`
  again (this archives the old plan, where one existed, and clears old
  approvals), review `router.md`, then `run --approve --revision <uuid>`;
- a new grant (`--approve`) without an explicit `--revision`, or with one
  that does not name the CURRENT `planRevision` (an old revision refuses,
  the grant untouched);
- a granted subset with unknown ids, duplicate `--tasks` entries, or an
  unsatisfied dependency outside the selection (named culprit; dependencies
  are never auto-included);
- a new grant while `router.md` is missing or differs from the canonical
  durable render — replan to refresh the mirror;
- a bare run whose stored grant is missing, incomplete, or does not name
  the current `planRevision` — rerun with `run --approve --revision <uuid>`
  after reviewing `router.md`;
- an explicitly supplied `--tasks` set (without `--approve`) that does not
  equal the stored grant exactly.

`run` exit codes: `0` only for whole-plan fulfillment (`STATUS: COMPLETE`;
the ONLY outcome that flips the router phase to complete, recorded once) or
selection-complete (the granted subset is fulfilled; the remaining plan
work is named and the phase stays open) · `2` policy stop — quarantine,
unsatisfiable selection, budget stop, or unresolved/uncertain effect reported
as `recovery-required` · `42` sleeping — a rate-limit durable sleep is armed;
the per-task sleep counter (`budgets.maxSleepCycles`, incl. 0) is checked
BEFORE the timer is created, never reset by a wake, and a cap-exhausted task
quarantines once (exit 2) with no new timer · `1` invalid input (including a
handoff note over 2,000 chars)/lock/hard error ·
`130` SIGINT.

Failed plan parsing or identity-input failures (git, paths, controls) leave
the previous plan, run status, and mirrors byte-identical.

## M0-P14 serial candidate and result contract

A new wave opens a private workspace from the current `refs/kit/<revision>/accepted`
commit; a retry starts from the previous failed candidate while retaining the
same integration parent. The driver records a stage checkpoint and stable
conversation/request identity before each model submission, fences the writer,
and freezes one candidate tree. Gates and verifier passes read that exact
candidate. Scope is checked from integration parent→candidate; zero-progress
uses only the start-of-this-wave tree→candidate. Pinned candidates and
revision-qualified flat `candidate-<revision>-<task>-w<N>.{patch,json}` artifacts
are retained for review. Artifacts are display evidence, not rollback inputs.

Acceptance, integration, workspace disposal, and publication are separate
receipted effects. `done` requires valid acceptance and integration receipts
plus a confirmed publication result (`not_requested` for `none`). Uncertain
publication or workspace disposal is blocking `recovery-required`: the task is
not done and no dependent task starts. Recovery reuses the recorded candidate,
commit, and submission identity; it does not pay for implementation or review
again. Quarantine discards only the kit-owned private workspace after observed
fencing and an unchanged integration ref; it never restores the operator tree.
A checkpointless legacy `in_progress` task is ambiguous and refuses replay.

`run` never uses staged, unstaged, untracked, or ignored operator checkout
content as task input. HEAD, the index, working files, and ignored files remain
unchanged in `none`, `commit`, and `pr` modes. Result locations:

- `none`: create a separate view with
  `git worktree add --detach /path/to/result refs/kit/<revision>/accepted`.
  The accepted result is not written into `.`.
- `commit`: inspect `refs/heads/kit/<revision>/result`; the driver does not
  check it out or advance the operator branch.
- `pr`: inspect the receipted stacked PR branch/URL. `--deliver`, the exact
  operator-approved GitHub origin, and the reviewed base-branch preflight are
  required before implementation starts; PR creation never merges the result.

`verify --task <id>` is diagnostic only: it reads the newest retained candidate
for the current plan revision and refuses if no candidate exists. Before its
paid submission it validates the reviewed identity, so a changed eval byte or
verification policy refuses with no model call and no pass receipt. It does not
read current operator-checkout edits or change task disposition — approving a
one-off verification never marks a task done, never unblocks a dependent and
never advances the integration ref.

## Human resolution contract (M0-P18)

A `quarantined` task is unblocked only by a human decision recorded through the
CLI. Two copyable forms exist; both require `--revision` (the CURRENT reviewed
plan revision), `--task` (a task inside the CURRENT grant) and `--reason`
(1–300 characters). Any other combination is refused with a remedy and exit 1.

```bash
# 1. retry: one fresh cycle from the current accepted head
llm-toolkit-001 resolve --revision <uuid> --task <id> --retry \
  --reason "reviewed the failing gate output; the parser fix is in scope"

# 2. accept-tree: only for an inconclusive verifier (needs_human)
llm-toolkit-001 resolve --revision <uuid> --task <id> --accept-tree <tree-oid> \
  --evidence evidence.json --reason "read the diff; the executed gate proves criterion 1"

llm-toolkit-001 run            # the authorized run does the work / finishes publication
```

The candidate OID for `--accept-tree` is the retained frozen candidate shown by
`inspect --json` (`checkpoint.candidateTree`) and by the quarantine row.

Evidence document (regular local file, UTF-8 JSON, at most 64 KiB, no symlink,
exactly one top-level key):

```json
{
  "criteria": [
    { "id": "1", "status": "pass", "evidence": [{ "kind": "gate", "id": "gate-list" }] },
    { "id": "2", "status": "pass", "evidence": [{ "kind": "line", "path": "src/list.ts", "line": 12 }] }
  ]
}
```

- `id` is the criterion's reviewed 1-based acceptance index (never renumbered
  after review). Missing, duplicated, or unknown ids are refused.
- A `gate` reference names a recipe that actually EXECUTED and PASSED on the
  rerun; scope alone is never evidence. A `line` reference must exist in a
  regular UTF-8 blob of the frozen candidate.
- Malformed entries are preserved and refused, never filtered.

What `resolve` will refuse (each with the remedy printed):

- a revision that is not the current plan revision, a missing/incomplete
  grant, or a task outside the grant (a resolution never widens a grant);
- a task that is not `quarantined`, or whose latest wave is not sealed
  (`terminal` checkpoint), or any `unknown` checkpoint (uncertain effects are
  never manually approvable);
- a moved accepted integration head, a rollback receipt that is not
  `discarded`, or a workspace lease still present (the wave is not fenced);
- `--accept-tree` on anything but a `needs_human` block, a tree that is not
  that wave's pinned candidate, changed reviewed controls, any deterministic
  gate that fails or skips, and any evidence that does not prove every
  criterion.

What each decision writes:

- `--retry`: task back to `todo`, `sleepCycles` = 0 (the `budgets.maxSleepCycles`
  counter starts fresh), `lastGateHash` and `consecutiveErrors` cleared, a human
  feedback entry, a `resolution` receipt, and a `terminal`/`retry` checkpoint
  whose parent is the unchanged accepted head. The next authorized `run` starts
  `wave + 1` from that head with a fresh attempt quota. Nothing is dispatched
  and no integration/publication effect changes.
- `--accept-tree`: a new gate receipt for the rerun, an acceptance receipt with
  `authority: "human"`, `policy: "human-v1"`, `required: ["human"]`, a
  `resolution` receipt, and LOCAL integration (private one-parent commit + the
  `refs/kit/<revision>/accepted` compare-and-swap). The task becomes
  `in_progress`, not `done`: `commit`/`pr` publication still happens only in an
  authorized `run` (PR needs `--deliver`, and nothing is ever merged).
- Both forms are idempotent: the operation id is a deterministic digest of
  (revision, task, wave, action, reason, tree, evidence digest), so replaying a
  request reconciles to the recorded decision — including finishing an
  interrupted local integration — instead of recording a second one.

`resolve` never reads or edits the operator checkout, never replays a truncated
quarantine patch, never force-dones a task and never delivers remotely. It is
the only thing that unblocks a dependent task B of a blocked task A: a `run`
keeps stopping with exit 2 and naming the ids until the human retry or the
human acceptance changes the durable state (an accepted tree also becomes the
integration head B's wave starts from).

## Read-only observation

`status`, `inspect`, `export`, and the web UI's reads are observers. They
acquire `.orch/lock` and open durable storage through the harness's `readOnly`
option: no scheduling, no admission or recovery writes, no task progress, zero
model/tool dispatches (an observer builds no providers at all), and any commit
with writes rejects with the SDK's `ReadOnlySession`. A project that has never
run has no `.orch/durable.sqlite`; observation refuses to create one and
reports empty/absent evidence from the side-cars instead (`status` renders an
empty panel). While another process owns the lock, the same commands degrade
to side-car-only reads. The pinned SDK seam itself is documented and
mechanically enforced per `docs/api-map.md` (M0-P02).

### Host path refusal and reviewed-control identity (M1-P01 steps (c)–(d), prepared — not certified)

When the host reads a PRD (`[paths] prd` or `--prd`), captures the reviewed
control bundle (all `evals/**` regular files, `PROMPT.md`,
`.orch/gate-remediations.json`, the actual PRD and the effective policy
settings), reads the gate recipes at execution time, or serves the UI's
config/PRD/source/artifact views, it:

- canonicalizes the project root once and reads only root-relative names
  through a no-follow component walk (`src/util/safe-read.ts`);
- refuses a symlink at any component (including the `.orch` or `evals`
  ancestor), a hard-linked regular file (an alias could name a same-owner host
  file), an absolute/`..`/drive/UNC escape, a non-regular leaf, malformed
  UTF-8/NUL text, and a file past the §2 cap (32 MiB/file, 512 MiB per shared
  read budget, 100k entries per walk);
- keeps a genuine ENOENT as the defined "absent" input (an absent recipe file
  is still empty gates; absent controls still hash as absent);
- never falls back to `realpath`-then-open, PATH, cwd or a project env selector
  when the race-safe primitive is unavailable — it refuses instead.

The reviewed identity is captured ONCE before the PRD is disclosed and is
validated at a new grant, on resume, at each fresh wave/retry boundary and
before a one-off `verify --task` paid submission. A changed actual PRD,
non-recipe eval script, recipe, remediation approval or effective verification/
delivery/routing/admission setting refuses NEW work with a replan remedy;
raising only `budgets.sessionUsd` is not drift. A plan planned before the
widened identity coverage must be replanned: its recorded digest is compared as
recorded, is named as a pre-step-(d) migration rather than a false on-disk edit,
and is never rewritten. Reconciliation of already recorded effects uses the
pinned receipts/identity and does not fall through into a fresh wave.

The identity's normalized `prdPath` is ALSO the read-only reservation. Projection
and candidate admission reserve that literal path (including while the file is
absent), so a task with an empty `targetPaths` list or a `docs/**` target still
cannot modify or recreate the PRD; a read-only/verify projection can read it.
The driver executes recipes and `PROMPT.md` from the immutable reviewed base
tree, never from the operator worktree. Planning therefore refuses, before the
PRD is disclosed, when a committed `evals/**` file or `PROMPT.md` was edited or
deleted without a commit: the operator must commit the reviewed control bytes
and replan. A new UNTRACKED control file is captured in the identity but cannot
execute from the base tree; it is reviewed-but-not-executable until committed
and replanned. This is the chosen smallest fix: one base-tree/execution reader,
no second persisted recipe bundle.

The UI source payload reports a refusal as `refused:{code,message}` with no
text (never as plain absence). The M0 delivery-only host-profile view
(`readApprovedDeliveryOrigin`) is unchanged. Trusted CLI/UI launch
resolution and the `inspect`/handoff/config readers are NOT yet cut over; they
need a strict-path amendment recorded in
`docs/engineering-plan/evidence/M1-P01.md`. No sandbox backend, rootfs or
launch is enabled by this step, and M1-P01 is not complete or certified.

### Trusted host installation and callback-free Git (M1-P01 step (e), prepared — not certified)

Host Git/gh calls (baseline/object plumbing, verifier diffs, PR publication,
init-time `git ls-files` and the UI demo bake) now go through ONE host-owned
installation descriptor (`src/sandbox/trusted-exec.ts`). What the operator
sees:

- Linux defaults are `/usr/bin/git`, `/usr/bin/gh` and the running
  interpreter (`process.execPath`); the CLI/UI entries are the running
  installation's own, proven from the resolved module URL. A host profile
  `installation.*` override replaces a default. There is no PATH,
  `node_modules/.bin`, cwd, project-env or `KIT_*` fallback anywhere in this
  chain.
- An override that is present but invalid refuses. It is never replaced by the
  default, and a missing default never triggers a PATH search. Overrides must
  be canonical absolute paths; a default that is a symlink is refused (name its
  canonical target in `installation.*`).
- Validation happens per use, so `delivery.mode=none` does not require `gh`, and
  commands that never launch Git/gh/UI/helper are unaffected. Installation
  files must be regular non-symlinks, operator/root-owned, not group/world
  writable, with non-symlink trusted ancestors (a sticky world-writable
  ancestor like `/tmp` is allowed because entries there cannot be replaced).
- The only in-target exception is the running kit installation's own entries
  (dev-in-kit); a checkout that merely contains a kit copy is refused, and
  symlink/owner/mode checks still apply to the exception.
- Git children never inherit the operator environment: fixed literal argv,
  inherited `GIT_*`/`GH_*`/`SSH_*`/proxy/`BASH_ENV`/`NODE_OPTIONS` stripped,
  system/global config and attribute sources disabled, hooks, fsmonitor,
  external diff, signing, protocol-ext, proxies and credential-helper
  inheritance disabled. Worktree staging uses `hash-object --no-filters` +
  `update-index --index-info` instead of `git add`, so a repository clean
  filter or hook never executes on the host. `gh` is noninteractive,
  destination-pinned, and used only for `delivery.mode=pr` with explicit
  `--deliver`; a host-resolved `GH_TOKEN` reaches only that subprocess.
- Tests inject an explicit descriptor in-process
  (`installTrustedInstallationForTests`); that is host authority, not a weaker
  validation mode.

CLI/UI process launch and attached-stop identity (step f), the async config
reads (step g) and gate/probe execution (P05) are NOT cut over by this step;
P05 must consume this resolver rather than add another resolution chain. No
sandbox launch, rootfs or certification follows from it.

## Upgrade & migration notes

- The kit is versioned semver; `.orch/kit-version` records which pairs
  (kit, pi-durable) created the project. The kit version IS the package
  version: `src/config.ts` reads `package.json` once, and the init marker, the
  CLI version header, and every readout identity draw from that single source,
  so they always agree. `RunStatusDoc.kitVersion` values recorded by older kits
  are historical state and are never rewritten.
- pi-durable upgrades: `docs/api-map.md` is the contract map — the engine only
  touches the exports listed there. `assertPinnedPiDurable()` compares the
  INSTALLED `@earendil-works/pi-durable/package.json` version and the
  `[engine] piDurable` config value against the built-in `PD_VERSION` pin and
  refuses to run on mismatch with a pointer at this doc.
- Document payload migrations (M0-P04): `RouterDoc` and `RunStatusDoc` moved
  from payload version 1 to 2 through the pinned `defineDoc`
  `migrate(value, fromVersion)` — pure functions that keep every historical
  row readable (`migrateRouterDoc`, `migrateRunStatusDoc` in
  `docs/api-map.md`) and invent nothing: no plan identity for legacy plans,
  no receipts, no rewritten spend or kit identity. Records migrate lazily on
  read and persist at version 2 with the next mutating commit; a mutating run
  on an unmigrated non-empty plan refuses (see Plan identity above). Before
  upgrading a real project, stop all kit processes and copy the closed
  storage (`.orch/durable.sqlite*`) together with the retained Git objects and
  `.orch` evidence; never delete. Downgrading after v2 writes requires
  restoring that backup, not running an older writer.
- RouterDoc schema changes land ADDITIVELY with a careful `version` bump and a
  `migrate` function when semantics change; readers treat absent fields as
  defaults (e.g. `convId` missing ⇒ open a new conversation for the task).
- Wave-log rows are append-only JSON; old rows stay readable forever. The
  default-on skeptic pass adds `verify:skeptic:<verdict>` rows without changing
  the wave-log schema version; existing `verify:<verdict>` rows remain primary
  verdicts, and summing verdict-row usage now accounts for both conversations.
- M0-P14 is a deliberate driver/output-location cutover. Existing in-progress
  work without a P14 checkpoint must be reconciled manually or replanned; it is
  never replayed from the operator checkout. `none` no longer leaves files in
  `.`, and `commit` no longer advances the checked-out branch. Follow the
  result-location instructions above and rehearse against a fixture before
  upgrading a real project.

## M0 release & migration checklist (M0-P19)

M0 is a hard release gate before M1–M4. A release is blocked unless ALL of the
following pass at the release commit, from a clean checkout:

1. `npm run typecheck && npm run build && npm test`
2. `npm --prefix ui run typecheck && npm --prefix ui run check && npm --prefix ui test && npm --prefix ui run test:e2e`
3. `git diff --check`
4. The offline smoke below reproduces the demo contract end to end through
   the BUILT CLI (`node dist/cli.js`). `test/m0-release.test.ts` is the
   executable form of this checklist: black-box temp projects, separate
   plan/run processes, the faux replay re-read from disk, the actual product
   invocation asserted (stdout/stderr/status) — never router status alone.
   Any red prerequisite suite blocks the release; there is no red-test
   suppression and no skipped gate.

Compatibility breaks this checklist records explicitly (deliberate, shipped
by the M0 packets — never transparent bug fixes):

- Durable document payloads moved v1 → v2 (`loop.router`/`loop.run`, pure
  migrations). A mutating `run` on an unmigrated non-empty plan refuses;
  pre-P14 in-progress work is never replayed; downgrading requires restoring
  the pre-upgrade backup, not running an older writer.
- Plan approval is the ADR 01 triple under a fresh per-plan `planRevision`;
  legacy stamp/timestamp approvals authorize nothing. `router.md` is a
  rewritten mirror — never plan input: an edited or missing mirror refuses
  new grants, and inspection flags edited mirror bytes as drift instead of
  reconstructing grant or outcome from them.
- Output location cutover (M0-P14): `none` leaves the accepted lineage at
  `refs/kit/<revision>/accepted` (the operator checkout is unchanged; inspect
  via a detached worktree), `commit` publishes `refs/heads/kit/<revision>/result`
  without checkout, `pr` publishes stacked create-only refs behind explicit
  `--deliver` and never merges. No mode writes result files into `.`.
- `done` is receipt-backed (acceptance + integration + confirmed publication),
  not a scheduler projection; a quarantined task unblocks only through the
  human `resolve` path.
- Budget admission (M0-P16) guards every paid submission at `>=` of
  `budgets.sessionUsd` — a zero ceiling refuses all paid work — and unpriced
  observed spend pauses with a distinct reason. Recorded spend is an estimate,
  not a provider-bill cap.
- Security posture until M1: implementer tools, gates, probes and delivery
  execute on the HOST with no OS containment. Use trusted projects and
  fixtures only; there is no `unsafeHost` switch — unsupported containment
  means no execution, not a banner followed by host execution.

Offline smoke (no API keys; disposable directory; Node ≥ 23.6 for the demo
product's type-stripping):

```bash
KIT=/path/to/this/repo
cp -r "$KIT/examples/demo-prd" /tmp/m0-demo && cp "$KIT/examples/demo-prd/smoke-gate.cjs" /tmp/m0-demo/evals/
cd /tmp/m0-demo
node "$KIT/dist/cli.js" init .
cat > .orch/config.toml <<'TOML'
[engine]
piDurable = "1.5.0"
maxTurns = 12
retryLimit = 2

[roles.planner]
provider = "faux"
modelId = "kit-planner"

[roles.implementer]
provider = "faux"
modelId = "kit-impl"

[roles.verifier]
provider = "faux"
modelId = "kit-verifier"

[budgets]
sessionUsd = 25.0
waveUsdWarn = 6.0
maxConsecutiveErrors = 3
maxSleepCycles = 3

[gates]
timeoutSec = 30
enforceTargetPaths = true

[delivery]
mode = "none"

[paths]
prd = "docs/prd.md"
specs = "specs/"
TOML
git init -q && git add -A && git commit -qm base
export KIT_FAUX=1 KIT_FAUX_SCRIPT="$KIT/examples/demo-prd/smoke.replay"
node "$KIT/dist/cli.js" plan   # prints the plan revision <uuid>
node "$KIT/dist/cli.js" run --approve --revision <uuid>   # exit 0, STATUS: COMPLETE
git worktree add --detach /tmp/m0-demo-result "refs/kit/<uuid>/accepted"
cd /tmp/m0-demo-result && node bin/render.js '/a/-b'   # prints exactly `a b`, exit 0
```

## PR publication (M0-P13; activated by M0-P14)

The serial driver publishes only an already accepted and integrated candidate.
This is not an auto-merge feature or a claim that a PR is CI-approved code.
`run` uses the verified publication contract below; no legacy branch/checkout
path remains active.

Before a PR-mode run, the operator must put exactly one project entry in
the private host policy (`~/.config/llm-toolkit-001/host-v1.json`, or the
platform-equivalent) with an approved canonical HTTPS GitHub `deliveryOrigin`
for the exact canonical project root. The operation reads that allowlisted
field only. It never uses the repository's `origin`, a push URL, a task value,
or a caller-selected destination. There is no default remote. Do not put a
GitHub token in project config; credentials remain in the trusted host Git/gh
credential path and never enter a worker.

Before any public branch is created, the pinned candidate and its integration
parent are checked for tracked private `.orch` runtime state and §2 secret
paths (`.env`, `.env.*`, `.npmrc`, `.netrc`, `.pypirc`, `.ssh/**`, `.aws/**`,
`*.pem`, `*.key`). A match blocks publication. The kit does not untrack,
rewrite, or scrub history; remove sensitive content manually, establish a new
reviewed base, and replan.

Publication uses a create-only remote-ref CAS for
`refs/heads/kit/<planRevision>/<taskId>`. If absent, only an empty-expected
lease may create it. A durable pre-push intent can retry the create-only CAS;
once a push attempt is recorded, an absent head is uncertain and cannot be
blindly recreated. An exact existing head is observed without pushing; a
different head blocks. An already-attempted ref that later disappears is not
recreated. Task A's PR targets the reviewed base branch only while it still
points at the reviewed base commit. A later task's PR targets the unique
previously published branch whose recorded integration commit is its exact
parent. The new commit keeps that local integration commit as its single parent;
publication does not guess at a GitHub merge commit.

The PR host receives explicit repo/base/head identities. `published` is recorded
only after the host reports exactly one open PR whose repository, base ref and
OID, head ref and queried head OID, number, and canonical URL all match the
journal. On retry, the host is queried before create. A matching PR after a
lost response is acknowledged; an ambiguous/conflicting result, a moved base,
or an uncertain create without an observable matching PR remains blocking
`unknown` state. The helper never blindly repeats a possibly completed PR
create, updates an existing remote ref, force-pushes, checks out a delivery
branch, auto-merges, or repairs a diverged branch.

`test/pr-publication.test.ts` and `test/serial-lineage.test.ts` exercise the
publication path against a local bare Git remote and injected fake PR hosts.
They do not contact GitHub or read GitHub credentials.

## Repository hygiene — three ownership classes (ADR 04)

Every path the kit touches belongs to exactly one class, independent of
authorship. `init` encodes the defaults as ONE bounded, idempotent,
LF-delimited block in the project's root `.gitignore` (existing comments and
custom patterns are preserved, never removed):

```gitignore
/.orch/*
!/.orch/config.toml
!/.orch/gate-decisions.json
!/.orch/gate-remediations.json
/router.md
```

- **Reviewable** — project code, PRD, `PROMPT.md`, human and approved generated
  recipes, checklist, plus the three kit controls `.orch/config.toml`,
  `.orch/gate-decisions.json`, `.orch/gate-remediations.json`. Not ignored;
  committable. The kit NEVER auto-stages them: committing controls is an
  explicit operator decision.
- **Optional local paper trail** — `router.md`, `.orch/wave-log.jsonl`,
  `.orch/kit-version`. Ignored by default; after review the human may
  explicitly retain any of them (`git add -f router.md .orch/wave-log.jsonl
  .orch/kit-version`). Neither file is guaranteed committed evidence, and
  mirror content alone does not certify rollback, delivery, or any external effect.
- **Private** — all other `.orch/**` data: SQLite/WAL/SHM, lock, notes,
  projections, workspaces, assessments, telemetry, exports, UI jobs. Ignored by
  default and never published by kit action.

`init` reports — and never repairs — two conflict shapes: a pre-existing
`.gitignore` pattern that excludes the `.orch/` directory itself (Git cannot
re-include files under an excluded directory, so the reviewable exceptions
cannot take effect until the operator adjusts that rule), and a private file
the repository already tracks (ignore rules do not apply to tracked files).
The kit never modifies the git index or history to enforce hygiene: no forced
`git rm --cached`, no history cleanup, no retention daemon. To stop tracking a
private file, run `git rm --cached -- <path>` yourself after saving anything
you need; a tracked paper-trail file is legal manual retention and is not
warned about.

## Runtime layout in the project

```
.orch/
├── config.toml          # project config (reviewable: committable, never auto-staged)
├── kit-version          # provenance marker (paper trail; ignored by default)
├── lock                 # PID lock (private; single storage owner)
├── durable.sqlite*      # pi-durable storage (private; WAL; local-only)
├── status.json          # atomic status payload (private; status --follow reads this)
├── wave-log.jsonl       # JSONL mirror of WaveLogDoc (paper trail; ignored by default)
├── handoffs/inbox/      # queued handoff notes, ONE atomically published <uuid>.json each (private; handoff command)
├── handoffs/invalid/    # diagnosed invalid/unreadable notes quarantined here (private)
├── pending-handoff.json # pre-P17 queue; imported once into handoffs/inbox/ (private; legacy only)
└── artifacts/           # gate logs, revision-qualified candidate patches, exports (private)

router.md                # RouterDoc mirror (paper trail; not plan input; ignored by default)
PROMPT.md, evals/, docs/prd.md   # reviewable project bytes
```

> Note on `.orch/wave-log.jsonl`: it mirrors durable storage and is rewritten
> after state commits. It is an optional local paper-trail file: the init
> hygiene block ignores it by default, and operators choose whether to retain
> or commit it (explicitly, with `git add -f`). Neither this file nor
> `router.md` is guaranteed committed evidence. Durable receipts in
> `.orch/durable.sqlite` record accepted integration, confirmed workspace
> disposal, and publication effects; mirror content and display patches do not.

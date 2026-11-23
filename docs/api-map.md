# api-map

Exact exports of `@earendil-works/pi-durable@1.5.0` /
`@earendil-works/pi-ai@1.5.0` this kit uses, per engine module. Pinned versions:
recorded at build time 2026-11-05 (`npm dist-tags latest`; `durable_readme.md`
in the research bundle describes the same release).

**The seam is closed (M0-P02).** Every pi-durable/pi-ai reference in src, test,
and ui code — value imports, type-only imports, subpaths, faux helpers, and
installed-version metadata queries — lives in `src/engine/kit.ts` and is used
through its re-exports. No other file may reference those two packages: not
statically, not through a literal `require("…")`, not through a dynamic
`import("…")`. `test/kit-seam.test.ts` enforces this mechanically with a
TypeScript AST scan (not a grep, so comments and strings cannot fake it), and
also fails when an export named in the kit.ts section below does not actually
resolve from kit.ts. (`@earendil-works/chord` context primitives are not part
of the pinned surface; context types may be imported where needed.)

## src/engine/kit.ts — the import seam

Every name below is an actual export of kit.ts (that is the test's contract).
SDK values, re-exported by module:

- harness core: `Harness`
- documents/entries: `defineDoc`, `defineEntry`, `AssistantEntry`, `ResetEntry`,
  `UserEntry`, `ToolResultEntry`, `CompactionEntry`, `LiveDoc`, `UsageDoc`
- extension machinery: `createRegistry`, `defineExtension`, `defineTool`,
  `hook`, `section`, `runEndTask` (kept for the afterRun alternative noted
  below), `GenerationTask`, `ToolTask`
- tasks: `defineTask` and the task shape `Task` (`@earendil-works/pi-durable`
  root)
- storage: `openNodeSqliteStorage`
  (`@earendil-works/pi-durable/storage/sqlite/node`), `MemoryStorage` (tests)
- env: `NodeExecutionEnv` (`@earendil-works/pi-durable/env/node`)
- tools: `createReadTool`, `createWriteTool`, `createEditTool`, `createBashTool`,
  `CodingTools`, `createCodingTools` (subpath /tools; the latter two
  re-exported for reference)
- model wiring (pi-ai): `createModels` (subpath /models); provider factories
  `anthropicProvider`, `openaiProvider`, `openrouterProvider` (subpaths
  /providers/anthropic, /providers/openai, /providers/openrouter)
- faux replay (pi-ai subpath /providers/faux): `fauxProvider`,
  `fauxAssistantMessage`, `fauxText`, `fauxToolCall`
- budget denial stream (pi-ai subpath /utils/event-stream, M0-P16):
  `modelStreamSetupError(model, error)` builds the dispatch guard's denial
  stand-in — an AssistantMessageEventStream ending in an error message
  (zero usage), so a refused dispatch settles like a provider error instead
  of faulting the generation task
- contexts (chord, beside the seam): `BACKGROUND_CONTEXT`, `withAbortSignal`
- metadata: `readInstalledPiDurableVersion` — the kit's ONLY installed-version
  query; reads the pinned package.json through a seam-owned require so the pin
  assert (harness.ts) and the init provenance marker share one source
- id bridges: `convId`, `entryId`, `subId`, `idOfConversation` (branded numeric
  ids ↔ plain JSON numbers)

Types re-exported: `Conversation`, `ConversationDocToken`, `SessionDocToken`,
`Session`, `Extension`, `ToolRegistration`, `ConversationRecord`, `EntryRecord`,
`EntryId`, `ConversationId`, `JsonObject`, `SubmissionId`, `Cursor`, `Page`,
`SetTimer`, `Task`, plus the pi-ai types `Models`, `Provider`, `Usage`,
`AssistantMessage`, `FauxProviderHandle`, `FauxResponseStep`, and the chord
types `Context`, `Draft`, `JsonValue`. (`JsonObject` re-export added in M0-P04
so doc `migrate(value, fromVersion)` signatures use the SDK's own parameter
shape without widening the seam.)

## src/engine/plans.ts — plan identity

- `PlanIdentity` — the durable identity of one reviewed plan:
  `planRevision` (a fresh UUIDv4 per plan, even for identical replans),
  `definitionSha256` (canonical digest of the immutable task definitions),
  `baseCommit` (git HEAD at planning; `null` when the project has no commit
  yet — uncommitted operator edits are excluded from the base), `baseBranch`
  (`null` when detached), normalized project-relative `prdPath`, `prdSha256`,
  and optional `controlsSha256` (ABSENT when no approved control input exists
  at all — distinct from a digest over empty controls)
- `canonicalJson`/`canonicalSha256` — recursive key-sorted, order-preserving
  arrays, UTF-8 JSON, SHA256; `planDefinitionSha256` hashes exactly the
  immutable planner fields (id/title/spec/dependsOn/acceptance/targetPaths/
  priority) and excludes status/counter/receipt fields by construction
- `buildPlanIdentity(root, prdPath, prdText, tasks)` — reads all identity
  inputs (git, files) BEFORE the plan commit, so a failure leaves the previous
  plan untouched; `ArchivedPlanRef` is the reference stored for a replaced
  plan (references only, never receipts; a legacy v1 plan has no identity, so
  replacing one archives nothing)
- `normalizeRelPath` — project-relative POSIX normalization, traversal refused
- `loadPlanControls`/`controlsSha256` — approved gate-gap remediations
  (`.orch/gate-remediations.json`; absent/invalid file hashes as null, an
  approved-empty list as `[]`) plus content digests of PROMPT.md,
  `evals/checklist.md`, `evals/recipes.toml`, and `evals/recipes.auto.toml`

The kit-defined LoopGuardDoc is NOT an SDK export and does not live here —
harness.ts defines it on top of `defineDoc` (see its section below). Tests
reach the seam through `test/kit-types.ts`, the only test-side window (faux
subpath types included); they never import the SDK packages directly.

## Task-tree helpers — `src/engine/{workspace,controls}.ts` and `src/util/git-objects.ts` (M0-P09, active via P14)

**M0-P14 active serial-driver path.** The existing serial selector/gate flow now uses these helpers to create and verify one immutable candidate at a time. They are host-side Git/workspace plumbing, not an execution sandbox or OS-containment boundary. No caller may inspect/copy a dirty operator checkout into a task.

- `openTask({root, oid}, identity, id, {scopeBaseOid?})` resolves a full commit/tree OID and materializes a private writable projection under `.orch/work/<revision>/<task>/<lease>/`; `oid` is this wave's start tree and `scopeBaseOid` is the unchanged integration parent used for whole-candidate scope. It never uses the operator index, working tree, or a Git worktree. The workspace contains no `.git`. It pins the parent tree beneath `refs/kit/...` (not `refs/heads`) and returns an opaque owned lease plus the exact projected and deliberately excluded parent paths. `resumeTask(..., leaseId)` reattaches only a checkpointed lease and reports a previously pinned candidate; it never recaptures the operator checkout.
- `createTaskControls({root, targetPaths, deniedPaths?, readOnlyPaths?})` validates immutable project-relative controls. `matchesPath` is the shared in-process matcher: exact literal file, trailing-`/` directory prefix, `*` within one component, `**` across components. It never invokes a shell. Empty target list means all *admissible* paths; reserved/denied paths always win. `.orch/**`, secrets, `.git/**` and paper-trail files are hidden; `evals/**`, `PROMPT.md`, Git/delivery controls and optional configured read-only paths are projected read-only and cannot be admitted as changes. `classifyProjectPath` from `src/hygiene.ts` participates in admission.
- `materializeRead({root, oid}, controls)` resolves an immutable tree, makes only safe regular-file entries read-only in a private view, pins the tree, and reports the paths projected/excluded. It does not expose Git metadata or private `.orch` state.
- The host must first fence every writer, then call `fenceWorkspace(lease, controls)`. This is an explicit host assertion, not a worker/process-kill implementation. `freeze(fencedWorkspace)` starts from the wave's pinned start tree in a unique `GIT_INDEX_FILE` under `.orch/work`, hashes exact bytes with `--no-filters`, applies NUL-delimited index records, writes a tree, checks admissible paths against both the whole integration-parent→candidate scope and the start-of-wave→candidate progress delta, pins the result, and returns a checked tree OID plus exact per-wave create/modify/delete/mode changes. A malformed path, unsupported object, symlink, hard link, limit, or failed Git command throws; there is no partial/empty fallback.
- `discard(ownedLease)` accepts only an opaque handle created by this module. It has no caller-provided root/path and removes only that lease's private directory; it never resets/cleans/restores a checkout or deletes pinned objects. Tree helpers in `src/util/git-objects.ts` use full OIDs, checked subprocess results, byte-capped reads, private throwaway indexes, and private `refs/kit/...` pins. No branch is published for `delivery=none`.
- `diffTrees` / `diffTaskTrees` compare immutable trees, including binary object IDs and executable modes; they do not stage/display-diff a worktree.

## M0-P10 — control, execution, and read roots

**Active in the M0-P14 serial driver; still not an OS sandbox or containment boundary.** The explicit `TaskExecutionContext` in `src/engine/workspace.ts` separates three authorities:

- **Control root:** `controlPaths: ProjectPaths` remains host-owned. Durable SQLite, config, status, router mirror, gate/verifier logs, assessment artifacts, and other `.orch` outputs resolve here.
- **Execution root:** `writableWorkspace` is an opaque P09 task lease for an implementer. Role setup receives the host-created context, which includes the exact `planRevision`, selected task IDs, task ID, lease ID, and parent/start/candidate OIDs; it does not accept a caller-selected host cwd. Coding conversations use the lease projection; read-only conversations use the candidate view.
- **Read root:** `frozenReadView` must be an owned read projection whose tree equals `candidateOid`. New-context `runVerify` builds its changed-file list, summary, display patch, and Jev assessment patch from `startOid → candidateOid` via `diffDisplayTrees`; no display-stage operation or working-tree fallback is used. Gate processes also execute with the frozen candidate view as cwd.

A context carries a captured `ImmutableRecipeBundle`: the exact UTF-8 bytes (and absent-vs-empty state) of `evals/recipes.auto.toml` and `evals/recipes.toml`, plus their SHA256 and reviewed source tree. `recipeBundleFromTree(root, reviewedTreeOid)` reads those bytes only from immutable Git objects; the context requires that source tree to equal the task start tree. `runGates` parses only these bytes for a new context; it writes the gate log under the control root and uses the context's injected `execArgv` capability in the frozen candidate view. Scope is checked from integration parent→candidate; verifier diff/progress evidence is start-of-this-wave→candidate. `probeGates` can use an explicit frozen baseline context only after the ordinary interactive/`--yes` execution consent; it does not silently turn inspection into execution.

Call seams: `ConversationKit.createUnit({ executionContext })`, `runGates(..., { context })`, `runVerify(..., { executionContext })`, and `probeGates(root, { executionContext })`. `createTaskExecutionContext` checks grant membership, root agreement, owned workspace/read-view kinds, candidate-tree equality, the recipe bundle digest, and exact recipe-byte equality against the immutable start tree. Diagnostic `verify --task` opens a `TaskReadContext` for the newest retained candidate; it does not read task source from the operator checkout. The `inspector.readout` remains a control-root observer. `readout.seam` stays at 1; no v2 read package is introduced.

These are host-side path and data-flow distinctions only. The injected literal runner may still be host execution; no sandbox backend, OS containment, isolation, or hostile-project safety claim is made in M0.

## M0-P11 — criterion evidence + reviewed passes (`loop.receipts`)

**`src/engine/receipts.ts`** defines the `ReceiptsDoc` session doc (`loop.receipts`, payload version 1: `{version:1, events: ReceiptEvent[], latest?, latestCheckpoints?}`). P11 records GATE and PASS; P12 additively adds ACCEPTANCE, INTEGRATE, ROLLBACK, and DELIVERY journal events; P14 adds checkpoint events for each wave/stage. Journal wrappers carry a stable `planRevision/taskId/wave/stage` key and unique per-key attempt ordinal. `commitState({receiptAttempts, checkpoints})` appends the events and advances their latest pointers in the SAME harness commit as accompanying state changes. Raw output/tails stay out of documents (the gate log and wave log carry them).

- `GateReceipt` = wave key + `{id, tree, controlsSha256?, failureHash?, checks}`: the frozen candidate plus every `GateCheck` `{id, kind: scope|recipe, outcome: pass|fail|skip|error, exit, ms}` observed on it. The optional `failureHash` supports the duplicate-gate breaker without storing output. The driver commits one per wave, including failed-gate waves. `controlsSha256` is absent when the plan has no approved control bundle (absent ≠ empty).
- `PassReceipt` = wave key + `{id, tree, gateId, policy, review}`: one read-only pass — `ReviewPass = {pass: primary|skeptic|human, verdict, criteria: CriterionResult[], notes, conversationId?}` — bound to the candidate tree, the wave's gate receipt, and the effective verification policy (`always`/`never` from `[gates] skepticSecondPass`; `risk-v1` arrives with routing). Each pass is committed BEFORE the next pass is dispatched; the verdict row's additive `receipt` field carries the pass receipt id.

**`src/engine/review.ts`** validates approving passes against the checked tree (§1 ADR 02). Every reviewed criterion must be marked pass and cite valid evidence: `{kind:"gate", id}` naming an executed, non-scope, non-skipped passing check from the gate receipt, or `{kind:"line", path, line}` naming an existing 1-based physical line in a regular UTF-8 text blob of the checked tree. Criterion ids are the exact 1-based indexes of the reviewed acceptance array; unknown/duplicate ids, missing entries, missing proof, empty criterion entries, or malformed reply shapes refuse. Neither reference is recomputed from the operator's checkout, and scope alone is never criterion evidence.

**`src/engine/verifier.ts`** feeds the checked tree, gate receipt id and non-skipped outcomes to BOTH read-only passes independently; enforcement is symmetric (the skeptic previously had a completeness check the primary lacked). Malformed JSON and prose around the JSON object degrade to `needs_human` (one optional code fence is tolerated); reply criteria entries map 1:1 — malformed entries are preserved and refuse an approval, never silently filtered. A well-formed explicit `reject` stays reject without evidence. No skeptic dispatch happens after an invalid or nonapproving primary. The one-off `verify --task` diagnostic path passes no gate evidence (so no gate reference can be evidence) and records no wave-keyed pass receipts; it still writes its verdict rows.

The active serial driver resolves the checked tree from `TaskExecutionContext.candidateOid`; diagnostic `verify --task` opens a grant-free, read-only `TaskReadContext` for the newest retained candidate. Pass rows carry the P11 receipt id; wave rows/status add the current revision, receipt-state projection, and frozen-checkpoint OIDs additively. `CheckpointEvent` carries `{stage,state,outcome?,parent,startTree,candidate?,leaseId?,conversationId?,submissionKey?,grantedFeedbackIds}`; its per-wave/per-stage latest pointer is committed atomically with its event. `readout.seam` stays at 1.

## M0-P12 — integration journal + local publication (`src/engine/delivery.ts`)

**Active host operations in the M0-P14 serial driver.** These journaled operations, rather than direct root staging/restore, govern ordinary `run`.

- `acceptCandidate(kit, {planRevision,taskId,wave,parent,tree,policy,required})` requires the current grant to include the task, a matching gate receipt, and each required approving pass receipt. It revalidates every pass's criterion evidence against the checked tree, pins the candidate tree under `refs/kit/`, and journals an acceptance event. An identical already-recorded acceptance is idempotent; a different candidate/parent for the same wave is recovery-required.
- `integrateAcceptedCandidate(kit, waveKey)` creates a deterministic one-parent commit from the accepted tree and exact recorded parent, pins it at `refs/kit/<revision>/integration-objects/<task>/<wave>/commit`, then commits the integration intent before CAS-updating `refs/kit/<revision>/accepted`. Replays reuse the pinned/recorded OID. The commit tree and sole parent are read back, and the accepted ref is read back before `integrated` is recorded.
- `publishLocalResult(kit, waveKey, mode)` is local-only: `none` records `not_requested` after confirming the private accepted ref; it does not touch `refs/heads/`, HEAD, or the operator index. `commit` compare-and-swaps only `refs/heads/kit/<revision>/result`, from absent on the first task or the prior accepted commit later. It refuses a result branch checked out in any worktree. PR mode remains unsupported here; no network or `gh` call is made.
- `discardCandidateWorkspace(kit, {fencedWorkspace,...})` only accepts the opaque token from `fenceWorkspace`. It records pending first and records `discarded` only after observing the private lease directory absent and `refs/kit/<revision>/accepted` unchanged. Disposal failure becomes `failed`; uncertain fence/ref observations become `unknown`. No UI patch is used for recovery.
- `src/util/git-objects.ts` supplies checked commit read/create, ref read, compare-and-swap, and checked-out-branch observation. All Git operations address objects and named refs; none checks out a branch, stages files, restores the operator tree, or uses its index. Workspace-fence assertion is not OS containment.

### Journal crash/replay contract

| Stop point | Durable state / observed ref | Retry action |
|---|---|---|
| Before acceptance commit | No acceptance; candidate remains private | Revalidate gate/pass receipts and retry; no accepted outcome is inferred |
| After integration commit is pinned, before intent commit | Stable private commit pin may exist; accepted ref stays at parent | Reuse/verify the deterministic pinned OID, then write intent |
| After intent commit, before accepted-ref CAS | Latest integrate event is pending/unknown; accepted ref is parent | Reuse the exact recorded OID and retry the parent→commit CAS |
| After accepted-ref CAS, before integrated receipt | Intent is pending/unknown; accepted ref reads the recorded commit | Verify commit type/tree/sole parent and ref; append integrated, never make a second commit |
| CAS reads neither expected parent nor recorded commit | Journal records unknown; ref has a conflicting value | Stop with `RecoveryRequiredError`; do not overwrite/adopt the foreign ref |
| Rollback interrupted before disposal | Pending/failed; workspace still present | Remain blocking; retry only while the host can present the owned fence token |
| Rollback interrupted after disposal | Pending/unknown; directory is absent and accepted ref is unchanged | With the same valid fence token, re-observe both facts and append discarded; if the token/fence cannot be re-established, remain unknown and blocking |
| Local branch CAS interrupted | Delivery pending/unknown; branch reads parent or recorded commit | Retry CAS only from expected parent; recorded commit is acknowledged by readback |
| Local branch has a foreign value | Delivery unknown; branch is neither expected parent nor commit | Recovery-required; never force/update the foreign ref |
| `none` acknowledgment | Delivery `not_requested`; only private accepted lineage changes | Return the detached result at `refs/kit/<revision>/accepted` |

Local result refs: the private integration head is `refs/kit/<revision>/accepted`; immutable per-wave integration commits are pinned below `refs/kit/<revision>/integration-objects/`; commit mode publishes the named local branch `refs/heads/kit/<revision>/result`. For `none`, the operator may inspect the result with a separate `git worktree add --detach <new-dir> refs/kit/<revision>/accepted`; the prepared operation itself does not create that worktree. Test fault injection is exposed at every receipt-commit and ref/disposal effect boundary. Effect-receipt write failures propagate and leave a pending/unknown receipt for reconciliation; display-artifact writes remain best-effort.

## src/engine/harness.ts

- `HarnessOptions`: `models` (`Models`, via the kit.ts seam), `registry`, `env`
  (one `NodeExecutionEnv` per use, cwd follows the conversation agent),
  `settings` (`retry {enabled,maxRetries,baseDelayMs}`, `afterFailedRun:
  "withdraw"`, `toolExecution: "parallel"`, `progress`), `onReport` (→ wave-log
  rows when a driver is attached, else the ring buffer surfaced by
  status/export), and `readOnly` (observer opens — see below)
- storage single-owner: `.orch/lock` via `O_EXCL` + live-PID check
  (`src/util/lockfile.ts`) BEFORE any sqlite open; `status --follow` therefore
  reads side-cars, never storage, while a run is live
- `Session.snapshot(token, cx)` reads (`RouterDoc`/`RunStatusDoc`/`WaveLogDoc`),
  `session.commit(async (tx) => …)` writes them (`tx.doc(...)` drafts)
- version assert: `PD_VERSION` (this module) compared against the installed
  version via the seam's `readInstalledPiDurableVersion()` **and** the
  `[engine] piDurable` config value; mismatch throws with a
  "see docs/api-map.md before upgrading" message. The installed-version query
  itself lives in kit.ts — no other file reads SDK package metadata.
- read-only views (`openProjectHarness(..., { readView: true })`, used by
  `status`/`inspect`/`export` and the UI server): still under `.orch/lock`,
  they open `Harness.open({ readOnly: true })` — no scheduling, no admission or
  recovery writes, no task progress, and commits with writes reject with the
  SDK's `ReadOnlySession`. They build NO providers (an empty `Models`
  registry), so inspection never constructs a provider object or resolves
  credentials — even for providers a real run would wire. A project that has
  never run has no `.orch/durable.sqlite`: the open throws `StoreAbsentError`
  instead of creating one, and callers expose empty/absent evidence (side-car
  readout; `status` renders an empty panel). While another process owns the
  lock the same commands degrade to side-cars.
- model wiring: `buildModels` over the providers the config roles name,
  constructed from the seam's `createModels()` + `anthropicProvider()` /
  `openaiProvider()` / `openrouterProvider()` — synced/failing per env
  credentials as pi-ai expects (no secrets from config.toml). Tests use the
  seam's `fauxProvider()`/`fauxAssistantMessage`/`fauxToolCall` +
  `models.setProvider(...)` (injected via `HarnessOptions.models`).
  `KIT_FAUX=1` (tutorial) builds the same faux provider for the CLI through
  `faux-replay.ts`.
- kit-defined documents: `LoopGuardDoc` (the `loop.guard` conversation doc) is
  DEFINED HERE on top of the seam's `defineDoc` and the
  `ConversationDocToken` type — it is a kit document, not an SDK export.

## src/engine/infos.ts — my own state

- `defineDoc` session-scoped docs (via the kit.ts seam, which supplies both
  `defineDoc` and the `SessionDocToken` type): `RouterDoc` (`loop.router` at
  payload version 2: tasks id/title/spec/dependsOn/acceptance/targetPaths/
  priority/status/waveCount/convId/baselineTreeSha/lastGateHash/feedback;
  phase empty→planned→running→complete; plus `identity` — the CURRENT plan's
  `PlanIdentity`, absent only on legacy v1 plans — and `archived`, references
  to replaced plans, most recent first),
  `WaveLogDoc` (`loop.wavelog`, still version 1: append-only rows mirrored to
  `.orch/wave-log.jsonl`), `RunStatusDoc` (`loop.run` at payload version 2:
  prdPath/prdSha/budgetSpentUsd/activeAlert/sleepTaskId/sleepUntil/
  sleepCycleCount/kitVersion — recorded as the creating kit's identity and
  never rewritten for older rows — plus the ADR 01 grant triple
  `approvedPlanRevision` + `approvedSelected` (granted task ids, sorted
  unique) + `humanApprovedAt`: a stamp authorizes a run only when all three
  legs are present and the revision names the RouterDoc's CURRENT
  planRevision, so a timestamp alone or a pre-grant v2 pair authorizes no
  run)
- pure v1→v2 migrations on the pinned `defineDoc` contract:
  `migrateRouterDoc` keeps historical rows readable and invents no identity
  (an unmigrated legacy plan never runs — the operator replans), and
  `migrateRunStatusDoc` keeps the legacy stamp as history without turning it
  into a revision-qualified approval. Stored records migrate lazily on read;
  they persist at version 2 with the next mutating commit.
- every doc value is a JSON-strict `type` literal (pi-durable `JsonObject`
  constraint); `checkpointWhen: () => true` (tiny docs)
- mirrors: `router.md` (renderRouterMd) + `.orch/wave-log.jsonl` (JSONL),
  written atomically AFTER each commit resolves — never inside it. `router.md`
  is review output, not editable plan input; durable RouterDoc remains the
  grant source, and a NEW grant additionally requires the mirror to match the
  canonical durable render (missing/edited mirror → refuse, replan to
  refresh; resume never consults the mirror). The mirror renders the durable
  doc INCLUDING
  its plan identity (`PLAN REVISION`/`DEFINITION SHA256`/`CONTROLS SHA256`
  lines plus archived-plan references), and the driver's gate parity check and
  `inspect --health` render with the same identity, so the mirror-vs-doc byte
  comparison stays like-for-like. These mirrors are not guaranteed commits.

## src/engine/planner.ts — plan creation (identity + strict validation)

- one planning conversation; on success the commit atomically: archives the
  replaced plan's identity reference, mints and stores the fresh
  `PlanIdentity`, replaces the task graph at `phase: "planned"`, and
  invalidates the prior approval (clears `approvedPlanRevision` and
  `humanApprovedAt`) — a replaced plan is a new review point
- validation rejects BEFORE any state replacement (failed parsing leaves the
  old plan, status, and mirrors untouched): empty plan, unsafe ids (lower
  `[a-z0-9][a-z0-9_-]{0,63}` AFTER normalization; collisions between
  normalized ids reject), duplicate deps, unknown/cyclic deps, and
  missing/invalid targets — `targetPaths` must be an explicit array whose
  entries are non-empty, bounded, project-relative specs; `[]` explicitly
  means unrestricted admissible project paths, so a missing field is a parse
  error rather than a silent unrestricted default
- state.ts `planRunRefusal(state, {approve})` is the plan-authorization gate
  (enforced on the CLI path): plans without an identity refuse every mutating
  run, and a stamped approval authorizes only when it names the CURRENT plan
  revision

## src/engine/tasks.ts

- `defineTask` — the governor's `kit.sleep` (`SleepTaskInput/state/result`),
  phases `waiting → (sleepUntil) → done`; the registry installs it through the
  `kit-governor` extension at open (`HarnessOptions.registry`)

## src/engine/waves.ts — the driver

### Exact grants (M0-P05, §1 ADR 01 + §3 transition 5)

- `approveGrant(kit, {planRevision, tasks?})` is the ONLY grant-minting path:
  it validates the request against `grantRefusal` (state.ts) — legacy gate,
  explicit `--revision` naming the CURRENT plan revision (no hidden default),
  subset validation (known planned ids, no duplicates, dependencies done or
  inside the selection, never auto-included), the documented
  unresolved-checkpoint refusal hook — then `approvalMirrorRefusal`
  (router.md must exist and match the canonical `renderRouterMd` render under
  the lock), then ONE `commitState` writes the grant
  `{planRevision, selected, humanApprovedAt}` + the phase flip planned→running
  + the review row. Old CLI clients and pre-grant v2 stamps authorize nothing.
- `runWaves` admission happens BEFORE any handoff ingestion, sleep wait,
  budget read, or wave: `--approve` mints the grant through `approveGrant`; a
  bare resume requires the stored grant (via `grantRefusal`), inherits its
  exact selection, and never consults the mirror. An explicit set without
  `--approve` must equal the grant. Selection uses `pickNextTaskInSelection`
  (candidates only from the grant; dependency lookup across ALL tasks) over
  the LATEST durable state at each loop top. Whole-plan fulfillment (every
  plan task done) flips the router phase to complete exactly once; a
  satisfied subset reports `selection-complete` and leaves the phase open;
  a quarantined granted member stops the selection as a policy stop
  (`exit: "blocked"` → CLI 2) with ids, never 0/complete. An unresolved or
  uncertain checkpoint returns `recovery-required` (CLI 2), leaves the task
  non-done, and stops before dependents. `RunSummaryInfo` carries `grant`,
  `remainingPlanIds`, `quarantined`, `blockedIds`; `DriverExit` is
  `plan-complete | selection-complete | blocked | recovery-required | budget | sleeping`
  (fulfilled 0, policy/recovery/budget 2, sleeping 42, refusals 1, SIGINT 130).

### M0-P14 serial candidate/checkpoint flow

For each task wave, `waves.ts` reads the current private accepted commit, opens a
private lease from the wave start tree, checkpoints the implementer conversation
and stable request id before submission, then fences and freezes the lease. Scope
is integration-parent→candidate; progress/diff is start-of-this-wave→candidate.
The gate and each verifier pass bind to that exact candidate and the reviewed
recipe bundle. Pass receipts are committed before the next pass. An accepted
candidate is journaled, integrated as a one-parent commit, and separately
published as `none`, a named local result branch, or an authorized stacked PR.

`loop.receipts` now includes latest-per-wave/per-stage checkpoints with
`parent`, `startTree`, optional `candidate`, `leaseId`, `conversationId`, and
`submissionKey`. On resume the driver reconciles the same implementer/verifier
submission and existing gate/pass/integration/publication receipts; it does not
start a second wave or pay for a completed pass. An unresolved gate effect,
publication or workspace-disposal result stops with `recovery-required`; no task
becomes done and no dependent task starts. Failed candidates stay pinned for
review; only the private owned lease is discarded through the rollback receipt.
The operator HEAD, index, staged/unstaged files and ignored files are never wave
inputs or restore targets. Successful `none` mode leaves the accepted ref at
`refs/kit/<revision>/accepted`; inspect it with a separate detached worktree.

A one-off `verify --task` looks up the current revision's newest retained
candidate and opens a read-only `TaskReadContext`. With no retained candidate it
refuses; it never verifies the operator checkout. Checkpoint, receipt-state,
planRevision, and candidate-artifact filenames are additive to status/readout
rows. This remains trusted-project host execution, not an OS sandbox.

### Why plain code phases instead of hooks (both documented)

- Chosen: gates + verifier run in the wave DRIVER loop as plain code between
  `submitAndAwait` boundaries. Diagnostics are ordinary stack frames, budget
  checks and breakers read fresh state mid-loop, and quarantine/rollback needs
  the git shell anyway.
- Alternative (viable, same APIs): an `afterRun` hook on `GenerationTask`
  (`hook(GenerationTask, { afterRun })` returning `runEndTask(KitGateTask, …)`
  where `KitGateTask` is a `defineTask` of the recipes) runs gates as owned
  child tasks with the durability of the state machine; the trade-off is gate
  diagnostics living in task state rather than driver logs, and abort semantics
  riding on the owner conversation.

- `createConversation({ ownership: {kind:"ownerless"}, agent, init }, ctx)` —
  one fresh implementer conversation per new wave; `agent.tools` selects exactly
  the kit tools and `init` writes the conversation-scoped `LoopGuardDoc`. A
  resumed wave reuses the checkpointed conversation and request id; a new wave
  receives a new private lease/cwd.
- `Conversation.submit({type:"input", content, requestId})` +
  `submission.wait(ctx)` → `SettledSubmissionRecord` (`done` | unanswered with
  `reason`, reading `LiveDoc.snapshot` for `runFailure.detail`)
- `Conversation.reset(undefined, ctx)` before wave N>1 after a failed wave —
  failed debugging turns stay in storage (auditable) but out of the window
- `harness.commit(async (tx) => tx.createTask(GovernorSleep, …), ctx)` with
  `ownership: {kind:"conversation"}, conversationId` arms the rate-limit sleep
- report intake: `onReport` rows surfaced into wave-log (`task_interrupted`,
  `task_faulted` …)

## src/engine/gates.ts — recipes + scope (M0-P07)

- recipes `.orch`-adjacent: `evals/recipes.toml` + `evals/recipes.auto.toml`
  (smol-toml). EXACTLY ONE command form per recipe: legacy `cmd = "…"`
  (trimmed and split on whitespace ONLY — quotes, `$`/backtick expansions,
  globs, pipes, redirections and other shell operators are refused with a
  pointer at argv) or literal `argv = [...]` (1–128 string tokens, non-empty
  executable, no NUL, ≤32 KiB total; spaces, empty values and metacharacters
  are data). Invalid forms fail at load; every recipe is additionally
  preflighted (match regexes compiled, real-cwd containment) BEFORE any recipe
  command starts, so one bad recipe starts no command
- execution: the ONE runner `src/engine/recipe-runner.ts` with an injected
  `execArgv` capability (host spawn via `util/exec.ts` today; sandbox lease
  with the same shape in M1) shared by wave gates AND `gates probe` (same
  parser, same `[gates] timeoutSec` deadline). Literal argv, no shell; bounded
  per-stream capture (256 KiB sliding tail + `timedOut`/`stdoutCapped`/
  `stderrCapped` flags); the deadline terminates the whole process group
  (SIGTERM → SIGKILL), so descendants cannot outlive a gate; abort/timeout
  never pass
- matching: ALL `match` regexes must match the captured stdout (empty list
  vacuously true; stderr is never matched) — a deliberate compatibility break
  from the previous any-match. `match` regexes are compiled before any recipe
  executes. stdout beyond the 256 KiB cap with `match` present fails
  `output_capped` (a tail never proves a whole-stream expression); evaluation
  runs in a terminable `worker_threads` job (`src/engine/recipe-match.ts`)
  under the remaining recipe deadline, so a pathological repository regex
  fails its check instead of blocking the host event loop
- recipe `cwd` must be project-relative and stay inside the REAL project root
  (symlink escapes and missing directories refuse before any spawn) —
  `safeRecipeCwdReal` in the runner, re-exported by `adoption/discovery.ts`;
  adoption compares/serializes recipes by canonical argv (`recipesEquivalent`,
  `recipeTomlCommand`), preserving legacy `cmd` rendering so unchanged
  generated recipes keep their fingerprints. Active wave logs land in flat,
  revision/task/wave-qualified `.orch/artifacts/gate-<revision>-<task>-w<N>-*.log`
  names; standalone probe logs retain their baseline name. No-shell spawning and scope/tool guards are
  not containment: recipes and project code execute on the host with the
  CLI's environment (the M1 sandbox boundary replaces that)
- Active serial waves use immutable tree comparison through `diffTaskTrees`:
  scope is the integration parent→candidate delta; progress is the wave's
  startTree→candidate delta. `gates probe` retains its separate consented
  baseline path. No wave gate stages or reads the operator index/worktree.

## src/engine/verifier.ts

- conversation with model `roles.verifier`, `[read]` tool only, guard doc
  `role: "verifier"`; STRICT JSON verdict parse — on any deviation the verdict
  degrades to `needs_human`, never silently approves

## src/engine/model-admission.ts (M0-P16)

- the single paid-submission gate: `admitSubmission(kit, stage, checkpoint)`
  reads the fresh session high-water (max of the priced `sessionUsage()` total
  and the recorded accumulator), syncs the `Models` dispatch guard snapshot,
  and refuses at `>=` of `budgets.sessionUsd` (zero refuses everything) or
  when observed spend is unpriceable — recording the stop (governor row +
  alert + status) with NO provider call. Stages: `planner`, `implement`,
  `primary`, `skeptic`, `verify`
- `guardModelsDispatch(models, state, deniedStream)` wraps the session's
  Models object before `Harness.open`: every chat/deferred dispatch (initial
  request, tool follow-ups, SDK retries, compaction calls) checks the
  high-water snapshot; a denial returns `kit.ts`'s
  `modelStreamSetupError(model, error)` — an async setup-error stream that
  settles `unanswered` with the `BUDGET_DENIAL_MARKER` detail (detected via
  `isBudgetDenial`), never a synchronous throw that would fault the task
- `budgetGuardExtension(state, price)`: the afterResponse hook that folds
  each finished provider turn's priced usage into the snapshot
- `recordBudgetStop` / `refreshAdmissionHighWater`: the committed stop row
  and the run-boundary snapshot refresh
- pricing lives in `src/util/budget.ts` `priceUsage`: reported cost, then
  Models catalog (per-class rates), then config input/output rates; unpriced
  cache deltas and unpriced previously used classes are `unknown`, never
  approximated or labeled free; the faux provider's explicit zero-cost report
  is a legitimate simulated zero
- denial is a budget pause, not a model failure or sleep; a stop is never a
  reject. Resubmission after a terminal failure mints a NEW attempt key
  (never reusing the terminal one) for the unfinished pass only; resume
  reconciles the same request first and prior usage stays counted

## src/engine/governor.ts

- budget math over `harness.usage(Session)` — pi-ai `Usage` shapes; the
  admission estimator (`priceUsage`, see model-admission) prices reported
  cost first, then catalog, then `roles.*.costPerMillionInput/Output`.
  Stops are based on recorded/estimated spend, not a hard provider-bill
  guarantee; an admitted in-flight request can exceed the ceiling
- rate-limit detection (`looksLikeRateLimit`) + reset parsing
  (`parseResetDelay`, e.g. "resets in 30m", "retry after", 429 reset fields);
  sleep via `tasks.ts` `kit.sleep`
- sleep resume across restarts: `harness.getTask` + `resume()` +
  `waitForTask` on re-open (timers wake due sleeps while the process lives; the
  injected fake clock covers tests)

## src/engine/delivery.ts

- `waves.ts` wires `acceptCandidate`, `integrateAcceptedCandidate`, `publishLocalResult`, `discardCandidateWorkspace`, and `publishPullRequest` at the serial candidate/review/integration/publication boundaries. Production `run` no longer stages, restores, checks out, or publishes from the operator worktree.

### M0-P13 — verified stacked PR publication (active through M0-P14)

- `preflightPullRequest(kit, {deliverExplicit, profilePath?})` validates explicit `--deliver`, the canonical host-approved origin, and the reviewed base branch without network effects. It runs before PR-mode grant approval or model dispatch. `publishPullRequest(kit, wave, options)` then requires a current exact grant,
  matching acceptance/integration receipts, an integrated commit with the
  accepted tree and exactly one recorded parent, `delivery.mode = "pr"`, and
  explicit `deliverExplicit: true` (the CLI's `--deliver` consent). It reads
  the destination only from the exact-root operator host policy's
  `projects[].deliveryOrigin`; the optional profile path exists only as a
  test seam. `src/sandbox/host-profile.ts` rejects insecure/non-regular profile
  files and accepts only canonical HTTPS `github.com/owner/repo[.git]` URLs.
  No project config, Git remote, task, or caller-supplied URL can select a
  destination.
- Before publication, the pinned candidate and its integration parent are
  scanned. Any `private` path per `classifyProjectPath` or §2 secret path
  (`.env*`, `.npmrc`, `.netrc`, `.pypirc`, `.ssh/**`, `.aws/**`, `*.pem`,
  `*.key`) refuses; the helper never untracks files or scrubs history.
- The narrow `RemoteGitTransport` only queries an exact fully qualified
  branch ref and performs a create-only push. The trusted implementation uses
  the profile-approved URL and an empty-expected `--force-with-lease`; an
  absent ref may be created, an exact existing OID is observed without push,
  and any different OID blocks. A previously attempted/published but now
  absent ref is not recreated. No branch update, checkout, merge, or repair is
  available.
- The reviewed base branch must still point at the planned base commit. A
  later task may target only the unique, already-published PR branch whose
  integration commit is its exact sole parent; its remote tip must still equal
  that parent. Thus A targets the reviewed base and B targets A's observed
  branch, while B's commit still has A's accepted integration commit as its
  parent.
- `PullRequestHost` searches all PRs for the explicit repo/head so conflicts
  are detectable, and creates with explicit `--repo`, `--base`, and `--head`.
  The trusted `gh` adapter queries reported base/head refs and OIDs. Exactly one
  open PR with the canonical repo, base ref/OID, head ref/OID, number, and URL
  must validate before the delivery receipt becomes `published`. Ambiguity or
  mismatch is `unknown`.
- Delivery receipts journal the exact accepted commit, fully-qualified head
  ref, target base ref, and (only after host validation) PR number/URL. Retries
  re-read the base/head refs and query the PR host first. An exact PR found
  after a lost create response is acknowledged; a possibly attempted create
  with no observable PR stays unknown and is never blindly repeated. A lost
  remote-ref push response is reconciled by exact OID readback.
- `test/pr-publication.test.ts` exercises the publication operation with a
  local bare Git remote and injected fake PR host; it makes no live network call
  and reads no GitHub credential. `test/serial-lineage.test.ts` also exercises
  A→B through the active serial driver in mock-PR mode.

## src/sandbox/host-profile.ts

- `readApprovedDeliveryOrigin(projectRoot, profilePath?)` finds exactly one
  canonical-root project entry in the operator-owned version-1 host policy and
  returns only its validated `deliveryOrigin`; no other host-policy value is
  exposed to PR publication. Production uses the §2 platform path; the path
  override is an internal fake-profile test seam.
- `parseApprovedGitHubOrigin` rejects non-HTTPS, non-GitHub, credentialed,
  ported, query/fragment, malformed, and multi-path URLs and returns one
  canonical `https://github.com/owner/repository.git` origin plus the repository
  identity used to validate PR-host reports.

## src/views/*.ts + src/cli.ts

- `status` panel reads `.orch/status.json` (produced by `flushStated` — atomic
  rename) when the lock is held elsewhere, else opens storage briefly under a
  fresh lock. The additive side-car fields include latest `planRevision`, the
  latest `receiptStates`, and `{wave,baseTree,candidateTree,asOf}` for a frozen
  candidate; `export` renders report.json/report.html from the session state.
- `plan` prints the minted `plan revision` (and the replaced revision on a
  replan) after writing router.md, plus the exact grant command
  (`run --approve --revision <uuid>`); `run` refuses — before any wave or
  model call — when the plan has no identity, the grant is missing/incomplete
  or does not name the current plan revision, the revision/subset/mirror
  checks fail, or an explicit set does not equal the stored grant
  (`grantRefusal` + `approveGrant`/`approvalMirrorRefusal` in the driver)
- arg parsing: `node:util parseArgs` only (no framework); `run` parses
  STRICTLY (no positionals, no unknown flags), repeats `--tasks` once per id
  and requires `--revision` with `--approve`. PR mode preflights `--deliver`,
  the allowlisted origin, and reviewed base before work starts. Exit codes:
  0 fulfilled · 2 stopped/recovery-required · 42 sleeping · 1 invalid/error/busy · 130 SIGINT.
  `none` prints the detached accepted-ref checkout command; `commit` names its
  local result ref. PR publication is not merge.

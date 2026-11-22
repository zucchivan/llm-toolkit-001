# project-contract

What `<kit> init` writes in a target project, and how versions move.

## Files created (idempotent, never clobbered)

| file | purpose | engine-owned? |
| --- | --- | --- |
| `PROMPT.md` | per-wave discipline appended into each implementer wave input | template (user-editable) |
| `evals/checklist.md` | human-editable acceptance-criteria template aligned with the RouterDoc schema | template (user-editable) |
| `evals/recipes.toml` | human gate recipes — COMMENTED defaults; empty = scope-check-only; same names override generated recipes | template (user-editable; hot-read every gate run) |
| `evals/recipes.auto.toml` | approved discovered gate recipes; supports project-relative `cwd` for workspaces | generated only by approved `gates refresh`; absent initially |
| `router.md` | human-readable MIRROR of RouterDoc; engine rewrites it on router commits; review it, but revise the PRD and replan instead of editing it as input | engine |
| `.orch/config.toml` | annotated project config (roles, budgets, gates, delivery, paths) | config |
| `.orch/kit-version` | provenance line: `kit=<kit> pi-durable=<pinned>` | engine |
| `docs/prd.md` | placeholder when `--with-demo`, otherwise absent (user brings the PRD) | user |
| `.gitignore` | appends `.orch/durable.sqlite*`, `.orch/lock`, `.orch/status.json`, `.orch/pending-handoff.json`, `.orch/artifacts/` (only missing lines) | appended |

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

Private runtime paths ignored by the init template: `.orch/durable.sqlite*`
(durable storage, WAL), `.orch/lock` (PID lock), `.orch/status.json` (atomic
status panel payload), `.orch/pending-handoff.json` (queued user note), and
`.orch/artifacts/*` (gate logs, quarantine patches, exports). These artifacts
are best-effort local evidence, not guaranteed commits or effect receipts.
`.orch/wave-log.jsonl` is a separately rewritten mirror; the current init
ignore list does not add a rule for it.

## config.toml fields (role identities required; other settings defaulted)

- `[engine]` — `piDurable` (pinned release, asserted against the installed
  package at boot), `maxTurns` (tool rounds per run, default 50), `retryLimit`
  (waves per task before quarantine, default 3)
- `[roles.planner|implementer|verifier]` — each role block requires string
  `provider` and `modelId` identities; these fields are not optional. Optional
  `thinkingLevel`, `costPerMillionInput`, and `costPerMillionOutput` provide
  thinking configuration and USD-rate fallback for budget estimates when
  providers/catalogs do not report cost.
- `[budgets]` — `sessionUsd` (observed/estimated spend stop, not a hard provider-bill cap), `waveUsdWarn`, `maxConsecutiveErrors`, `maxSleepCycles`. An admitted in-flight request can exceed the ceiling.
- gate recipes — `[name]` tables in `evals/recipes.toml` and approved
  `evals/recipes.auto.toml`: argv-simple `cmd`, optional stdout `match`, path
  fast-skip `on`, and optional project-relative `cwd`. Human duplicate names
  override generated entries. Recipe cwd cannot be absolute or escape the root.
- `[gates]` — `timeoutSec` (per recipe), `enforceTargetPaths` (working-tree scope check + write/edit guard; neither is OS containment and bash/recipes still execute on the host),
  `skepticSecondPass` (default `true`, including when omitted): after primary
  approval, a fresh read-only adversarial verifier must also approve. Explicit
  `false` is the single-pass opt-out. The adversarial pass checks criteria,
  regressions, edge cases, missing tests, scope, and security/data-loss risks;
  malformed or inconclusive output becomes `needs_human`, never approval. Wave
  log rows `verify:*` and `verify:skeptic:*` record each pass's verdict and usage.
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
- `[delivery]` — `mode`: `none` (default; leaves changes in the operator's working tree) | `commit` (attempts a commit on the checked-out branch) | `pr` (optionally attempts branch/PR creation and additionally requires the run's `--deliver` flag; never merges the PR)
- `[paths]` — `prd` (default `docs/prd.md`), `specs`

NO SECRETS live in config.toml: providers read credentials from the
environment, exactly as pi-ai expects (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`). The optional Jev shadows use
`TYPESAFE_API_KEY` from the environment as well; no API key is a config field or
assessment property.

Idempotency: `init` writes a file only when it is absent or empty; when a
user-edited file exists it is LEFT UNTOUCHED and reported under
"kept existing (not clobbered)". `.gitignore` lines append only when missing.
Running `init` twice is safe and prints the second result. Init does not run
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
   treating mirror edits as input. `run --approve` approves RouterDoc state.

## Upgrade & migration notes

- The kit is versioned semver; `.orch/kit-version` records which pairs
  (kit, pi-durable) created the project.
- pi-durable upgrades: `docs/api-map.md` is the contract map — the engine only
  touches the exports listed there. `assertPinnedPiDurable()` compares the
  INSTALLED `@earendil-works/pi-durable/package.json` version and the
  `[engine] piDurable` config value against the built-in `PD_VERSION` pin and
  refuses to run on mismatch with a pointer at this doc.
- RouterDoc schema changes land ADDITIVELY with a careful `version` bump and a
  `migrate` function when semantics change; readers treat absent fields as
  defaults (e.g. `convId` missing ⇒ open a new conversation for the task).
- Wave-log rows are append-only JSON; old rows stay readable forever. The
  default-on skeptic pass adds `verify:skeptic:<verdict>` rows without changing
  the wave-log schema version; existing `verify:<verdict>` rows remain primary
  verdicts, and summing verdict-row usage now accounts for both conversations.
- Delivery modes matter for upgrade drills: `none` leaves waves in the working
  tree, so a kit update mid-project is a checkout switch, not a code migration.

## Runtime layout in the project

```
.orch/
├── config.toml          # project config (above)
├── kit-version          # provenance marker
├── lock                 # PID lock (single storage owner)
├── durable.sqlite*      # pi-durable storage (WAL; local-only)
├── status.json          # atomic status payload (status --follow reads this)
├── wave-log.jsonl       # JSONL mirror of WaveLogDoc (local paper trail; no init ignore rule)
├── pending-handoff.json # queued handoff note (handoff command)
└── artifacts/           # gate logs, quarantine patches, exports

router.md                # RouterDoc mirror (review/local paper trail; not plan input)
PROMPT.md, evals/, docs/prd.md
```

> Note on `.orch/wave-log.jsonl`: it mirrors durable storage and is rewritten
> after state commits. The current init template does not ignore it; operators
> choose whether to retain or commit that local paper trail. Neither this file
> nor `router.md` is guaranteed committed evidence, and mirror content alone
> does not certify rollback, delivery, or another external effect.

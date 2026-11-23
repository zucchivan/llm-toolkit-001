# llm-toolkit-001 — durable, gate-enforced autonomous coding loop

A maintained TypeScript **agent implementation loop template**: point it at a PRD,
review one plan, and let a budget-governed `pi-durable` agent harness produce
frozen candidate trees and receipted outcomes — implementer waves → deterministic
gates → read-only verifier + default-on adversarial second pass → accepted
lineage → optional local result branch or pull request. The operator checkout is
not the result location; pull-request creation never merges code.

- Runtime: [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable) **1.5.0** (pinned exact) on Node ≥ 22.19 (Node 24 LTS preferred).
- One provider/model per ROLE (planner / implementer / verifier) from project config — subscription-budgeted, sequential v1, no parallel agent fan-out.
- Three-class repository hygiene (ADR 04): durable storage, locks, projections,
  assessments, exports, and UI jobs under `.orch/` are **private** and
  git-ignored by default; `router.md`, `.orch/wave-log.jsonl`, and
  `.orch/kit-version` are the **optional local paper trail** — also ignored by
  default, explicitly retainable after review (`git add -f`); the three
  reviewable kit controls (`.orch/config.toml`, `.orch/gate-decisions.json`,
  `.orch/gate-remediations.json`) stay committable but are never auto-staged.
  These mirrors/artifacts are local evidence, not guaranteed committed
  evidence. The driver writes private candidate objects/refs under `refs/kit/`
  and never changes the operator checkout or index; public/local result refs
  are written only by the configured and receipted delivery path.
- Gates (recipes), a read-only verifier with a default-on adversarial second
  pass, and a budget governor (estimated session USD ceiling,
  zero-progress/duplicate-failure breakers, rate-limit durable sleep with exit
  42) are built in.

## 5-minute quickstart

```bash
# 1. scaffold a project (idempotent; never clobbers your edits)
npx llm-toolkit-001 init . --with-demo     # in the repo root of your project

# 2. declare roles in .orch/config.toml
#    planner/implementer on your main model, verifier on a cheaper one:
#    provider+modelId per role; credentials come from env (ANTHROPIC_API_KEY etc.)
#    approvals get a second adversarial verify call by default; opt out with
#    [gates] skepticSecondPass = false

# 3. write the PRD at docs/prd.md and commit the intended base with your normal Git workflow.
#    plan records HEAD; `run` requires that reviewed base commit. Dirty operator changes are excluded.
llm-toolkit-001 plan --prd docs/prd.md     # writes RouterDoc + router.md, stops

# 4. REVIEW router.md, the generated mirror. To change the graph, revise the
#    PRD and rerun plan; do not edit router.md as plan input. Then approve by
#    naming the revision `plan` printed (all tasks) or a subset (--tasks per id):
llm-toolkit-001 run --approve --revision <uuid>            # 0 fulfilled · 2 stopped short · 42 sleeping · 1 busy/error
llm-toolkit-001 run --approve --revision <uuid> --tasks one-task --tasks other-task
llm-toolkit-001 run                        # resume the stored grant bare (no re-approval)
llm-toolkit-001 status --follow            # live panel (reads .orch/status.json)

# 5. paper trail: router.md (mirror), .orch/wave-log.jsonl (rows),
#    .orch/artifacts/*.log (gate output), export HTML/JSON anytime:
llm-toolkit-001 export
llm-toolkit-001 inspect --health            # full snapshot: tasks, usage, timeline, health

# extras
llm-toolkit-001 handoff "context for the next wave"
llm-toolkit-001 verify --task some-task-id  # one-off read-only verification of the latest retained candidate
```

### Scripted smoke, no API keys (fixture replay)

`KIT_FAUX=1` runs every conversation on an in-package faux provider
(`kit-planner` / `kit-impl` / `kit-verifier` model ids). `examples/demo-prd`
ships the replay, the recipe file and the gate script for the full
plan→wave→gate→verify arc — and the demo is falsifiable at runtime: three
behavioral gates execute the product (parser + renderer, the case-insensitive
query, and the real CLI invocation). Task 2's first scripted wave ships a
CASE-SENSITIVE `queryList` that the executed gate rejects; the driver resets
the conversation and wave 2 repairs it from the gate feedback — a retry proven
by behavior, not by a BROKEN token:

```bash
cp -r examples/demo-prd /tmp/demo && cp examples/demo-prd/smoke-gate.cjs /tmp/demo/evals/ && cd /tmp/demo
npm i <the kit repo>            # or install the kit globally / via npx

llm-toolkit-001 init . --with-demo
# point [roles.*] at provider "faux" + modelId kit-planner|kit-impl|kit-verifier
#   (or KIT_FAUX=1 keeps probe-vs-credentials decoupled from real providers)
# evals/recipes.toml (shipped with the fixture) wires gate-list / gate-query /
#   gate-cli to evals/smoke-gate.cjs — no hand-editing. The extra cp above is
#   the demo setup: the reviewed gate bytes go to evals/ for execution.

git init -q && git add -- . && git commit -qm base   # commit this disposable fixture before planning
KIT_FAUX=1 KIT_FAUX_SCRIPT=smoke.replay llm-toolkit-001 plan
KIT_FAUX=1 KIT_FAUX_SCRIPT=smoke.replay llm-toolkit-001 run --approve --revision <uuid>   # → STATUS: COMPLETE
# <uuid> is the `plan revision` the plan command printed (or read from router.md).

# `none` keeps the operator checkout unchanged; inspect the accepted result separately.
git worktree add --detach /tmp/demo-result refs/kit/<revision>/accepted
cd /tmp/demo-result
node bin/render.js '/a/-b'      # prints exactly `a b`
```

The replay demonstrates loop transitions WITH an outcome test: after the run,
the independent `node bin/render.js '/a/-b'` invocation in a detached view of
`refs/kit/<revision>/accepted` must exit 0 and print exactly `a b` — a missing
`renderList` export, a case-sensitive query, or the old parser defect (dropping
`-b` instead of stripping its dash) all fail the gates. The operator HEAD,
index, staged/unstaged files, and ignored files are not changed by the run.
The demo requires Node ≥ 23.6: the product's `src/*.ts` modules run through
Node's default TypeScript type-stripping.

Replay format: `[planner]` / `[implementer]` / `[verifier]` sections with
`---` separated chunks; a chunk is one model request's answer — plain text
(final assistant turn), the planner's tasks JSON, a verifier verdict JSON, or
`{"tool":"write","path":"src/x.ts","content":"…"}` for a tool round. Unless
the demo config opts out, each approved task consumes two verifier chunks:
primary approval followed by adversarial approval.

## Commands

| Command | What it does |
| --- | --- |
| `init . [--with-demo]` | scaffold §5 files; idempotent; prints what it skipped |
| `gates list [--json]` | read-only project discovery, factual gate inventory, and evidence-based gaps |
| `gates refresh [--accept recommended \| --skip-gates]` | interactively select/defer findings, preview generated diffs, approve writes; never probes |
| `gates probe [--yes]` | separately consented baseline recipe execution; reports pre-existing failures |
| `plan [--prd path]` | PRD + approved gap remediations → RouterDoc + router.md; STOP for human approval |
| `run --approve --revision <uuid> [--tasks id…] [--deliver]` | NEW grant: the sequential wave cycle over exactly that reviewed plan revision; omit `--tasks` for every task, repeat `--tasks` once per subset id |
| `run [--tasks id…]` | resume the stored grant bare (no re-approval); an explicitly supplied set must equal the grant exactly |
| `status [--follow]` | task graph + budgets from `.orch/status.json` (when a run is locked) or storage |
| `inspect [--json] [--health] [section…]` | full visibility snapshot: tasks, usage splits, wave timeline, conversations, artifacts, health; degrades to side-cars while a run holds the lock |
| `verify --task id` | one-off read-only verification of the latest retained candidate; no operator-checkout fallback |
| `export` | per-project JSON+HTML report from storage into `.orch/artifacts/` |
| `handoff "note"` | queue a note the driver ingests at the start of the next wave |
| `ui [--port n] [--no-open]` | the local web UI (separate sub-product under `ui/`) — see [`ui/README.md`](ui/README.md) |

Exit codes: `0` fulfilled — `STATUS: COMPLETE` (every task in the plan done) or `selection complete` (the granted subset is done; the plan's remaining work is named, the router phase stays open) · `2` policy stop — quarantine, blocked members, budget, or `recovery-required` for an uncertain effect · `42` sleeping (rate-limit durable sleep armed — rerun `run`) · `1` invalid input, refused grant, lock busy or error · `130` SIGINT.

### Current behavior and limits

- A grant approves ONE exact plan revision with an EXPLICIT task list:
  `run --approve --revision <uuid>` (omit `--tasks` for all ids — stored
  explicitly, not as a wildcard; repeat `--tasks` per subset id). The grant,
  the phase flip and the review row commit atomically; dependencies are
  never auto-included (an unsatisfied dependency outside the selection is
  refused at approval with the named culprit). A bare `run` resumes exactly
  the stored grant — mirror edits are never imported — and an explicitly
  supplied set without `--approve` must equal it. A new grant is refused
  while `router.md` is missing or differs from the durable render (replan to
  refresh). A satisfied subset reports selection-complete and the router
  phase stays open; only whole-plan fulfillment flips the phase to complete,
  and it is recorded once. Quarantined/blocked selected tasks stop the run
  with exit 2 and the ids — never 0/complete. `router.md` is a rewritten
  review mirror, not editable plan input; revise the PRD and rerun `plan`.
- Delivery modes use separate result locations. `none` records the accepted
  lineage at `refs/kit/<revision>/accepted`; inspect it in a detached worktree.
  `commit` compare-and-swaps the named local branch
  `refs/heads/kit/<revision>/result` without checking it out. `pr` requires
  `--deliver`, the operator host-profile `deliveryOrigin`, and reviewed base
  branch preflight before implementation starts; it publishes verified stacked
  PR heads and never merges them.
- Implementer tools, gates, probes, and delivery run on the host. Write/edit
  guards, target-path checks, and `shell: false`-style process spawning are not
  OS containment; use trusted projects and fixtures only. Gate and probe
  recipes also inherit the CLI's environment (PATH/HOME included) until the
  M1 sandbox boundary lands.
- Budget stops guard every paid submission (M0-P16): one `admitSubmission`
  gate admits the planner conversation, every implementer retry, each verifier
  pass, and one-off `verify`, refusing at `>=` of `budgets.sessionUsd` — a zero
  ceiling refuses all paid work — and recording the stop with no call. A
  `Models` dispatch guard covers every provider dispatch inside a submission,
  including tool follow-ups, SDK-level transport retries, and compaction
  calls. Pricing uses provider/catalog cost first, then config rates; an
  unpriced cache delta or a previously used class with no price anywhere
  pauses submissions with a distinct reason instead of approximating or
  labeling it free (fixtures/replays on the faux provider may report
  simulated zero). A budget stop is a pause, never a reject: the paused stage
  checkpoint and any verified candidate persist, and raising
  `budgets.sessionUsd` resumes the same pass — a terminal failure is never
  replayed and its request key never reused. Resume after an interrupted
  submission reconciles the same request first; prior usage is always
  counted, so resume never double-charges. Recorded spend is a session
  estimate, not a hard provider-bill cap: hidden transport retries and
  external services inside a provider implementation are only visible once
  usage lands, and one admitted in-flight request can overrun the ceiling.
- Quarantine retains the frozen candidate for review and discards only the
  owned private workspace. A rollback receipt is `discarded` only after the
  workspace is observed absent and the accepted integration ref unchanged;
  failed/unknown disposal blocks the task and its dependents. Candidate patches
  are display evidence, never rollback inputs.
- Read-only views (`status`, `inspect`, `export`, and the web UI's reads) open
  durable storage with the harness's `readOnly` option while still holding
  `.orch/lock`: zero model/tool calls, no scheduling, no task progress, and
  commits with writes refuse. A project that has never run has no
  `.orch/durable.sqlite` — observation never creates one; it reports
  empty/absent evidence from the side-cars instead.
- The kit version is the package version (`package.json`, read once in
  `src/config.ts`): the CLI header, the `.orch/kit-version` init marker, and
  readout identities all name the same value. Kit identities recorded by older
  kits in existing stores are historical and are never rewritten.
- `init` installs the hygiene defaults as ONE bounded, idempotent `.gitignore`
  block and reports conflicts instead of repairing them: a pre-existing rule
  that excludes `.orch/` itself defeats the reviewable exceptions, and a
  private file that is already tracked stays tracked (ignore rules do not
  apply to tracked files). The kit never modifies your git index or history —
  no forced `git rm --cached`, no history cleanup, no retention daemon. To
  stop tracking a private file, run `git rm --cached -- <path>` yourself after
  saving anything you need; a tracked paper-trail file is simply manual
  retention. See `docs/project-contract.md` for the exact classes and defaults.

## Adopting an existing project

`init` deliberately starts with scope checking only. Adoption is a separate,
evidence-first flow:

```text
discover → inventory existing gates → analyze cross-cutting gaps
  → inspect evidence and recommendations → explicit human selection
  → approve generated-file diff → optionally approve a separate baseline probe
```

Start with:

```bash
llm-toolkit-001 init .
llm-toolkit-001 gates list
```

Discovery is deterministic and read-only. It reads root/workspace
`package.json` scripts, npm workspaces, npm/pnpm/yarn/bun lockfiles, common test
and tool config, test/migration/API file names, and literal single-line
package-manager commands in common CI files. It does **not** execute package
scripts, CI YAML, shell text, or an LLM. `gates list --json` exposes the same
inventory, findings, evidence, and recommendations for automation.

The report uses six states: **covered** (an effective recipe covers the
surface), **missing** (a surface exists but no implementation/command was
found), **present-but-unwired** (a script or literal CI command exists but no
gate invokes it), **partial** (for example, root tests are wired but a workspace
is not), **not-applicable** (the surface does not exist), and **unknown**
(test/tool evidence exists but the command cannot be resolved conservatively).
A heuristic gap is never a blocking gate until a human adopts it.

### Example: accept the recommended fast checks

Suppose `package.json` has `test`, `lint`, and `build` scripts and no recipes.

- **Detection evidence:** `gates list` names `package.json`, each script's exact
  value, and the package-manager lockfile used to choose `npm`/`pnpm`/etc.
- **Why it matters:** these existing repeatable checks catch regressions before
  model verification; adoption wires commands you already own rather than
  inventing a new test policy.
- **Available choices:** choose `a` to accept recommended fast deterministic
  recipes and approved planning remediations; `c` for individual decisions; `i`
  for evidence; `s` to defer; or `n` to record a reasoned not-applicable
  decision. Slow E2E/accessibility checks are not included in `a`.
- **Write/execution effects:** after the diff, `y` writes only
  `evals/recipes.auto.toml`, `.orch/gate-decisions.json`, and
  `.orch/gate-remediations.json`. It does not run the scripts, install
  dependencies, generate tests, or edit `docs/prd.md`.

```bash
llm-toolkit-001 gates refresh
# Selection [a/c/i/s/n]: a
# inspect the + additions / ~ changes / - removals
# Approve these writes? [y/N] y
```

The equivalent scripted decision is `gates refresh --accept recommended`; that
flag is both explicit selection and generation approval. It still does not
probe or execute the new recipes.

### Example: choose individually and inspect evidence

For a workspace with root `npm test` and `packages/web`'s own test script:

- **Detection evidence:** the finding `unit-test:packages/web` cites
  `packages/web/package.json`; its **partial** state distinguishes it from the
  already covered root. The recommendation is `npm test` with
  `cwd = "packages/web"`.
- **Why it matters:** a root gate does not prove that a package's own test
  command runs in its package context.
- **Available choices:** select `i`, then a finding number/id, to inspect without
  deciding. Select `c`, then use `a` (accept), `e` (show evidence again), `s`
  (decide later), or `n` (not applicable; a reason is mandatory) per finding.
- **Write/execution effects:** accepting proposes a generated workspace recipe;
  deferring/N/A records only a decision. Nothing executes during selection or
  generation. Workspace recipes execute relative to the project root plus
  `cwd`; absolute paths and parent-directory escapes are rejected.

```text
Selection [a/c/i/s/n]: i
Finding number or id: unit-test:packages/web
Selection [a/c/i/s/n]: c
unit-test:packages/web: [a]ccept · [e]vidence · [s]later · [n]ot applicable: a
Approve these writes? [y/N] y
```

### Example: a web app has no E2E journeys

- **Detection evidence:** an app-style `dev`/`start` script (for example Vite or
  Next) establishes a web surface. No E2E script, Playwright/Cypress config, or
  E2E files were found, so the state is **missing**, not merely unwired.
- **Why it matters:** critical browser journeys can catch integration failures
  that unit tests miss. The evidence does not justify inventing journeys or
  assuming every library needs a browser.
- **Available choices:** accept queues a planning remediation; defer leaves it
  unimplemented; N/A records why browser journeys do not apply. E2E is excluded
  from accept-recommended, so use individual selection to opt in.
- **Write/execution effects:** approval records the remediation in
  `.orch/gate-remediations.json`. The next `plan` includes it as an additional
  requirement for normal RouterDoc review. It does not edit the PRD, generate
  tests, add dependencies, or create an executable E2E recipe.

A plain library—even one with a React dependency and no app-style browser
script—is **not-applicable** for E2E. No E2E recommendation is made.

### Example: E2E exists but is not wired

- **Detection evidence:** `package.json` contains `test:e2e` (or E2E config/files
  exist), while neither human nor generated effective recipes cover E2E. A
  script yields **present-but-unwired**; files/config without a resolvable script
  yield **unknown**.
- **Why it matters:** an existing suite provides no wave protection if no gate
  invokes it; an unresolved suite needs a human to identify its command.
- **Available choices:** individually accept an exact existing `test:e2e`
  command, defer it, or mark it N/A with a reason. For unknown commands, accept
  the planning remediation rather than a guessed command.
- **Write/execution effects:** accepting a resolved command writes its recipe
  only after diff approval. E2E remains slow/opt-in and is not run until
  `gates probe` consent or a later wave. No browser is launched by discovery.

### Example: unresolved test commands

- **Detection evidence:** `vitest.config.ts`, Jest config, or test files exist,
  but no supported test script exists. The unit-test state is **unknown** and
  the evidence lists those files.
- **Why it matters:** config alone does not establish a safe, repeatable command;
  guessing can run the wrong suite or hang.
- **Available choices:** accept a remediation to resolve/add the command through
  the normal planner and plan review, defer, or record N/A with a reason.
- **Write/execution effects:** no test command is synthesized and no test is
  generated. Only the approved decision/remediation JSON is written; a later
  reviewed plan can add the actual command and gate.

### Cross-cutting gap examples

Each scenario below appears in `gates list` with its evidence and why text. In
`gates refresh`, every one supports accept (when a safe recommendation exists),
individual selection, evidence inspection, defer, and reasoned N/A. Recipe
acceptance writes only after generation approval; remediations go only to the
next reviewed plan. None of these analyses executes the underlying command.

#### API integration gap

- **Detection evidence:** a server framework/API script or API route files
  establish the surface. `test:integration` without a corresponding gate is
  **present-but-unwired**; routes with no integration command are **missing**.
- **Why it matters:** route, serialization, and service-boundary contracts need
  integration coverage beyond isolated units.
- **Available choices:** wire the exact integration script individually or via
  recommended selection; accept a planning remediation if missing; defer/N/A.
- **Write/execution effects:** a resolved script becomes a generated recipe after
  approval. A missing suite becomes planning input only. No API or database is
  contacted during refresh.

#### Migration validation

- **Detection evidence:** SQL/TS/JS files under conventional migration paths.
  An existing `migrate:validate`/`db:validate`-style script is unwired when no
  migration gate covers it; files without a script are missing.
- **Why it matters:** invalid or non-reproducible schema changes can pass code
  tests yet fail during deployment.
- **Available choices:** approve the existing validation script, queue reviewed
  remediation work, defer, or N/A with the project's migration policy.
- **Write/execution effects:** only the generated command/decision or remediation
  is written. Refresh never runs migrations and never connects to a database.

#### Package/CLI smoke checks

- **Detection evidence:** a non-private package or `bin` entries in
  `package.json`. With no package smoke script, the safe npm recommendation is
  `npm pack --dry-run --ignore-scripts`; an existing package/CLI smoke script is
  wired verbatim through its package manager.
- **Why it matters:** publish contents and CLI packaging can be broken even when
  source tests pass.
- **Available choices:** accept the dry-run/script, defer, or N/A. Workspaces get
  a package-relative `cwd` and a distinct generated recipe name.
- **Write/execution effects:** generation writes the recipe only. The dry-run
  uses no install and ignores package scripts, but—like every gate—it executes
  only after probe consent or during a wave.

#### CI drift

- **Detection evidence:** literal single-line `run: npm test`, `npm run build`,
  etc. in `.github/workflows/*.yml|yaml` or `.gitlab-ci.yml`. Multi-line YAML,
  expressions, arbitrary shell, install commands, and other CI operations are
  not promoted. A literal check absent from effective recipes is
  **present-but-unwired**.
- **Why it matters:** different local and CI check sets produce contradictory
  results and late failures.
- **Available choices:** accept the exact safe package-manager command, defer, or
  N/A. Existing equivalent effective commands count as covered.
- **Write/execution effects:** approval writes a CI-parity recipe; CI files are
  never edited and CI YAML is never executed by discovery.

#### Accessibility where applicable

- **Detection evidence:** a web surface, accessibility tests/config, or an
  `a11y`/accessibility script. Existing tooling without a gate is unwired; a web
  surface without it is missing; non-web projects are N/A.
- **Why it matters:** browser functional journeys do not necessarily detect
  keyboard, semantics, or accessibility regressions.
- **Available choices:** opt into a resolved check individually (it is excluded
  from fast recommended selection), accept reviewed remediation work, defer, or
  N/A with a reason.
- **Write/execution effects:** no accessibility scanner is installed or run.
  Approval writes only the selected generated recipe or planning remediation.

### Generation approval and human configuration

- **Detection evidence:** the final refresh view lists exact recipe names,
  commands, `cwd`, and any remediation specs derived from the inspected findings.
- **Why it matters:** selecting a recommendation and changing the gate contract
  are separate decisions; the diff prevents silent additions or removals.
- **Available choices:** `y` approves the displayed writes; anything else aborts
  the whole adoption transaction. `--accept recommended` is the explicit
  non-interactive approval for the recommended subset.
- **Write/execution effects:** approved entries go to
  `evals/recipes.auto.toml`; human-owned `evals/recipes.toml` is byte-preserved.
  Both are loaded, and a same-named human recipe overrides the generated one.
  Declining writes nothing and runs nothing. Recipes remain argv-simple: no
  shell, pipes, `&&`, arbitrary YAML execution, or dependency installation.

### Baseline probing is a separate confirmation

- **Detection evidence:** probe lists every effective recipe, its source, exact
  command, and `cwd` before execution.
- **Why it matters:** a newly wired command may already fail; knowing the
  baseline prevents adoption from being mistaken for the cause.
- **Available choices:** answer `y` to execute sequentially, or decline. In a
  non-interactive shell, `gates probe --yes` is required; without it, probe exits
  without running commands.
- **Write/execution effects:** consent executes the commands with the SAME
  runner and `[gates] timeoutSec` deadline the wave gates use — no shell, so
  wave and probe observe identical literal tokens and match results. Probe
  writes no adoption config. It prints PASS/FAIL and
  labels failures as **pre-existing baseline failures**; it does not weaken,
  remove, or mark a failing gate as passed.
- **Recipe compatibility (M0-P07):** each recipe sets EXACTLY ONE command
  form — legacy `cmd` (split on whitespace only; quotes, `$`/backtick
  expansions, globs, pipes, redirections and shell operators are refused with
  a pointer at argv) or literal `argv` tokens (spaces, empty values and
  metacharacters are data, 1–128 tokens, ≤32 KiB, no NUL). ALL `match`
  regexes must match captured stdout (empty list vacuously true; this tightens
  the previous any-match behavior — split either-or checks into separate
  recipes), regexes compile before any recipe runs, stdout past the 256 KiB
  capture cap with `match` present fails `output_capped` instead of matching
  a truncated tail, and match evaluation runs in a bounded worker under the
  recipe deadline. Recipe `cwd` must stay inside the real project root —
  symlink escapes refuse. An invalid recipe fails BEFORE any recipe command
  starts, in waves and in probes alike.

```bash
llm-toolkit-001 gates probe       # TTY: review commands, then separately confirm
llm-toolkit-001 gates probe --yes # explicit scripted execution consent
```

### Refresh additions, changes, and removals

- **Detection evidence:** later discovery compares current scripts/surfaces and
  evidence fingerprints with the remembered decisions and generated file.
- **Why it matters:** a renamed script can make an old generated recipe stale;
  deletions need the same human control as additions.
- **Available choices:** review each reopened finding, then approve or decline
  the displayed `+` additions, `~` before→after changes, and `-` removals.
  Defer keeps a stale generated command in place rather than silently removing
  it; N/A can approve its removal with a reason.
- **Write/execution effects:** only approval rewrites the generated file and
  decisions. Human recipes are untouched; refresh still executes no recipes.

### Remembered decisions and new evidence

- **Detection evidence:** `.orch/gate-decisions.json` stores finding id,
  accepted/deferred/skipped/N/A decision, evidence fingerprint, selected recipe
  or remediation, and the required N/A reason.
- **Why it matters:** deferring an intentional gap should not produce repeated
  nagging, while a new script, surface, or changed command should reopen it.
- **Available choices:** unchanged decisions require no prompt. A meaningful
  evidence change marks the finding **reopened** and offers the full choice set
  again.
- **Write/execution effects:** quiet refreshes write nothing. A reopened decision
  changes files only after the normal generation approval; no evidence change
  directly triggers execution.

### Non-interactive safety

- **Detection evidence:** `gates list` and bare `gates refresh` still produce the
  factual inventory/report when no TTY is available.
- **Why it matters:** automation must not turn heuristics into blocking gates or
  execute project commands accidentally.
- **Available choices:** bare refresh makes no adoption changes. Use exactly
  `--accept recommended` to approve the fast recommended subset, or
  `--skip-gates` to record explicit skip decisions without generating recipes.
  Probe independently requires `--yes`.
- **Write/execution effects:** `--accept recommended` writes the generated file,
  decisions, and approved remediations but executes nothing. `--skip-gates`
  writes only decisions/remediation state (no new recipes). Bare refresh and
  list write nothing; probe without `--yes` executes nothing.

## Web UI (sub-product)

`llm-toolkit-001 ui` forwards to the small local control surface that lives in
`ui/` — it is an independent package with its own version, lockfile, and
CHANGELOG (nothing is added to this package's dependency footprint). M0 shows
the truthful live state of one loop: phase, current task/wave + elapsed,
budget, task table, event-log tail — attaching to runs started in a terminal.
Install and run it once, from the kit repo root:

```bash
npm --prefix ui install
npm --prefix ui run build
llm-toolkit-001 ui --no-open
```

See [`ui/README.md`](ui/README.md) and [`ui/PRD.md`](ui/PRD.md); the only core
changes are the additive `readout.seam = 1` fields (ui/PRD.md Appendix A).
Verification runs locally (this repo carries no hosted CI): the engine suite
and the ui sub-product's suites — including the faux e2e against the real
CLI — before any push.

The M0-P14 serial driver freezes candidates from committed Git objects, never
from the operator checkout. It writes best-effort, revision-qualified
per-wave artifacts (`candidate-<revision>-<task>-w<N>.patch` plus `.json`),
and status/readout rows add the latest `planRevision`, receipt states, and
`{wave,baseTree,candidateTree,asOf}` when a candidate is frozen. Artifacts are
display evidence only; acceptance, integration, workspace disposal, and
publication are separate durable receipts. The UI's live diff endpoint is not
yet checkpoint-only (M0-P15); it must not attribute operator-checkout edits to
a task.

## The cycle

```
PRD →[plan, one conversation, read-only]→ RouterDoc + router.md (planned)
      │ human grant (--approve --revision / {planRevision, selected, humanApprovedAt})   ← review point
      ▼ [run — exactly the granted revision + task list]
  per granted task (topological, priority, id tie-break; deps seen across ALL tasks):
    accepted parent → private task lease (wave 1 starts at its tree;
      retry starts at the prior failed candidate) → stable submission checkpoint
      → fence + freeze candidate → scope check + reviewed recipes on candidate
      → primary verifier (read-only, strict JSON) → evidence-backed approval
      → fresh adversarial verifier (default on; read-only)
      → accept candidate → one-parent integration commit → publication receipt
      → done only after publication state is confirmed
    failed/rejected candidate → retain pinned tree, discard only owned lease,
      record rollback receipt → retry or quarantine once
    uncertain gate/publication/disposal effect → recovery-required (exit 2);
      task stays non-done and no dependent wave starts
  fulfillment: whole plan done ⇒ phase complete (recorded once); granted subset
  done with plan work remaining ⇒ selection-complete, phase stays open.
  budgets/breakers: session USD ceiling (exit 2), wave warn, zero-progress from
  start-of-wave tree→candidate, duplicate gate-failure hash, consecutive-error
  cap, rate-limit durable sleep (exit 42). Malformed/inconclusive/unproven
  verdicts ⇒ needs_human (never approval)
delivery: none (accepted ref; default) | commit (named local result branch) |
  pr (stacked create-only refs; requires preflight + --deliver; never merges)
```

The implementer's final `STATUS: COMPLETE` / `STATUS: BLOCKED` line is a
nonbinding report. It neither satisfies acceptance criteria nor changes task
status; gates and verifier passes determine the loop's outcome.

For `none`, inspect the result with `git worktree add --detach /path/to/result refs/kit/<revision>/accepted`; the operator checkout is not the result directory. `commit` publishes `refs/heads/kit/<revision>/result` without checkout. PR mode preflights the host allowlist, reviewed base, and explicit `--deliver` before implementation.

`[gates] skepticSecondPass` defaults to `true` when omitted. Set it to `false`
for the explicit single-verifier opt-out. Each pass appends its own verdict,
token, and USD usage row to `.orch/wave-log.jsonl` (`verify:*` and
`verify:skeptic:*`).

### Criterion evidence and reviewed passes (M0-P11)

Approval is enforced SYMMETRICALLY on both verifier passes: every reviewed
criterion must be marked pass and cite valid evidence against the checked tree —
an executed, non-scope, non-skipped passing gate, or a line that exists in a
regular text blob of that tree (`{"kind":"gate","id":…}` /
`{"kind":"line","path":…,"line":…}`; see `template/evals/checklist.md`).
Missing, malformed, duplicated, or unknown criterion ids, missing proof,
malformed JSON, prose around the JSON, or an inconclusive answer refuse the
approval as `needs_human`; a well-formed explicit `reject` stays reject. No
skeptic runs after an invalid or nonapproving primary, and each pass commits its
`loop.receipts` pass receipt — criteria, effective verdict, checked tree, gate
receipt id, policy — BEFORE the next pass is dispatched. The wave's gate outcome
commits a gate receipt binding the checked tree and every check outcome. The
one-off `verify --task` diagnostic records no wave-keyed pass receipts, and
without gate receipts a gate reference is never evidence there. None of this
claims the model received every file or the complete diff: the verifier input
stays the diff stat + changed-file list + gate outcomes, and a line reference is
review evidence, labeled as such.

### Optional Jev shadow verifier assessment

`[gates] jevVerifierShadow` defaults to `false`. Setting it to `true` opts both
wave verification and one-off `verify --task <id>` into a separate TypeSafe
System One assessment using `TYPESAFE_API_KEY` from the environment (never from
config). With no key, no Jev client is constructed or called.

The assessment filters and bounds the task, acceptance criteria, diff summary,
changed-file list, a diff excerpt, deterministic gate summary, and existing
verifier observations into one shared state. It asks three independent Noul
questions per criterion—evidence sufficiency, satisfaction, and concrete
violation—in one batched request. Code applies conservative 0.85/0.15 bands and
requires sufficient evidence plus non-conflicting answers before reporting
`supports-approval` or `supports-rejection`; uncertainty and conflicts stay
`unknown`.

Successful calls write `.orch/verifier-assessment.json` with model, evidence
fingerprint, typed probabilities, thresholds, token usage, and per-criterion
aggregation. Raw diff text and credentials are not persisted. Reading the file
against a different evidence fingerprint marks every conclusion stale/unknown.
Missing credentials, malformed answers, network errors, and low-confidence
answers never change the primary/skeptic verdict, gate result, task transition,
retry, quarantine, delivery, or wave-log schema. Jev generates no commands and
executes nothing. Enabling the setting explicitly consents to sending the
bounded evidence to TypeSafe; the existing primary/skeptic verifier path remains
the only authority.

### Optional Jev shadow failure triage

`[gates] jevFailureTriageShadow` is a separate opt-in, also defaulting to
`false`. It assesses only existing wave failures: each deterministic gate
failure, and each final verifier `reject`/`needs_human` result. It runs after
the existing failure feedback or quarantine decision has committed and never
runs for zero-progress breaker events, successful gates, or approvals.

One batched request asks four narrow questions per failure: evidence
sufficiency, a typed cause category, whether explicit evidence supports
implementation/check-configuration feedback, and whether it supports human
review. Evidence is bounded and secret-filtered task metadata, changed-file
names, failing gate output, and verifier observations; no patch text is sent.
Code applies conservative 0.85/0.15 Noul and 0.85 Choice thresholds, rejects
conflicting answers, and owns all aggregation. Enabling the setting consents to
sending that filtered failure evidence to TypeSafe using `TYPESAFE_API_KEY`.

Successful calls write `.orch/failure-triage-assessment.json`, separately from
verifier provenance, with source, task/wave, model, evidence fingerprint, typed
answers, thresholds, token usage, and advisory outcomes. Raw gate/verifier
text, patches, and credentials are not persisted. Uncertainty, conflicts,
stale evidence, missing credentials, malformed responses, and network errors
remain `unknown`; only completed calls persist, and stale reads invalidate all
conclusions. No outcome changes gate feedback, verifier routing, retry limits,
quarantine, task/adoption state, delivery, human approvals, or commands.

Docs: [`docs/concepts.md`](docs/concepts.md) (roles, stages, governor) ·
[`docs/api-map.md`](docs/api-map.md) (pi-durable/pi-ai export map) ·
[`docs/project-contract.md`](docs/project-contract.md) (what `init` writes, upgrades).

## Pinned dependencies (recorded 2026-11-05, npm dist-tags latest at build time)

| Package | Version | Reason |
| --- | --- | --- |
| `@earendil-works/pi-durable` | 1.5.0 | durable agent harness (storage, conversations, tasks, docs, hooks, tools) |
| `@earendil-works/pi-ai` | 1.5.0 | provider/model access + faux provider for tests |
| `@earendil-works/chord` | 1.5.0 | Context/context primitives under pi-durable |
| `@earendil-works/pi-schema` | 1.5.0 | (transitive) tool argument schemas |
| `@typesafe-ai/sdk` | 0.7.0 | Provider-neutral judgment seam's TypeSafe System One adapter for opt-in shadow assessments |
| `smol-toml` | 1.9.1 | config + recipes parsing |
| dev: `typescript@5.9.3`, `tsx@4.23.15`, `vitest@5.1.0`, `@types/node@26.6.6` | exact | build/dev/tests |

Upgrading pi-durable: the API changes between releases — read
[`docs/api-map.md`](docs/api-map.md) first; `PD_VERSION` + config `[engine] piDurable`
assert the installed version at boot and fail fast otherwise.

## Tests

```bash
npm test        # vitest: fake-clock durability + e2e smoke on the fixture + guard/breaker suite
npm run build   # tsc → dist/cli.js (the bin)
```

`examples/demo-prd` is the fixture repo (mini PRD, three toy tasks) that the
e2e smoke, the demo-behavior tests and the UI demo mode bake share; the
`--with-demo` scaffold writes a placeholder PRD describing it, never a baked
project, and the generic scaffolds install no active demo gates. Do **not**
publish (`private: true`).

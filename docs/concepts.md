# concepts

The vocabulary of the implementation loop kit, and how the pieces map onto the
durable harness.

## Roles

| role | conversation | tools | model source | purpose |
| --- | --- | --- | --- | --- |
| planner | ONE per plan (`kit-plan-v1` request id) | `[read]` only | `roles.planner` | PRD → RouterDoc tasks (id/spec/dependsOn/acceptance/targetPaths) |
| implementer | ONE per task (`task-<id>`, resumed across waves) | read, write, edit, bash | `roles.implementer` | one wave = one task; PROMPT.md discipline attached |
| verifier | fresh per verdict | `[read]` only (+ beforeTool guard) | `roles.verifier` | strict-JSON verdict `approve`/`reject`/`needs_human` |

Boundary hook (`kit-boundaries` extension, installed once, enforced everywhere):

- implementer: `write`/`edit` against `.orch/**`, `evals/**`, `router.md`,
  `PROMPT.md` is BLOCKED; with a non-empty `targetPaths` (per task, mirrored into
  the durable `loop.guard` doc) anything outside those paths is BLOCKED.
- planner/verifier: any non-read tool is BLOCKED (belt & suspenders over the
  `[read]`-only tool selection).

## Stages

- **plan** — one planner conversation parses the PRD into tasks; the engine
  validates the DAG (unknown deps, cycles → plain-words errors), commits
  RouterDoc (`phase: "planned"`) + `router.md` mirror + wave-log row, and stops.
- **wave** — the driver picks the next `todo` task whose `dependsOn` are all
  `done` (topological; priority then id), captures the git working tree as
  `baselineTreeSha` (temp-index snapshot in `.orch/`, never touching the user's
  index), and submits one wave input (`requestId: "<task>-w<N>"`, idempotent).
- **gate** — deterministic checks run as plain code phases (simpler diagnostics
  than an `afterRun` hook; both are viable, see api-map): scope check first
  (diff-vs-baseline file set minus engine-owned paths), then recipes from
  `evals/recipes.toml` (argv-simple commands, timeout, optional stdout `match`
  regexes, `on` path fast-skip). Failures become compact feedback text and a
  `lastGateHash` for the breaker.
- **verify** — one read-only verifier conversation per verdict, fed spec +
  criteria + per-file diff summary vs the task baseline + gate results.
- **deliver** — off by default (`delivery.mode = "none"`): waves stay in the
  working tree, isolated by each task's baseline. `commit` mode commits once per
  approved task; `pr` mode branches, commits, `gh pr create --fill`, and returns
  to the previous branch (requires `--deliver`).

## The governor (budgets + breakers)

All decisions append to `.orch/wave-log.jsonl` with a `reason`.

- **Session ceiling** (`budgets.sessionUsd`): cumulative spend from
  `harness.usage()` — provider/catalog `Usage.cost.total` when reported, else
  `tokens × roles.*.costPerMillion*` rates. On breach the loop ends gracefully
  (`resumable`; CLI prints the resume hint).
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

When a task is quarantined, the wave's diff against `baselineTreeSha` is saved
to `.orch/artifacts/quarantined-<task>-w<N>.patch`, then `git read-tree` +
`checkout-index` + `git clean -fd -e .orch` restore the working tree exactly to
the baseline (engine runtime under `.orch/` is preserved). Subsequent
independent tasks run against a clean tree.

## Why side-cars

pi-durable's SQLite is local-only and single-owner (§ one-process rule), so
`status --follow` in another process reads the ATOMIC `.orch/status.json`
side-car, and the git-tracked paper trail is `router.md` + `.orch/wave-log.jsonl`
(+ gate artifacts). Storage stays the durable truth; side-cars are best-effort
mirrors re-rendered after every state commit.

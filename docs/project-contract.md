# project-contract

What `<kit> init` writes in a target project, and how versions move.

## Files created (idempotent, never clobbered)

| file | purpose | engine-owned? |
| --- | --- | --- |
| `PROMPT.md` | per-wave discipline appended into each implementer wave input | template (user-editable) |
| `evals/checklist.md` | human-editable acceptance-criteria template aligned with the RouterDoc schema | template (user-editable) |
| `evals/recipes.toml` | gate recipes — COMMENTED defaults per language; empty = scope-check-only | template (user-editable; hot-read every gate run) |
| `router.md` | human-readable MIRROR of RouterDoc; engine rewrites it on every router commit | engine |
| `.orch/config.toml` | annotated project config (roles, budgets, gates, delivery, paths) | config |
| `.orch/kit-version` | provenance line: `kit=<kit> pi-durable=<pinned>` | engine |
| `docs/prd.md` | placeholder when `--with-demo`, otherwise absent (user brings the PRD) | user |
| `.gitignore` | appends `.orch/durable.sqlite*`, `.orch/lock`, `.orch/status.json`, `.orch/pending-handoff.json`, `.orch/artifacts/` (only missing lines) | appended |

Side-cars at runtime (git-ignored, local-only): `.orch/durable.sqlite*` (durable
storage, WAL), `.orch/lock` (PID lock), `.orch/status.json` (atomic status
panel payload), `.orch/pending-handoff.json` (queued user note), and
`.orch/artifacts/*` (gate logs, quarantine patches, exports).

## config.toml fields (all defaulted, all commented in the template)

- `[engine]` — `piDurable` (pinned release, asserted against the installed
  package at boot), `maxTurns` (tool rounds per run, default 50), `retryLimit`
  (waves per task before quarantine, default 3)
- `[roles.planner|implementer|verifier]` — `provider`, `modelId`,
  optional `thinkingLevel`, `costPerMillionInput`, `costPerMillionOutput`
  (USD rate fallback for budget math when providers/catalog don't report cost)
- `[budgets]` — `sessionUsd` (hard ceiling), `waveUsdWarn`, `maxConsecutiveErrors`, `maxSleepCycles`
- `[gates]` — `timeoutSec` (per recipe), `enforceTargetPaths` (scope check + guard)
- `[delivery]` — `mode`: `none` (default) | `commit` | `pr` (pr additionally requires the run's `--deliver` flag)
- `[paths]` — `prd` (default `docs/prd.md`), `specs`

NO SECRETS live in config.toml: providers read credentials from the
environment, exactly as pi-ai expects (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`).

Idempotency: `init` writes a file only when it is absent or empty; when a
user-edited file exists it is LEFT UNTOUCHED and reported under
"kept existing (not clobbered)". `.gitignore` lines append only when missing.
Running `init` twice is safe and prints the second result.

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
- Wave-log rows are append-only JSON; old rows stay readable forever.
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
├── wave-log.jsonl       # JSONL mirror of WaveLogDoc (git-tracked? NO — engine-owned, ignored)
├── pending-handoff.json # queued handoff note (handoff command)
└── artifacts/           # gate logs, quarantine patches, exports

router.md                # git-tracked RouterDoc mirror (paper trail)
PROMPT.md, evals/, docs/prd.md
```

> Note on `.orch/wave-log.jsonl`: the research brief calls for a git-tracked
> paper trail; the default `.gitignore` ignore includes the file because it
> mirrors durable storage 1:1. Teams that want it committed can remove that
> line from `.gitignore` — the engine re-renders it after every commit and
> merge-free add-only content is safe.

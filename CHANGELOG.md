# changelog

Manual semver discipline: keep `package.json` version and the newest section in sync.

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

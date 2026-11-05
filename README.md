# llm-toolkit-001 — durable agent implementation loop

A maintained TypeScript **agent implementation loop template**: point it at a PRD,
review one plan, and let a budget-governed `pi-durable` agent harness turn the
plan into merged code — implementer waves → deterministic gates → read-only
verifier → done/quarantine, with a git-tracked paper trail at every step.

- Runtime: [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable) **1.5.0** (pinned exact) on Node ≥ 22.19 (Node 24 LTS preferred).
- One provider/model per ROLE (planner / implementer / verifier) from project config — subscription-budgeted, sequential v1, no parallel agent fan-out.
- Durable SQLite storage is **local-only and git-ignored**; the committed paper
  trail is markdown/JSONL side-cars: `router.md`, `.orch/wave-log.jsonl`, gate
  artifacts, verifier verdicts, run summaries.
- Gates (recipes), a read-only verifier conversation, and a budget governor
  (session USD ceiling, zero-progress/duplicate-failure breakers,
  rate-limit durable sleep with exit 42) are built in.

## 5-minute quickstart

```bash
# 1. scaffold a project (idempotent; never clobbers your edits)
npx llm-toolkit-001 init . --with-demo     # in the repo root of your project

# 2. declare roles in .orch/config.toml
#    planner/implementer on your主力 model, verifier on a cheaper one:
#    provider+modelId per role; credentials come from env (ANTHROPIC_API_KEY etc.)

# 3. write the PRD at docs/prd.md, then run one planning conversation
llm-toolkit-001 plan --prd docs/prd.md     # writes RouterDoc + router.md, stops

# 4. REVIEW router.md. approve, then watch the waves:
llm-toolkit-001 run --approve              # 0 done · 42 sleeping · 1 busy/error
llm-toolkit-001 status --follow            # live panel (reads .orch/status.json)

# 5. paper trail: router.md (mirror), .orch/wave-log.jsonl (rows),
#    .orch/artifacts/*.log (gate output), export HTML/JSON anytime:
llm-toolkit-001 export

# extras
llm-toolkit-001 handoff "context for the next wave"
llm-toolkit-001 verify --task some-task-id  # one-off read-only verification
```

### Scripted smoke, no API keys (proven against examples/demo-prd)

`KIT_FAUX=1` runs every conversation on an in-package faux provider
(`kit-planner` / `kit-impl` / `kit-verifier` model ids). `examples/demo-prd`
ships the replay + gate script for the full plan→wave→gate→verify arc (task 2
fails its gate on wave 1, the driver resets the conversation, wave 2 fixes it):

```bash
cp -r examples/demo-prd /tmp/demo && cd /tmp/demo
npm i <the kit repo>            # or install the kit globally / via npx

llm-toolkit-001 init . --with-demo
# point [roles.*] at provider "faux" + modelId kit-planner|kit-impl|kit-verifier
#   (or KIT_FAUX=1 keeps probe-vs-credentials decoupled from real providers)
# evals/recipes.toml: [broken-gate]\ncmd = "node smoke-gate.cjs"

git init -q && git add -A && git commit -qm base   # the loop needs a repo
KIT_FAUX=1 KIT_FAUX_SCRIPT=smoke.replay llm-toolkit-001 plan
KIT_FAUX=1 KIT_FAUX_SCRIPT=smoke.replay llm-toolkit-001 run --approve   # → STATUS: COMPLETE
```

Replay format: `[planner]` / `[implementer]` / `[verifier]` sections with
`---` separated chunks; a chunk is one model request's answer — plain text
(final assistant turn), the planner's tasks JSON, a verifier verdict JSON, or
`{"tool":"write","path":"src/x.ts","content":"…"}` for a tool round.

## Commands

| Command | What it does |
| --- | --- |
| `init . [--with-demo]` | scaffold §5 files; idempotent; prints what it skipped |
| `plan [--prd path]` | PRD → RouterDoc + router.md; STOP for human approval |
| `run [--approve] [--tasks id…] [--deliver]` | the sequential wave cycle (resumable) |
| `status [--follow]` | task graph + budgets from `.orch/status.json` (when a run is locked) or storage |
| `verify --task id` | one-off read-only verification incl. your manual edits |
| `export` | per-project JSON+HTML report from storage into `.orch/artifacts/` |
| `handoff "note"` | queue a note the driver ingests at the start of the next wave |

Exit codes: `0` done · `42` sleeping (rate-limit durable sleep armed — rerun `run`) · `1` error or lock busy.

## The cycle

```
PRD →[plan, one conversation, read-only]→ RouterDoc + router.md (planned)
      │ human approval (--approve / humanApprovedAt)             ← review point
      ▼ [run]
  per task (topological, priority, id tie-break):
    baseline tree capture → implementer wave (conversation per task)
      → gates (scope check + recipes) → verifier (read-only, strict JSON verdict)
      → approve ⇒ done, or feedback ⇒ next wave (context reset between waves)
      → exhausted/blocked ⇒ quarantine: patch saved, tree rolled back to baseline
  budgets/breakers: session USD ceiling, wave warn, zero-change quarantine,
  duplicate gate-failure hash, consecutive-error cap, rate-limit durable sleep.
delivery: none (default) | commit | pr (needs --deliver)
```

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
| `smol-toml` | 1.4.0 | config + recipes parsing |
| dev: `typescript@5.9.3`, `tsx`, `vitest`, `@types/node`, `smol-toml` | exact | build/dev/tests |

Upgrading pi-durable: the API changes between releases — read
[`docs/api-map.md`](docs/api-map.md) first; `PD_VERSION` + config `[engine] piDurable`
assert the installed version at boot and fail fast otherwise.

## Tests

```bash
npm test        # vitest: fake-clock durability + e2e smoke on the fixture + guard/breaker suite
npm run build   # tsc → dist/cli.js (the bin)
```

`examples/demo-prd` is the fixture repo (mini PRD, three toy tasks) that the
e2e smoke and the `--with-demo` scaffold share. Do **not** publish (`private: true`).

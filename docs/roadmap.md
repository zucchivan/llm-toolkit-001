# roadmap

Single place to record future improvements for llm-toolkit-001 — the durable
agent implementation loop (CLI under `src/`, docs under `docs/`) and its web
UI sub-product (`ui/`).

Ground rules:

- Record only improvements that have been surfaced. Never invent items to fill
  a section; a section with nothing recorded stays an empty stub.
- `status` is `idea` (surfaced, not committed to) or `planned` (accepted for
  work). Move an item to `planned` only when its scope is agreed.
- `area` is `core` or `ui`. A `ui` item must note whether it falls inside
  `ui/PRD.md` scope or beyond it: core changes for the UI are limited to the
  additive seam in `ui/PRD.md` Appendix A (`readout.seam = 1`), and anything
  beyond that seam requires a `ui/PRD.md` amendment before implementation.
- The UI invokes the CLI; it never reimplements the wave driver, gates,
  verifier, governor, or delivery (see `AGENTS.md`).

Item format (append with the next free number, continuing across sections):

```markdown
### N. Title

- **status:** idea | planned
- **area:** core | ui
- **description:** what is wrong today, and the required outcome.
- **rationale:** why it matters (the impact if left unfixed).
```

## Core

### 1. Privilege separation between orchestrator and untrusted execution

- **status:** idea
- **area:** core
- **description:** The orchestrator process shares the same host OS privilege
  boundary, filesystem access, and environment variables as the implementer
  agent's shell commands and project gate executions. Path restrictions
  enforced at the tool-hook layer only guard structured file tools and can be
  bypassed by arbitrary shell commands, which can also read host secrets
  (provider API keys, judgment keys, SSH/GitHub tokens) and modify
  orchestrator-owned state (`.orch/`, `evals/`, `docs/prd.md`, `PROMPT.md`,
  `router.md`). Required: a clear privilege boundary separating the trusted
  host orchestrator (durable state, model API calls, credentials, git
  delivery) from untrusted execution (agent shell commands and project-defined
  gate commands), with OS-level filesystem, environment, and network
  containment; protected project/orchestrator paths unreachable or read-only;
  zero host credentials exposed by default; symlink-escape protection on any
  host-side file tools; and an explicit fail-closed policy when containment is
  unavailable on the host OS.
- **rationale:** Behavioral guardrails are conflated with security isolation.
  A confused or prompt-injected agent can corrupt durable state, tamper with
  acceptance gates, exfiltrate credentials, or modify files outside the
  repository.

### 2. Process identity & lock compatibility across sandboxes and platforms

- **status:** idea
- **area:** core
- **description:** Single-owner storage locking and UI-to-CLI attached-process
  interruption rely on raw host PIDs recorded in side-car files and
  Linux-specific `/proc` inspection. If the orchestrator runs inside a PID
  namespace (container or OS sandbox), recorded PIDs are invalid on the host,
  causing false stale-lock recovery or misdirected signals; on macOS and
  Windows, attached-process stopping fails outright because `/proc` does not
  exist. Required: lock ownership and attached-run verification that are
  portable across operating systems and resilient to PID-namespace isolation,
  without loosening the guarantee that an observer never signals an unverified
  or unrelated process. (Overlaps the "macOS variant B" attached-stop extra
  deferred in `ui/PRD.md` §18.)
- **rationale:** Operators on non-Linux systems cannot safely stop
  terminal-started runs from the UI, and containerized/sandboxed CLI runs
  break lock and observer coordination.

### 3. Workspace isolation per task (decoupling DAG planning from a single working tree)

- **status:** idea
- **area:** core
- **description:** The planner and durable router model tasks as a directed
  acyclic graph with explicit dependencies, priorities, and target paths, yet
  execution mutates a single shared git working tree serially, using tree-SHA
  snapshots for diffing and rollback. Required: isolate each task's execution
  in its own clean, ephemeral workspace derived from a known base revision so
  verification, rollback, quarantine, and eventual parallel execution of
  independent DAG branches occur without mutating the operator's primary
  checkout.
- **rationale:** Independent tasks cannot execute concurrently; active runs
  interfere with the operator's local working tree; uncommitted human changes
  risk collision or rollback loss; recovery from failed waves is tightly
  coupled to mutable working-tree state.

### 4. Scoped delivery staging & orchestrator state hygiene

- **status:** idea
- **area:** core
- **description:** Automated git delivery (`commit` and `pr` modes) stages all
  changes across the repository indiscriminately, while default ignore rules
  omit several runtime and semi-generated orchestrator files (wave logs, gate
  decisions, remediations, shadow provenance files, UI job records,
  auto-generated gate recipes). Required: delivery must stage only verified,
  in-scope changes attributable to the completed task, and repository
  initialization/hygiene must ensure all engine-owned runtime artifacts are
  strictly excluded from version control unless explicitly human-authored.
- **rationale:** Internal orchestration telemetry, local UI metadata, and
  shadow evaluation artifacts leak into user commits and pull requests,
  polluting repository history and failing repository checks.

### 5. Non-destructive shadow provenance & consolidated judgment pipeline

- **status:** idea
- **area:** core
- **description:** Shadow-mode semantic evaluation logic (evidence filtering,
  probability thresholding, contradiction detection, staleness
  fingerprinting, fail-open error handling) is duplicated across three
  separate subsystems (gate adoption, verification, and failure triage).
  Verifier and failure-triage shadow assessments write to single fixed file
  paths per repository (`.orch/verifier-assessment.json`,
  `.orch/failure-triage-assessment.json`), overwriting prior records on every
  subsequent wave or task, and shadow outcomes are invisible in inspection and
  UI views. Required: unify the probabilistic judgment evaluation machinery
  behind a single reusable policy/provenance subsystem; store assessments
  durably without overwriting prior waves or tasks (keyed by task, wave, and
  stage, or stored append-only); surface shadow agreement/disagreement metrics
  in inspection outputs while keeping them strictly non-authoritative.
- **rationale:** Multi-wave and multi-task runs destroy historical shadow data
  before it can be analyzed, defeating the purpose of running shadow
  evaluations to measure calibration and agreement against deterministic
  gates and human/LLM verifiers; maintaining three copies of the same
  statistical policy risks drift.

### 6. Safe, unambiguous command representation for gates and probes

- **status:** idea
- **area:** core
- **description:** Gate probing and execution split command strings on
  whitespace rather than parsing argument boundaries or accepting structured
  argument vectors (recipes today are argv-simple `cmd` strings). Required:
  support structured, unambiguous command argument definitions — without
  reintroducing shell-injection risks — so arguments containing whitespace or
  special characters execute faithfully and deterministically across gates and
  baseline probes.
- **rationale:** Valid project gate commands containing quoted arguments,
  flags with spaces, file paths with spaces, or inline expressions fail or
  execute with corrupted arguments, undermining reliability on real-world
  repositories.

### 7. Eliminating observer blindness during active runs

- **status:** idea
- **area:** core
- **description:** Because durable storage uses a strict single-owner
  exclusive lock, inspection commands and the web UI drop into degraded
  side-car mode whenever a run is active; in degraded mode, full task
  specifications, acceptance criteria, dependency graphs, and conversation
  visibility disappear until the run exits. Required: preserve safe read
  visibility into task definitions, active plan structure, and conversation
  progress/metadata during live runs without violating single-writer
  transactional integrity on durable storage.
- **rationale:** The exact moment an operator most needs detailed visibility —
  while an autonomous run is executing, retrying, or failing — is when the
  control plane becomes least informative.

### 8. Ecosystem-agnostic project discovery & gate adoption

- **status:** idea
- **area:** core
- **description:** The core execution loop, task graph, deterministic gates,
  and verification pipeline are language- and stack-agnostic, but project
  discovery and gap analysis are hardcoded to JavaScript/TypeScript
  conventions (package manifests, JS lockfiles, and JS test/build tooling).
  Required: separate generic gap/consent/fingerprinting workflows from
  ecosystem-specific project detectors so additional languages and build
  systems (Python, Go, Rust, polyglot monorepos) can be supported cleanly
  without entangling core adoption state management.
- **rationale:** Non-JS repositories get no meaningful gate discovery, CI
  parity checks, or adoption workflow, creating an inconsistent user
  experience between onboarding and execution.

### 9. Standardized telemetry & external tool interoperability

- **status:** idea
- **area:** core
- **description:** Execution spans, wave lifecycles, tool calls, gate results,
  and usage metrics are recorded only in proprietary local formats, and agent
  tooling is limited to a fixed built-in coding toolset. Required: optional,
  non-blocking export of structured lifecycle traces/metrics to standard
  observability formats, and a controlled extension boundary for external
  tools that respects the same permission, budget, and audit invariants as
  built-in tools.
- **rationale:** Integrating the loop into existing engineering observability
  stacks (cost dashboards, trace viewers, alerting pipelines) or connecting
  domain-specific external tools requires bespoke glue code.

## UI

### 10. Formalized contract boundary between core engine and web UI

- **status:** idea
- **area:** ui (core/UI seam)
- **description:** The web UI is documented as a separate sub-product with its
  own lifecycle and dependencies, yet its server and frontend directly import
  internal TypeScript source modules from the core engine across package
  boundaries. `ui/PRD.md` Appendix A.5 already states the rule ("the UI server
  never imports kit.ts"), but the boundary holds by convention rather than
  through an enforced interface. Required: expose an explicit, versioned,
  minimal read/type contract from the core package that the UI consumes
  exclusively, ensuring internal engine structure can evolve independently
  without breaking UI builds or runtime behavior.
- **rationale:** Internal refactors in the core engine silently break the UI;
  the claimed architectural seam exists by convention rather than an enforced
  interface boundary.
- **scope:** Beyond the currently defined seam. `ui/PRD.md` Appendix A
  (`readout.seam = 1`) defines specific additive surfaces (A.1–A.7), not a
  package-export contract; formalizing one is a core change for the UI outside
  today's seam, so it requires a `ui/PRD.md` amendment (a new Appendix A
  entry, the way A.5–A.7 were added) before implementation. The no-import rule
  itself is already PRD policy — the new part is enforcement and versioned
  types.

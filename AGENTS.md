# AGENTS.md

## Repository shape

`llm-toolkit-001` is a durable agent implementation loop (CLI under `src/`,
docs under `docs/`). The web UI is a **sub-product** under `ui/` with its own
PRD (`ui/PRD.md`), package, lockfile, tests, version, and CHANGELOG.

Keep the boundary: UI work follows `ui/PRD.md`; core changes for the UI are
limited to the additive seam in `ui/PRD.md` Appendix A. Do not fold UI scope
into the loop kit's scope.

## Standing rule: end every task with the next prompt

Every agent session — and every subagent/delegate — must end its final message
with a paste-ready prompt for the next session. This applies even when the task
is a one-line fix, incomplete, or blocked.

Use this exact heading and a fenced block:

```text
NEXT PROMPT:
```text
...
```
```

The prompt must be self-contained and assume a fresh context with no memory of
this session. It must include:

- the goal and current state (what shipped, where it lives);
- files to read first (repo-relative or absolute paths);
- the next task's scope, with explicit non-goals;
- verification/acceptance commands;
- constraints and decisions that must not be undone;
- the same "end with NEXT PROMPT" instruction, recursively.

Subagents return their own `NEXT PROMPT` to the orchestrator. The orchestrator
folds them into one consolidated prompt (or one per parallel stream) and ends
with the single next prompt. A vague "continue" is not a valid next prompt.

If nothing remains, say so and provide a final verification prompt instead.

## Working defaults

- Do not commit unless the task asks for it.
- Do not revert uncommitted changes you did not create; inspect `git status`
  first and build on top.
- Keep the CLI as the engine/automation interface; the UI invokes it, never
  reimplements the wave driver, gates, verifier, governor, or delivery.
- The core's dependency footprint stays unchanged unless the PRD's seam
  explicitly requires it; UI dependencies live in `ui/package.json`.
- For UI work, read `ui/PRD.md` before planning, and update `ui/CHANGELOG.md`
  for shipped milestones.

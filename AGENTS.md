# AGENTS.md

## Repository shape

`llm-toolkit-001` is a durable agent implementation loop (CLI under `src/`,
docs under `docs/`). The web UI is a **sub-product** under `ui/` with its own
PRD (`ui/PRD.md`), package, lockfile, tests, version, and CHANGELOG.

Keep the boundary: UI work follows `ui/PRD.md`; core changes for the UI are
limited to the additive seam in `ui/PRD.md` Appendix A. Do not fold UI scope
into the loop kit's scope.

## Optional session handoff

Use `$next-prompt` only when the user explicitly requests a paste-ready prompt
for a fresh session. See [the skill](.agents/skills/next-prompt/SKILL.md).

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

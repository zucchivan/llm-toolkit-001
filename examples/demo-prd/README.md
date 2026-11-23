# demo-prd fixture
Tiny toy repo used by the smoke tests, by `init --with-demo` (as a placeholder
description only) and by the UI's demo mode:

- PRD with 3 tasks: `src/list.ts`, a case-insensitive query filter, and a CLI
  entry.
- Task 2's scripted model output ships a CASE-SENSITIVE `queryList` on wave 1;
  the behavioral gate rejects it, the driver resets the conversation, and
  wave 2 repairs it from the gate feedback (a retry proven by behavior — there
  is no BROKEN token to grep for).
- `evals/recipes.toml` is the fixture's ONE recipe file: three named gates
  (`gate-list`, `gate-query`, `gate-cli`) invoking `evals/smoke-gate.cjs` with
  literal argv subcommands `list|query|cli`.
- `smoke-gate.cjs` (top level) holds the REVIEWED gate bytes; demo setup copies
  them to `evals/smoke-gate.cjs` for execution — `evals/` is a protected review
  control, so the executed assertion is not task-writable. The UI demo bake and
  the test builders perform that copy; a manual `cp -r` of this fixture needs
  the one extra line: `cp smoke-gate.cjs evals/`.
- After the run, inspect the accepted result separately; the operator checkout
  is unchanged. Use `git worktree add --detach /tmp/demo-result
  refs/kit/<planRevision>/accepted`, then run
  `node bin/render.js '/a/-b'` from `/tmp/demo-result` → exit 0, stdout exactly
  `a b`. Requires Node ≥ 23.6: the product's `src/*.ts` modules run through
  Node's default TypeScript type-stripping.
- `smoke-slow.replay` keeps its 6s delay for attach/stop tests.

# demo-prd fixture
Tiny toy repo used by the smoke tests and by `init --with-demo`:

- PRD with 3 tasks: `src/list.ts`, filter query, and a CLI entry.
- Task 2's scripted model output fails its gate on wave 1 and passes on wave 2
  (drives the `conversation.reset()` / feedback path of the wave driver).

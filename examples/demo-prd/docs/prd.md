# PRD — toy list utilities

Build a small, dependency-free list module for the demo project.

## Why
The implementation-loop kit needs a tiny, real repo to run plan→wave→gate→verify
against — and the gates must be able to FAIL: the demo is falsifiable at runtime.

## Features
1) `parseList()` — turn "/foo/bar baz,-qux" into ["foo","bar baz","qux"]; ONE
   leading dash on a token is stripped and the token is kept
   (parseList('/a/-b') is ['a','b'], not ['a']). Plus `renderList()` (join
   with spaces).
2) `queryList()` — case-insensitive substring filter (its FIRST scripted wave
   ships a case-sensitive filter that the behavioral gate rejects; the second
   wave repairs it from the gate feedback).
3) `bin/render.js` — read a text arg, print the rendered list:
   `node bin/render.js '/a/-b'` prints exactly `a b` (exit 0).

## Gates (reviewed controls, not task output)
`evals/recipes.toml` (this fixture's ONE recipe file) wires three behavioral
gates to `evals/smoke-gate.cjs` (copied from this fixture's top level at demo
setup): `gate-list` always executes the parser + renderer, `gate-query` runs on
`src/query.ts`/`bin/` and requires an actual case-insensitive result, and
`gate-cli` runs on `bin/`, executing the real CLI and expecting exit 0 with
stdout `a b`. The assertions run code; they never grep file contents.

## Boundaries
- Node-only, ESM, no deps. Keep everything under src/ and bin/.

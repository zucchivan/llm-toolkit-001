# PRD — toy list utilities

Build a small, dependency-free list module for the demo project.

## Why
The implementation-loop kit needs a tiny, real repo to run plan→wave→gate→verify against.

## Features
1) `parseList()` — turn "/foo/bar baz,-qux" into ["foo","bar baz","qux"], plus `renderList()`.
2) `queryList()` — case-insensitive substring filter (its FIRST wave is scripted to break; the second wave fixes using feedback).
3) `bin/render.js` — read a text arg, print the rendered list.

## Boundaries
- Node-only, ESM, no deps. Keep everything under src/ and bin/.

# Acceptance criteria checklist (human-editable; the RouterDoc mirrors the graph)

For each task, keep 1–5 EARS-style criteria: "When X, the system shall Y".
The verifier judges from the task diff against its baseline tree; human edits are also verifiable via `verify --task`.

## Criterion evidence references (M0-P11)

An approving verifier pass — primary and skeptic alike — must cite, for every
criterion, at least one valid evidence reference against the CHECKED tree (the
frozen candidate the deterministic gates ran on):

- `{"kind":"line","path":"src/list.ts","line":2}` — an existing 1-based
  physical line in a regular UTF-8 text file of the checked tree;
- `{"kind":"gate","id":"gate-list"}` — a deterministic recipe that actually
  executed, was NOT skipped, and passed on that tree. The scope check alone is
  never criterion evidence, and a skipped or failed check proves nothing.

Example: for the criterion "When parseList is called on '/a/-b', the system
shall return ['a','b']." the reference `{"kind":"line","path":"src/list.ts","line":2}`
is accepted only while that exact line exists on the tree the verifier reviewed;
the same reference on a different tree without the cited evidence fails closed
to `needs_human`. Missing, malformed, duplicated, or unknown criterion ids also
refuse. A well-formed explicit `reject` needs no evidence. Neither reference
proves a requirement universally: a line reference is review evidence, labeled
as such, and a behavioral requirement still needs an executed gate.

This file guides criteria authoring; the planner does not append sections here,
and editing it does not alter an existing RouterDoc. Review the generated
`router.md` mirror, then revise the PRD and rerun `plan` to change the graph.
An implementer's `STATUS: COMPLETE` line is only a report, not acceptance proof.

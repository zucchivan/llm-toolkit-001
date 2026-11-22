# Acceptance criteria checklist (human-editable; the RouterDoc mirrors the graph)

For each task, keep 1–5 EARS-style criteria: "When X, the system shall Y".
The verifier judges from the task diff against its baseline tree; human edits are also verifiable via `verify --task`.

This file guides criteria authoring; the planner does not append sections here,
and editing it does not alter an existing RouterDoc. Review the generated
`router.md` mirror, then revise the PRD and rerun `plan` to change the graph.
An implementer's `STATUS: COMPLETE` line is only a report, not acceptance proof.

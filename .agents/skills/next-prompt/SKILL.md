---
name: next-prompt
description: Write a paste-ready handoff prompt for a fresh session when explicitly requested by the user.
---

Use this skill only when the user explicitly invokes `$next-prompt` or asks for
a paste-ready prompt for a fresh session. Finishing a task or reporting a blocker
does not trigger a handoff.

Assume the next session has no conversation history. End the reply with the
literal heading `NEXT PROMPT:` followed by a single fenced `text` block. Write
the block as instructions to the next agent and include:

- The goal and current state, with what shipped, what is still local, and any
  blockers or open decisions.
- The working location and the files or artifacts to read first. Link existing
  evidence where possible.
- The specific next task and its non-goals. If the work is complete, say so and
  make the prompt a verification-only task.
- Verification commands or acceptance checks, including prerequisites and any
  checks still pending.
- Constraints and decisions that must carry forward.

Consolidate relevant findings from delegates if there are any. Omit secrets and
avoid instructions that require later sessions to generate another handoff.

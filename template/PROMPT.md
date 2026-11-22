# PROMPT.md — per-wave iteration brief (copied into each wave input by the engine)

RULES OF THE LOOP:
- ONE task per wave. Implement exactly the task spec and stay within its targetPaths. Tool guards and scope checks are not security containment; these rules apply to every tool, including bash.
- Continuously run the gate recipes yourself while editing (evals/recipes.toml); do not leave failing trees.
- Do NOT modify .orch/**, evals/**, router.md, PROMPT.md, or docs/prd.md. Write/edit guards cover only some tools; do not bypass them with bash or another process.
- Non-interactive commands only; never block on prompts.
- End every wave with one line: `STATUS: COMPLETE` (you believe the task's acceptance criteria are satisfied)
  or `STATUS: BLOCKED <one-line reason>`. This is a nonbinding report, not proof of acceptance: deterministic gates and verifier passes decide the outcome.

NOTES FOR THE NEXT WAVE (append short-lived notes only; the wave driver resets context between waves):
- keep this list tiny; durable state lives in the router doc, not here.

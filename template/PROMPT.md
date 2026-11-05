# PROMPT.md — per-wave iteration brief (copied into each wave input by the engine)

RULES OF THE LOOP:
- ONE task per wave. Implement exactly the task spec given to you (targetPaths are enforced).
- Continuously run the gate recipes yourself while editing (evals/recipes.toml); do not leave failing trees.
- Do NOT modify .orch/**, evals/**, router.md, PROMPT.md, or docs/prd.md — the harness blocks these paths.
- Non-interactive commands only; never block on prompts.
- End every wave with one line: `STATUS: COMPLETE` (task's acceptance criteria all satisfied)
  or `STATUS: BLOCKED <one-line reason>`.

NOTES FOR THE NEXT WAVE (append short-lived notes only; the wave driver resets context between waves):
- keep this list tiny; durable state lives in the router doc, not here.

# llm-toolkit-001

Give the CLI a requirements document and a Git repository. It breaks the work into tasks, waits for you to approve the plan, then works through it one task at a time. Each accepted change has a Git tree you can inspect and a record of the checks it passed.

In the included demo, the coding model writes a search filter that only matches exact case. The requirement says search should ignore case. A test runs the filter, catches the mistake, and sends the failure back for repair. The next attempt passes.

## Why run one task at a time?

Each task starts from the last accepted change. Even independent tasks wait their turn, so a parallel orchestrator can finish those sooner. The benefit here is a single history you can follow from the plan revision you approved to the exact Git tree each check and review examined. Your checkout stays available throughout the run.

Suppose the process stops after review while opening a pull request. The CLI records acceptance and publication separately. On restart it checks what happened to that PR. If it can confirm the outcome, it can continue. If the outcome is uncertain, it stops for recovery before starting the next task. [Result and recovery contract](docs/project-contract.md#m0-p14-serial-candidate-and-result-contract)

**Use trusted projects only.** Coding tools, gate commands, and baseline probes currently execute on the host. Linux containment using bubblewrap, a Rust launcher, and versioned toolchain bundles is under development. [Local sandbox status](sandbox/local/README.md)

## Choose where to spend your model budget

Each project sets a provider and model for three jobs in `.orch/config.toml`.

| Role | Job |
| --- | --- |
| Planner | Reads the requirements and proposes tasks, dependencies, target paths, and acceptance criteria for you to review. |
| Implementer | Edits files for one approved task. A repair attempt gets feedback from the failed check or review. |
| Verifier | Reviews the candidate against each criterion and cites evidence. By default, a fresh second review challenges a primary approval. Both passes use the configured verifier model. |

**Available today.** For example, you can ask Claude Opus 5.5 to break down the requirements, use GPT-6 Luna for routine coding, and give GPT-6 Sol the independent review. To try that combination, edit the three role tables in `.orch/config.toml` before planning. These are example assignments. Each role uses its configured model across attempts. [Shipped defaults](template/.orch/config.toml)

| Role table | `provider` | `modelId` |
| --- | --- | --- |
| `[roles.planner]` | `anthropic` | `claude-opus-5-5` |
| `[roles.implementer]` | `openai` | `gpt-6-luna` |
| `[roles.verifier]` | `openai` | `gpt-6-sol` |

OpenAI also offers GPT-6.2 Sol (`gpt-6.2-sol`). The kit’s pinned provider catalog (pi-ai 1.5.0) includes GPT-6 Sol and does not yet list 6.2 Sol for the providers wired into the CLI. [OpenAI model details](https://developers.openai.com/api/docs/models/gpt-6.2-sol)

**Planned for M2.** New projects will start routine coding on the cheaper implementer. The proposed policy calls on the planner’s more capable model in the following cases.

- **For a repair**, the previous attempt must have changed the candidate and be eligible for retry. An executed project check must have failed, or the verifier must have rejected a criterion with valid evidence. The stronger model gets the next repair attempt. A provider transport error, repeated failure, or inconclusive verdict alone does not qualify.
- **For review**, either pass uses the stronger model when the task has already needed a gate or verifier repair, has no target paths, or has no passing executable check beyond scope. The same rule applies to binary or unmeasurable changes, changes touching more than three files or exceeding 100 added and deleted lines combined, and edits to designated security, migration, or package-management paths.

The policy keeps the same retry and spending limits. Existing configurations keep their fixed model assignments. M2 calls for an evaluation before routing is activated. [Routing rules](docs/engineering-plan/README.md#section-3-data-model-config-schema--seam-changes) · [Evaluation and rollout](docs/engineering-plan/M2.md)

## Try the demo without API keys

From the kit checkout, use Node 24 and Git. The CLI supports Node 22.19 and later. The demo itself needs at least 23.6 to run its TypeScript files directly.

```bash
npm ci
npm run build
npm test -- test/m0-release.test.ts
```

The test runs the built CLI against a disposable repository with scripted model replies. It checks the accepted program by invoking `node bin/render.js '/a/-b'` and expecting exactly `a b`. To run the same fixture by hand, follow the offline smoke instructions. [Fixture](examples/demo-prd/README.md) · [Manual walkthrough](docs/project-contract.md#m0-release--migration-checklist-m0-p19)

## Run it on your project

After building the kit, run `npm link` from the kit checkout to put `llm-toolkit-001` on your PATH. Then switch to the trusted Git repository you want to work on.

```bash
llm-toolkit-001 init .
llm-toolkit-001 gates list
```

A **gate** is a check the CLI runs on a proposed change. A new project starts with a scope check. Use `gates list` to see which existing test, build, or lint commands the kit recognizes. For example, it can spot a workspace test script that your root checks miss.

```bash
llm-toolkit-001 gates refresh
llm-toolkit-001 gates probe
```

`refresh` previews the recipes it would write and asks you to approve the changes. Your own recipes belong in `evals/recipes.toml` and take precedence. `probe` asks separately before running the commands, so you can catch a failing baseline before paying for a coding run. [Project adoption](docs/project-contract.md#project-adoption-contract)

Write your requirements in `docs/prd.md`, choose your role models, and supply their credentials through the environment. Commit the project base and reviewed controls you want the run to use, then generate the plan.

```bash
llm-toolkit-001 plan --prd docs/prd.md
```

Read `router.md`. In particular, check whether the acceptance criteria would catch an implementation that looks plausible but behaves incorrectly. To change a task, revise the requirements and run `plan` again. Each plan gets a new revision ID.

```bash
# Replace REVISION with the ID printed by plan.
llm-toolkit-001 run --approve --revision REVISION
```

To approve a subset, add `--tasks TASK_ID` once per task. Include any unfinished dependencies. To resume an existing grant, use a bare `llm-toolkit-001 run`.

## What happens to a change?

The implementer works in a private workspace. At the end of an attempt (a *wave*), the CLI freezes the proposed files into a Git tree. It checks the changed paths, runs the applicable recipes, and gives the verifier the results.

To approve, each review must cover every acceptance criterion and cite a passing executed gate or a line in the candidate. A malformed or inconclusive review requires human attention. Repeated failures and attempts that change nothing can stop the task. [Checks and reviews](docs/concepts.md#stages)

By default, accepted work lives at `refs/kit/REVISION/accepted`. To open it beside your project, substitute the plan revision and choose a fresh directory.

```bash
git worktree add --detach ../kit-result refs/kit/REVISION/accepted
```

Set delivery to `commit` for a named local result branch. Pull-request delivery requires an approved destination and `--deliver` and leaves merging to you. [Result locations](docs/project-contract.md#m0-p14-serial-candidate-and-result-contract) · [PR setup](docs/project-contract.md#pr-publication-m0-p13-activated-by-m0-p14)

## When a run stops

Start with `llm-toolkit-001 inspect --health`. It shows task history, usage, and gate output. During a run, use `llm-toolkit-001 status --follow` in another terminal. For a JSON and HTML report, run `llm-toolkit-001 export`.

| Run exit | What it means |
| --- | --- |
| `0` | The approved selection finished. If you approved a subset, other tasks may still be open. |
| `2` | Work stopped short. Inspect the reason before proceeding. It may be a budget pause, a blocked task, or an operation whose outcome needs recovery. |
| `42` | A rate limit put the task to sleep. Run the CLI again with `run` after the wait. |
| `1` / `130` | Invalid input, a busy lock, or another error / interrupted with Ctrl-C. |

The budget includes planning, coding retries, and both verifier passes. The CLI checks recorded spend before calls and pauses if it cannot price observed usage. A call already in flight can take the final bill above `budgets.sessionUsd`. [Budgets and stopping rules](docs/concepts.md#the-governor-budgets--breakers)

For a quarantined task, `resolve --retry` grants a fresh attempt from the last accepted result. For an inconclusive review, `resolve --accept-tree` lets a human supply evidence for the exact candidate and reruns its gates. Both require the revision, task, and a reason. [Recovery commands and evidence format](docs/project-contract.md#human-resolution-contract-m0-p18)

## More ways to use the kit

- Send context to the next wave with `llm-toolkit-001 handoff "note"`. Inspect a retained candidate with `llm-toolkit-001 verify --task TASK_ID`.
- Follow a run in the browser with the optional local web UI. It has its own installation and release cycle. [Web UI setup](ui/README.md) · [UI requirements](ui/PRD.md)
- Configure gates, optional TypeSafe assessments, and what to keep under `.orch/`. Runtime records are private and ignored by default. [Project contract](docs/project-contract.md) · [Loop concepts](docs/concepts.md)
- For development, run `npm run typecheck`, `npm run build`, and `npm test`. The release checklist also covers the UI suites. [Release checks](docs/project-contract.md#m0-release--migration-checklist-m0-p19) · [Pinned runtime APIs](docs/api-map.md) · [Engineering plan](docs/engineering-plan/README.md)

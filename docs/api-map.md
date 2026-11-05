# api-map

Exact exports of `@earendil-works/pi-durable@1.5.0` /
`@earendil-works/pi-ai@1.5.0` this kit uses, per engine module. Pinned versions:
recorded at build time 2026-11-05 (`npm dist-tags latest`; `durable_readme.md`
in the research bundle describes the same release). Everything pi-durable flows
through `src/engine/kit.ts` (and `harness.ts`, which does the wiring) — no other
module imports the packages.

## src/engine/kit.ts — the import seam

- `Harness` — `Harness.open(storage, options, context)`; `Session`
  (`root/createConversation/conversation/inspect/commit/usage/waitForTask/getTask/…`)
- storage: `openNodeSqliteStorage(file)` (`@earendil-works/pi-durable/storage/sqlite/node`),
  `MemoryStorage` (tests)
- env: `NodeExecutionEnv` (`@earendil-works/pi-durable/env/node`)
- tools: `createReadTool/createWriteTool/createEditTool/createBashTool`,
  `CodingTools` + `createCodingTools` re-exported for reference (`/tools`)
- extension machinery: `createRegistry`, `defineExtension`, `defineTool`,
  `hook`, `section`, `wrapTool` (unused in v1), `runEndTask` (kept for the
  afterRun alternative noted below), `GenerationTask`, `ToolTask`
- documents/entries: `defineDoc`, `defineEntry`, `AssistantEntry`, `ResetEntry`,
  `UserEntry`, `ToolResultEntry`, `SystemEntry`, `CompactionEntry`; `LiveDoc`,
  `UsageDoc`, built-in `LoopGuardDoc` here
- tasks: `defineTask` (`@earendil-works/pi-durable` root), and the task runtime
  shapes `Task<I,S,R,H>` / `TaskRuntime` (`sleepUntil`, `commit`, `now`)
- contexts: `@earendil-works/chord/context` → `BACKGROUND_CONTEXT`,
  `withAbortSignal`

### Why plain code phases instead of hooks (both documented)

- Chosen: gates + verifier run in the wave DRIVER loop as plain code between
  `submitAndAwait` boundaries. Diagnostics are ordinary stack frames, budget
  checks and breakers read fresh state mid-loop, and quarantine/rollback needs
  the git shell anyway.
- Alternative (viable, same APIs): an `afterRun` hook on `GenerationTask`
  (`hook(GenerationTask, { afterRun })` returning `runEndTask(KitGateTask, …)`
  where `KitGateTask` is a `defineTask` of the recipes) runs gates as owned
  child tasks with the durability of the state machine; the trade-off is gate
  diagnostics living in task state rather than driver logs, and abort semantics
  riding on the owner conversation.

## src/engine/harness.ts

- `HarnessOptions`: `models` (`Models` from pi-ai), `registry`, `env` (one
  `NodeExecutionEnv` per use, cwd follows the conversation agent), `settings`
  (`retry {enabled,maxRetries,baseDelayMs}`, `afterFailedRun: "withdraw"`,
  `toolExecution: "parallel"`, `progress`), `onReport` (→ wave-log rows when a
  driver is attached, else the ring buffer surfaced by status/export)
- storage single-owner: `.orch/lock` via `O_EXCL` + live-PID check
  (`src/util/lockfile.ts`) BEFORE any sqlite open; `status --follow` therefore
  reads side-cars, never storage, while a run is live
- `Session.snapshot(token, cx)` reads (`RouterDoc`/`RunStatusDoc`/`WaveLogDoc`),
  `session.commit(async (tx) => …)` writes them (`tx.doc(...)` drafts)
- version assert: `readInstalledPiDurableVersion()` —
  `require("@earendil-works/pi-durable/package.json").version` matched against
  `PD_VERSION` **and** `[engine] piDurable`; mismatch throws with a
  "see docs/api-map.md before upgrading" message
- model wiring: `createModels()` (`@earendil-works/pi-ai/models`) +
  `anthropicProvider()` / `openaiProvider()` / `openrouterProvider()`
  (`@earendil-works/pi-ai/providers/*`) — synced/failing per env credentials as
  pi-ai expects (no secrets from config.toml). Tests use
  `fauxProvider()`/`fauxAssistantMessage`/`fauxToolCall`
  (`@earendil-works/pi-ai/providers/faux`) + `models.setProvider(...)`.
  `KIT_FAUX=1` (tutorial) builds the same faux provider for the CLI.

## src/engine/infos.ts — my own state

- `defineDoc` session-scoped docs: `RouterDoc` (`loop.router`: tasks
  id/title/spec/dependsOn/acceptance/targetPaths/priority/status/waveCount/
  convId/baselineTreeSha/lastGateHash/feedback; phase empty→planned→running→complete),
  `WaveLogDoc` (`loop.wavelog`: append-only rows mirrored to
  `.orch/wave-log.jsonl`), `RunStatusDoc` (`loop.run`: prdPath/prdSha/
  humanApprovedAt/budgetSpentUsd/activeAlert/sleepTaskId/sleepUntil/
  sleepCycleCount/consecutiveErrors/kitVersion)
- every doc value is a JSON-strict `type` literal (pi-durable `JsonObject`
  constraint); `checkpointWhen: () => true` (tiny docs)
- mirrors: `router.md` (renderRouterMd) + `.orch/wave-log.jsonl` (JSONL),
  written atomically AFTER each commit resolves — never inside it

## src/engine/tasks.ts

- `defineTask` — the governor's `kit.sleep` (`SleepTaskInput/state/result`),
  phases `waiting → (sleepUntil) → done`; the registry installs it through the
  `kit-governor` extension at open (`HarnessOptions.registry`)

## src/engine/waves.ts — the driver

- `createConversation({ ownership: {kind:"ownerless"}, agent, init }, ctx)` —
  per-task implementer conversation; `agent.tools` array selects exactly the
  kit tools; `init` writes the conversation-scoped `LoopGuardDoc`
- `Conversation.submit({type:"input", content, requestId})` +
  `submission.wait(ctx)` → `SettledSubmissionRecord` (`done` | unanswered with
  `reason`, reading `LiveDoc.snapshot` for `runFailure.detail`)
- `Conversation.reset(undefined, ctx)` before wave N>1 after a failed wave —
  failed debugging turns stay in storage (auditable) but out of the window
- `harness.commit(async (tx) => tx.createTask(GovernorSleep, …), ctx)` with
  `ownership: {kind:"conversation"}, conversationId` arms the rate-limit sleep
- report intake: `onReport` rows surfaced into wave-log (`task_interrupted`,
  `task_faulted` …)

## src/engine/gates.ts — recipes + scope

- recipes `.orch`-adjacent: `evals/recipes.toml` (smol-toml) — argv-simple
  commands via `util/exec.ts` (spawn, no shell, per-recipe timeout, streams
  captured to `.orch/artifacts/gate-*.log`)
- scope list from `util/git.ts` `treeChanges()` (deterministic: temp-index
  baseline tree vs `git hash-object` of the worktree) — no `git add -N`
  (index stays clean); engine-owned paths exempt

## src/engine/verifier.ts

- conversation with model `roles.verifier`, `[read]` tool only, guard doc
  `role: "verifier"`; STRICT JSON verdict parse — on any deviation the verdict
  degrades to `needs_human`, never silently approves

## src/engine/governor.ts

- budget math over `harness.usage(Session)` — pi-ai `Usage` shapes; cost
  fallback via `roles.*.costPerMillionInput/Output`
- rate-limit detection (`looksLikeRateLimit`) + reset parsing
  (`parseResetDelay`, e.g. "resets in 30m", "retry after", 429 reset fields);
  sleep via `tasks.ts` `kit.sleep`
- sleep resume across restarts: `harness.getTask` + `resume()` +
  `waitForTask` on re-open (timers wake due sleeps while the process lives; the
  injected fake clock covers tests)

## src/engine/delivery.ts

- `git add -A` + `git commit -m "<project>: <task> (wave <n>)"`, or branch +
  `gh pr create --fill` + return to the previous branch — requires the
  `--deliver` flag for `mode = "pr"`

## src/views/*.ts + src/cli.ts

- `status` panel reads `.orch/status.json` (produced by `flushStated` — atomic
  rename) when the lock is held elsewhere, else opens storage briefly under a
  fresh lock; `export` renders report.json/report.html from the session state
- arg parsing: `node:util parseArgs` only (no framework); exit codes 0/42/1

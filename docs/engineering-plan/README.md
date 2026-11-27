# Supervised implementation loop — engineering handoff

Baseline: `cd141b6`. **Proposed work, not shipped behavior.** This is the dispatch specification, not a replacement for `docs/roadmap.md` or a promotion of its ideas. Line numbers refer to that baseline; after a predecessor lands, find the named symbol. No implementation or new dependency is authorized by this document alone. Section 4 is split into five packet sheets so a worker need not ingest the whole backlog.

## Section 0: Challenges, Contradictions & Recommended Cuts

- **Fix authorization before optimizing execution.** `src/engine/waves.ts:99–120` checks a stamp but doesn't write it; `:191–227` selects globally and tests a stale task array. `src/cli.ts:137` invites edits to the overwritten mirror. `ui/src/lib/dialog-requests.ts:65–75` even turns an empty *selected* request into *all*. Bind a positive grant to what the human saw. This requires a small UI PRD amendment **in M0**, not permission inferred from M4.
- **The demo is the first outcome test.** At this baseline the replay can finish three tasks, yet `node bin/render.js '/a/-b'` fails importing `renderList`. The parser also drops `-b` instead of stripping its dash. `test/e2e.smoke.test.ts:39–50,152–159` can pass without executing the CLI it claims to have built. Test that exact invocation; don't replace the deliberately failed/repaired second task with a perfect replay.
- **A display patch is neither an acceptance certificate nor a backup.** `waves.ts:421–448,652–720` sets `done` before delivery and swallows restore errors. `src/util/git.ts:35–60,113–139,234–242` walks ignored files, follows filesystem paths and restores into the real index. `coverage/` can break capture. Don't repair this by adding more skip-directory names. Never clean, stash, check out, or auto-merge in the operator's checkout.
- **Change the meaning of local delivery explicitly.** `none` will leave an inspectable private result, not new files in `.`; `commit` will publish a named **local result branch**, not advance the checked-out branch. `pr` will stack against the previous *published* task branch. One serial accepted lineage is enough. Cut independent branch merging, concurrency, automatic rebase, force pushes and automatic deletion of accepted refs.
- **Pin what was checked.** Reading `evals/` anew half way through checking one candidate is inconsistent with reproducible acceptance. Freeze a base commit and control inputs at plan review. Fresh policy requires re-plan; raising a spend ceiling is not a new plan. No promise that a test written by the candidate, a passing external command, or a model citation proves a requirement universally.
- **M0 workspaces aren't a security release.** Until M1 cuts over, use trusted projects/fixtures only. A no-shell recipe still runs arbitrary project code. `NodeExecutionEnv`, inherited env in `src/util/exec.ts:19–26`, the UI's project-local CLI resolution and Git helpers executed on the host all matter. Do not add an `unsafeHost` switch. Unsupported containment means no execution, not a banner followed by host execution.
- **The single import seam is a repair, not an existing invariant.** Direct imports in `src/engine/harness.ts:16–20`, `infos.ts:16`, `faux-replay.ts:25–29`, package metadata reads in `src/init.ts:78–80` and test fixtures contradict `kit.ts:1–4`. Enforce the seam mechanically. A read-only *caller* of `Harness.open` isn't necessarily a read-only *session*; use the pinned `readOnly` option for observers.
- **Don't sell a billing guarantee or an evaluation result.** A budget is admission against recorded spend, not prevention of an overrun by an in-flight request. A cache hit isn't guaranteed by identical text. Replaying labels measures a policy on those observations, not live-model intelligence. Keep unpriced usage unknown, not `$0`; do not weaken existing skeptic defaults based on faux transcripts.
- **A greenfield directory without a Git commit isn't loop-ready under the new base contract.** Require explicit confirmation for one local seed commit of named scaffold files in a *new* directory. Declining means no scaffold, not a half-ready project. Brownfield `init` still never commits.
- **Limit the menu.** One compiled-in second detector (Go); one greenfield scaffold (dependency-free Node CLI); no detector/plugin marketplace. Select a remote isolation tier but enable it only with independent source-transfer consent and passing deployment conformance. Keep telemetry out of the execution path; use a separate exporter, not a mandatory OTel SDK. Retain Jev as advice, never an escalation/acceptance authority. No universal attached-stop, MCP, parallel task execution or live transcript streaming.

No owner decision blocks writing the DAG. Compatibility breaks, especially review-token checking and the new location of output, are deliberate; do not ship them as transparent bug fixes. Section 5 contains **go/no-go tests**, not alternatives delegated to implementers.

## Section 1: Architecture Decision Records (ADRs)

**01 — Review one immutable plan; authorize one exact scope.** `planRevision` is a fresh UUID even for identical replans. The plan records normalized immutable task definitions, base commit, PRD and control digests. Approval atomically writes `{planRevision, selected, humanApprovedAt}`. New approval requires `run --approve --revision <uuid>`; absent `--tasks` on that command means all IDs; repeat `--tasks <id>` for a subset. Bare `run` resumes exactly the stored grant. Only a changed grant can admit more work. Reject new grants on a missing or altered mirror instead of treating the echoed UUID as a signature on edited text; the stored grant, not the mirror, governs bare resume.
- Reject schema `version`, a PRD-only digest, or a timestamp alone as plan identity: each can survive a different decomposition.
- Reject auto-including missing dependencies and parsing `router.md` back into authority. Reject a stale UI dialog even if all task IDs still exist.

**02 — Prove a verdict about one candidate.** A **Task** is a planned unit; a **Wave** is one numbered implementation attempt. A **Gate** is a deterministic check on a frozen candidate; a **Verdict** is a read-only review of its specified criteria. Each *required* approving pass has exactly one `pass` plus a valid evidence reference for every criterion. Scope alone is not criterion evidence. A gate reference names a unique executed passing recipe in the gate receipt; a line reference names a regular projected UTF-8 text blob and an existing 1-based physical line in the frozen candidate. Recompute neither from the operator's checkout. An implementer's final line is a report, not a vote. `verify --task` remains diagnostic. Only `resolve` can make a binding human decision.
- Reject counting `approve` strings, counting criteria without checking IDs, and letting a skeptic heal a defective primary pass.
- Reject requiring an executable test for every prose criterion: a validated file/line reference is review evidence, labeled as such; the demo's runtime contract specifically requires a behavioral gate.

**03 — Serial immutable integration, recoverable publication.** Start at the reviewed Git HEAD commit. Task A gets a private materialization of the current integration head; failed waves retain edits only there. Freeze candidates as trees, pin objects against GC. Gate and verify the same tree. Integrate the accepted tree by a private commit with the previous integration commit as its single parent. **Accepted** means a durable decision about that tree; **delivered** means a separately verified effect at the configured destination. `done` is a scheduler projection, not either receipt: it requires accepted + known integrated commit + (`none` recorded or requested publication confirmed). Block the queue at an unresolved publication/recovery. B always gets the same bytes regardless of delivery mode. See §3 for crash ordering.
- Reject Git worktrees as a security sandbox, using the dirty operator checkout as input, or treating a capped patch as the deliverable.
- Reject `git add -A`, double-applying A after a PR, and treating PR creation as a merge.

**04 — Three ownership classes, independent of authorship.** Reviewable: project code, PRD, `PROMPT.md`, human and approved generated recipes, checklist, `.orch/config.toml`, `.orch/gate-{decisions,remediations}.json`. Optional local paper trail: `router.md`, `.orch/wave-log.jsonl`, `.orch/kit-version`; ignore by default, human may explicitly retain after review. Private: all other `.orch/` data, including SQLite/WAL/SHM, locks, notes, projections, workspaces, assessments, telemetry, exports, UI jobs. Never auto-stage controls or either trail. **Durable state** in locked storage authorizes transitions; **evidence** (logs, reports, display patches, local projections) explains them; deleting a projection grants nothing.
- Reject a blanket `.orch/` exclusion without reviewable exceptions, and the rule “generated implies private.”
- Reject changing an existing user's index or Git history to enforce hygiene. Warn/refuse unsafe publication; give manual remediation.

**05 — One command runner and explicit admission boundaries.** Canonical literal argv, human recipe wins on name, fail invalid input before spawning, **all** match expressions must match captured stdout. Wave fast-skip (`on`) is not probe selection. Check spend at the start of planning, each wave including retries, each primary and skeptic submission including standalone verification; stop before sending when at or above ceiling. Also guard each kit-visible model dispatch within a verifier submission (read-tool follow-up, durable provider retry and compaction included). Persist pending stage so budget stops don't spend an implementation wave twice. Sleep limit is per task across restarts; handoff is consumed at each implementation-wave boundary.
- Reject shell-like quoting for legacy `cmd` and separate probe/wave parsers.
- Reject pricing the next model turn from its prompt length or calling this a hard upper bound on the provider bill. A transport's hidden HTTP retries are not observable admission points; one admitted request can exceed the balance. Tool turns, compaction and SDK retries are not new implementation waves.

**06 — Sandbox all worker I/O; keep authority on the host.** Ship Linux `bubblewrap` over a pinned, operator-provisioned rootfs as the default **local** adapter. Ship Gondolin as the **microvm** adapter; choose Daytona as the only **remote** adapter. Use the same restricted guest file/exec protocol for all three. A read-only planning/verifying agent gets a read-only execution namespace too. Backends are fixed kit adapters, not project-loadable programs. No initial worker network; preprovision dependencies. Compare candidates in §2.
- Reject wrapping only `bash` with SRT while keeping host read/write/edit or host-side probes. SRT's default read policy and platform-specific exceptions are not the allowlist below.
- Reject placing SQLite, the CLI PID or host credentials inside a VM, and running package install hooks on the host. Reject a new core runtime dependency on a sandbox SDK.

**07 — Align bytes, not conversations.** Deterministic role instructions + reviewed rules and small static context, stable tool definitions in fixed order, followed by task/wave-specific input. Use a fresh ownerless conversation **per new wave/pass**; a restart of the *same* submission reuses its saved ID. Only bounded structured failure feedback and an explicitly addressed handoff cross attempts. Request caching through the pinned library, not injected provider JSON.
- Reject copying a failed conversation, sharing provider session IDs across tasks/projects, and storing a local prompt/prefix cache containing repo text.
- Reject generic “1h everywhere.” Request 1h only for models with proven 3600s support; other models use short/default with explicit effective-policy diagnostics. No fabricated hits or provider breakpoints.

**08 — One usage valuation.** Measure token classes independently. Keep observed SDK totals and provenance separate from estimates, per-submission deltas separate from session totals, and savings against a specified counterfactual. Missing data is nullable. All views and admission use the same valuation.
- Reject treating reads/writes as input and charging reasoning or 1h writes twice.
- Reject summing repeated cumulative conversation snapshots, billing a faux run as a real charge, or calling mixed SDK estimates provider invoices.

**09 — Fixed routes with testable escalation.** Fresh v2 config: inexpensive implementer, frontier planner, inexpensive verifier. Escalation uses the configured planner model, not a fourth independently maintained role. At most one implementation escalation per repair attempt, no extra models voting. Use deterministic risk features below. New and legacy configs default to **always** running a skeptic after primary approval; `risk-v1` is an explicit opt-in measured against that baseline.
- Reject self-reported confidence or Jev opinion as a routing trigger; both would allow the evaluated model to affect its evaluator.
- Reject automatically turning off the skeptic, switching on transport errors, or dynamically discovering a cheaper substitute if a configured model is unavailable.

**10 — Shared provenance, separate judgments.** Canonicalization, typed-answer/usage validation, identity, atomic append and stale-envelope reads are shared. Gate discovery, verifier and triage own their questions, thresholds and unknown semantics. New observations never replace older ones. Neither persistence nor the external judge feeds the authoritative state transition.
- Reject `latest.json` as the history and a single numeric confidence cutoff shared by all questions.
- Reject persisting prompts, patches or model free text as “structured provenance.”

**11 — Telemetry is an observer.** Redact by constructing an allowlisted event **before** writing even local telemetry. Opt in to JSONL; optionally run a separate CLI tail exporter emitting OTLP/HTTP JSON. No external request on the driver call stack; exporter downtime cannot change any outcome.
- Reject exporting wave-log rows by deleting known bad keys: `detail`, gate output, model notes and task IDs can all carry secrets.
- Reject instrumenting with a general agent tool/plugin interface, and mandatory SDK/batching infrastructure in core.

**12 — Detect evidence, never execute discovery.** A compiled-in JS/TS detector and a Go module detector share a bounded read-only repository index. Select Go because `go.mod` + owned `*_test.go` justify one literal command without interpreting Python build backend code or guessing a package manager. Keep recipe approval, stale decisions, remediation and probe consent generic.
- Reject loading repository detectors, running a build tool to discover its tasks, or treating JS `test/` heuristics as evidence of Go support.
- Reject implementing three languages or classifying newly detected Go findings with the existing JS-specific shadow question set.

**13 — Greenfield is a finite interview, not a second planner.** Scaffold one stack: a dependency-free ESM Node CLI with a documented placeholder `--version` behavior. Collect seven bounded fields, show exact files/commands/cost/delivery, require explicit confirmation. Explicit confirmation creates one local seed commit in the newly reserved directory. List the seed files separately: this one-time, named, human-confirmed commit (never the optional paper trail or private state) is the only exception to “no staging controls.” No installs, auto-plan, approval, probe or project-code execution during init. The smoke gate tests the scaffold contract, not completion of the user's PRD.
- Reject an LLM requirements interview with no termination condition, and stacks without a maintained executable fixture.
- Reject overwriting a brownfield project or mistaking consent to create a recipe for consent to run it.

**14 — Observe facts, version the read contract.** Keep the host lock even for short storage reads; open read-only. Publish one atomic, versioned projection for live plan/evidence. Explicitly distinguish known-empty, unknown and last-observed. Version the incompatible DTO change; package a minimal read-only entry point separate from CLI mutation. UI demo setup invokes the CLI. No runtime source imports across packages.
- Reject SQLite reads around an active lock and letting the UI reconstruct plan truth by parsing markdown or row prose.
- Reject exporting `Harness`, a generic filesystem/Git/exec client, or a source barrel disguised as a public API.

## Section 2: Security, Trust & Environment Boundary Spec

```text
operator/editor --- review revision, exact scope, provision profile ---+
UI + token -------- fixed CLI argv; observer reads only ---------------+
                                                                      v
 HOST CLI (same host PID namespace as lock checker) -------------> provider APIs
   lock before SQLite | grant/phase admission | Git objects/refs | git/gh
   durable decisions   | immutable control bundle | credential resolution
   bounded snapshot --> status/artifacts --> observer (never worker control)
   approved descriptor + sanitized files only; never a host cwd/env handle
          |                                      |
   Implementer lease                       Gate/probe lease (new per recipe)
   private editable /work                  frozen /work RO; scratch only
   coding tools + bash in guest            literal argv; no agent/tools
          |                                      |
   quiesce, import validated file delta --> candidate OID --> gate receipt
                                                     |
                                        verifier lease: RO candidate, read only
                                                     |
                                        host verdict/receipt -> integration -> delivery
   HOST typed lifecycle facts -> positive-list encoder -> private JSONL
                               separate opt-in exporter -> local OTLP collector
```

Threat model: hostile model/tool arguments, repo contents/scripts and guest processes; trust the enrolled operator, the host installation, Git metadata/destination explicitly enrolled by the operator, pinned toolchain and sandbox runtime, and the configured inference providers with the **selected** model input. Not a secret scanner for secrets someone deliberately commits into source, protection against a compromised host/kernel/admin, or a promise to contain denial of service on arbitrary hardware. For remote use the service operator becomes a trust principal. Untrusted bytes returning from a guest are data, including its filenames, errors and proposed “receipts”. Only host code constructs receipts from observed effects.

### Backend decision matrix (capability assessment, not a benchmark)

| Adapter/evidence | Isolation; upstream host OS vs kit support | Brownfield/toolchain | Egress & secrets | Whole `ExecutionEnv` fit; latency consequence |
|---|---|---|---|---|
| [Anthropic sandbox-runtime, `0bbebed`](https://github.com/anthropics/sandbox-runtime/tree/0bbebed0aa9a8e628dc4df8bc30293550a1988eb) | OS process sandbox, Linux bwrap/macOS Seatbelt; **this revision** also documents a native Windows account/WFP mode with limitations. Not a VM. Not selected. | Native toolchain convenient; broad read defaults, concrete path expansions and special writable paths require auditing per OS. | HTTP/SOCKS mediation and credential rules; Linux Unix-socket restriction depends on seccomp availability. A warning is not enforcement. | Process wrapper alone doesn't provide the FS interface. Low launch overhead expected; policy generation and path expansion can dominate. |
| **Local: direct bubblewrap**, [upstream](https://github.com/containers/bubblewrap) | Linux namespaces + RO binds; shared kernel. Linux-only; no native macOS/Windows. | Fixed trusted Linux rootfs with Node/toolchain and optional prebuilt dependencies; more prep than SRT, fewer implicit mounts. | Empty host env, isolated network/PID/IPC, no host sockets, no credentials. | Fixed guest RPC helper; amortize namespace startup across one implementation wave. No VM boot. |
| **High isolation: [Gondolin, `ca98da5`](https://github.com/earendil-works/gondolin/tree/ca98da589edd0cd1c79333c0a2229660bb43d37b)** | Linux guest microVM. Upstream krun on Apple silicon and suitable Linux x64/KVM; QEMU on other documented configurations. Kit certifies Apple silicon/macOS or Linux x64/KVM first, not native Windows or implicit emulation. | Prepared guest kernel/rootfs/toolchain required, no host ABI assumption. | Host VFS, mediated network, destination-scoped secret placeholders upstream; kit exposes no runtime network/token. | Guest helper over VM exec/stream; cold boot > local process, reuse only within same lease. |
| [BoxLite, `f94df37`](https://github.com/boxlite-ai/boxlite/tree/f94df37135a2010882c61e35feb6702c7eb75f6a) | Per-box hardware VM, Linux x64/arm64 KVM, Apple silicon; Windows via WSL2 with KVM, not native. | OCI images ease toolchain bake; native runtime needed. | Egress allowlist + host proxy credential injection. | SDK file/exec adapter or guest helper. Image acquisition/cold boot distinct from warm exec. Second local VM adds no required capability. |
| [Buildkite Cleanroom, `eff1528`](https://github.com/buildkite/cleanroom/tree/eff15282aa41773b79af94f5db9ba8ed3b191ccf) | **Not BoxLite.** Policy/provenance layer on [SporeVM](https://github.com/sporevm/sporevm); strongest snapshot path on Linux arm64 KVM/macOS arm64 HVF, x64 capabilities differ; no native Windows promise. | Bake and verify a warm spore; useful for fleets, adds image lifecycle here. | Deny-default network + credential gateway; warmup is itself code execution. | Need Spore lifecycle and a guest FS adapter. Warm restore doesn't include bake time; not selected. |
| **Remote opt-in: [Daytona, `ec4c21b`](https://github.com/daytonaio/daytona/tree/ec4c21b2d597091ac09ecc278f3bcc172575a987)** | Remote managed/self-hosted Linux sandbox, OCI compatible. Client can be on Linux/macOS/Windows; isolation/deletion and egress are deployment capabilities, not evidence of a dedicated VM. | Custom snapshots; upload sanitized project, import validated delta; residency/privacy cost. | Require proven network-block-all, restricted identity, no platform credentials in workload; API token stays with host adapter. | FS/process APIs + guest helper for literal argv; extra RTT and transfer even on a warm sandbox. Reject if deployment can't meet matrix. |

No latency figures here are measured. Measure cold **and** warm, preparation/transfer and gate duration separately (§5). No implicit downgrade from VM/remote to local. Local default on non-Linux refuses and names supported explicitly selected tiers. Windows native never tries bwrap/SRT/WSL translation. A WSL Linux CLI is a Linux host only if project, lock, CLI and observer all live in that Linux namespace and preflight passes. Bare host `status`, `inspect`, `gates list`, `init`, help and existing evidence reads do not require a worker. No live remote calls in default CI.

### Path permissions (deny wins, including aliases and ancestors)

`H` hidden/no handle; `R` read only; `W` private read/write; `S` disposable scratch. Mount or materialize a **positive projection**, not `ro-bind / /`. The host split is by authority, not chmod on the operator checkout.

| Path or resource | Trusted host CLI | Implementer | Planner / primary / skeptic | Gate / probe |
|---|---|---|---|---|
| Operator checkout, index, `.git/` incl. worktree pointer, other worktrees, HOME, SSH agent, user config, host `/proc`, sockets, devices | Read reviewed inputs; scoped Git operations only. Never restore into checkout. | H | H | H |
| `.orch/**` incl. db, config, lock, notes, evidence, receipts, UI jobs; `router.md` | CLI owns; UI only permitted reads and own jobs | H | H (host supplies selected typed facts) | H |
| Sanitized `/work` source from pinned commit/tree | Materialize/freeze/import | W in disposable work copy; exact target scope is checked again **over entire project delta**; outside targets is not admissible | R (planner base; verifier candidate) | R exact candidate; probe pinned baseline |
| All `evals/**`, `PROMPT.md`, `docs/prd.md` **and actual configured/`--prd` path** | Review/control snapshot | R | R | R |
| Protected paths absent at creation | Reserve names, forbid parent replacement/deletion | Cannot change trusted bytes; attempted creation in projection never admitted | No writes | No writes |
| `.git{config,modules,attributes}` and `.gitignore`, delivery and CI controls (`.github/workflows/**`, `.gitlab-ci.yml`) | R, operator edits only in this release | R; no admitted changes | R | R |
| Secret-bearing local files (`.env`, `.env.*`, `.npmrc`, `.netrc`, `.pypirc`, `*.pem`, `*.key`, `.ssh/**`, `.aws/**` at any depth) | Do not project/capture | H | H | H |
| Guest `/tmp`, `/home/worker`, `/run/kit-tmp`; guest `/work/{coverage,dist,build,.cache}` | No operator mounts; exclude scratch from tree | S | S (read tool cannot request writes) | S even for RO gates; refuse scratch mount if it masks tracked inputs |
| `/opt/kit`, guest `/usr,/bin,/lib*`, minimal guest `/etc`, provisioned deps, e.g. `/work/node_modules` | Supply pinned trusted bundle | R | R | R |
| Other mounts, host network incl. loopback/metadata, host IPC, host inherited descriptors | Host only | H | H | H |

In the local tier use separate namespaces + drop capabilities, no-new-privileges, private tmp/home, isolated PID tree/minimal devices and guest-only proc. MicroVM/remote equivalents enforce by guest mount policy and non-root workload. Freeze only after **all** writers are fenced; host never traverses a live, mutable guest symlink. For v1 reject projected symlinks, hard-linked regular files, devices, FIFOs, gitlinks, unsafe/case-colliding names and paths leaving the root rather than trying to follow them; trusted toolchain links stay inside the image. Reject `..`, NUL, absolute/drive/UNC and reserved components at untrusted interfaces. No “realpath followed by open” security argument under concurrent writes. Host static readers use immutable Git objects or no-follow component walks on trusted/fenced directories, including UI source/artifact paths. On a platform unable to provide this guarantee, refuse the operation. Validate limits before allocation/import (100k entries, 32 MiB/file, 512 MiB admitted content; excess is a diagnostic, not a truncated success). Mount control files read-only with non-replaceable parents or enforce equivalent guest VFS; a missing/unsafe mount fails preflight.

### P03 local helper and result contract (approved 2026-11-26)

**Current decision amendment (2026-11-26):** P03 also owns a small Rust native
placement launcher, explicitly selected as optional `installation.localLauncher`
through P01's existing resolver, with no default/fallback or dev-in-kit exception.
Use `clone3(CLONE_INTO_CGROUP)` for the exact journaled child before bwrap/helper
execution; no spawn-then-move. Compiler/target/Cargo dependencies are pinned
maintainer/source-build inputs, separate from npm; prebuilt versioned bundles
serve ordinary users. Minimal unsafe syscall code needs explicit review and real
ordering/FD/owner-loss proof. No runtime compilation. M1.md P03 defines the strict paths and bounded slices. S1 provides optional
selection; S2 provides the native seam and an offline build.

P03 owns a standalone kit helper entrypoint, installed outside the target and
selected explicitly through P01's existing `installation.helper` descriptor
and per-use validator. bwrap uses `installation.bwrap` through the same resolver.
Neither has a fallback/default; P01's installation ownership/mode rules and
CLI/UI-only dev-in-kit exception are unchanged. The selected helper and its
runtime dependency closure must match the reviewed toolchain inventory.

The fixed guest argv is `/opt/kit/bin/node /opt/kit/helper/main.js --protocol=1
--lease-id=<host-UUID> --role=<host-role> --cwd=/work`, with literal tokens and
no shell or unknown flags. Helper stdin/stdout are bounded P02 RPC only;
workload stdio is separately piped and framed, helper stderr is bounded
diagnostics, and control FDs are never inherited by workload children. Other
inherited FDs are closed. Launch begins with durable intent, exact UUID cgroup
creation/identity, durable launching, and a proven trusted placement gate before
bwrap/helper can enable project execution. Namespace/resource checks and a
matching host-bound handshake precede project operations. A runnable project
process followed by PID placement is insufficient. Owner loss prevents admission
or triggers fencing; persisted/guest claims never replace host observations.

**S2 host launcher ABI.** The launcher receives FD 3 for the exact
journaled cgroup, FD 4 for private `KLS1` placement/terminal status, FD 5
for controller liveness and FD 6 for the private single-use gate. Bubblewrap
is the immediate `clone3(CLONE_INTO_CGROUP)` child. The existing helper keeps
its own standard I/O. Placement status never enables project work before
the independent checks and matching helper handshake. Launch consumes its
permission under the same kernel lock used for durable revocation. Recovery
revokes before killing and observing the same cgroup empty, including after
launcher loss. An uncertain gate or cgroup identity blocks recovery. See
[`sandbox/local/README.md`](../../sandbox/local/README.md#s2-fixed-host-launcher-abi)
for the byte and descriptor contract.

For local results the host scans only after killing the exact lease cgroup and
observing `populated 0`, with reattachment and other workspace writers excluded.
Use descriptor-relative no-follow traversal and enforce §2 bounds during scans
and reads. Construct the complete final projected inventory and derive the full
delta, including deletions and executable modes, against the known projection.
Hidden inputs are not deletions; only explicit scratch is excluded; protected,
out-of-scope and inadmissible ignored output changes refuse before filtering.
Guest manifest/receipt/fence claims are data, not authority.

Host-only durable staging binds retained validated bytes and canonical digest
to lease, base tree, controls and projection policy before import intent.
`SandboxLease.seal()` is host-governed fencing, scanning and durable sealing;
it cannot accept a guest's seal assertion. Import builds a private result and
exposes it through an atomic candidate-ref CAS followed by a durable receipt,
with exact-byte/result reconciliation across crashes, not a fictitious atomic
write across Git and the journal. The selected destination is the existing
`refs/kit/<planRevision>/tasks/<taskId>/leases/<leaseId>/candidate`, created only
from absence for this fresh lease; identical observed tree OID plus verified
seal/bindings can reconcile receipt loss, conflicts or ambiguous post-attempt
absence block. Integration/delivery refs retain their existing owners. No arbitrary
tar extraction, partial visible import or operator checkout mutation. Reopen
re-establishes exact ownership/fencing before any rescan, revalidates retained
sealed content, and reconciles only the recorded destination/result identity.
Missing receipts never prove rollback; ambiguity/conflict blocks dependent work.
P03 must prove its concrete placement and atomic visibility mechanisms before
wiring them. This contract does not authorize P04/P05 cutover or certify a host.

### Environment and credential permissions

| Class | Host use | In worker, gate, probe or file helper |
|---|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, other provider/OAuth credentials | Configured inference only | Absent |
| `TYPESAFE_API_KEY` | Explicitly opted-in host Jev call (filtered evidence disclosure, **not** telemetry); outside model-budget accounting | Absent |
| `GH_TOKEN`/`GITHUB_TOKEN`, approved Git credential/SSH identity | Trusted delivery subprocess only, destination pinned, noninteractive | Absent; no forwarded agent/socket/helper |
| `DAYTONA_API_KEY` | Explicit remote provisioner only; authenticated endpoint from host profile | Absent incl. guest init/logs |
| `NPM_TOKEN`, `NODE_AUTH_TOKEN`, PyPI/Go/registry/cloud credentials | Operator supplies **prebuilt**, digest-checked dependency bundle; if a private registry is needed, provision outside run via operator's authenticated registry proxy, exact registry destination, read-only package scope, strip auth on redirects. No project scripts in a credentialed process. | Never raw, no build/run-time registry proxy or passthrough in v1; missing dep is an actionable failure |
| Go toolchain constants (M3 Go profile only) | Never inherited | `GOTOOLCHAIN=local`, `GOPROXY=off`, `GOSUMDB=off`, `GOCACHE=/tmp/go-build`, `GOMODCACHE=/opt/kit/go-mod-cache` (private scratch/RO provisioned cache); no guest fetching. |
| `PATH`, `HOME`, `TMPDIR`, `LANG`, `TZ`, `CI` | Not inherited | Build from empty: `/opt/kit/bin:/usr/bin:/bin`, `/home/worker`, `/tmp`, `C.UTF-8`, `UTC`, `1` respectively. Package caches go under scratch. No `.`, host entry or inherited `node_modules/.bin`. |
| Project literals | Exact names requested by `[sandbox].publicEnv` **and** granted values in the per-root host profile. Only `PROJECT_PUBLIC_[A-Z0-9_]+`, <=16, simple public literals <=128 UTF-8 bytes. | Only matching host-approved literals; no secret lookup by project-chosen env name. Missing grant = refuse. Operator acknowledges these are readable by arbitrary project code. |
| Everything else, incl. `KIT_*`, `PI_*`, `T3_*`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `GIT_*`, `SSH_*`, `*_PROXY`, `OTEL_*`, `BASH_ENV`, credential/config/cache paths | Keep only in their intended trusted process; trusted binaries located by fixed installation/profile, not target repo PATH | Strip. No `...process.env` followed by deleting a few names. Close all inherited FDs other than stdio/fixed bounded RPC. |

**Telemetry allowlist:** enums, bounded numbers/booleans, host-generated opaque IDs, HMAC correlation tokens, timings/metrics and receipt outcome codes in §3 only. External IDs for tasks, gate names, repo-defined model IDs and any content-address derived from code are pseudonymous (installation-private HMAC-SHA256); known provider/catalog models may use canonical allowlisted labels. Never export root, branch, URL, SHA of private code, raw task IDs, command/argv/env, PRD, paths, feedback, criterion text, diff, tool I/O, logs, error strings, conversation messages, HTTP headers or SDK payloads. Schema validation before local emit **and** before export; unknown keys/events dropped, not forwarded as `attributes`. Existing local evidence isn't redacted telemetry; never tail it into a collector.

## Section 3: Data Model, Config Schema & Seam Changes

### Config contract at the end of the plan

This is the normative v2 init template shape (TOML). Do **not** write future keys to the shipped template before their implementing packet. Role tables with nonblank provider/modelId are required; counts are safe integers, USD values finite and nonnegative. All defaults are shown; omitted optional rates/thinking level stay unset. `retryLimit>=0`; `publicEnv` must be a duplicate-free list satisfying §2. Unknown `configVersion` refuses execution. `sessionUsd=0` admits no model submission. New keys are strict: wrong types, unknown keys in a recognized v2 table, invalid enums or conflicting forms are config errors, not silent fallbacks. Unknown top-level extension **tables** remain inert; never load code from them.

```toml
configVersion = 2
[engine]
piDurable = "1.5.0"
maxTurns = 50                 # integer >=1
retryLimit = 3                # 1 initial wave + up to 3 repairs
[roles.planner]
provider = "anthropic"
modelId = "claude-sonnet-4-5"
[roles.implementer]
provider = "anthropic"
modelId = "claude-haiku-4-5"
[roles.verifier]
provider = "openrouter"
modelId = "openai/gpt-5-nano"
# Optional on EACH role: thinkingLevel = "off"|"low"|"medium"|"high"
# Optional fallback USD per 1M; absent = unknown, explicit 0 is a price:
# costPerMillionInput, costPerMillionOutput, costPerMillionCacheRead,
# costPerMillionCacheWrite5m, costPerMillionCacheWrite1h
[budgets]
sessionUsd = 10.0
waveUsdWarn = 2.0
maxConsecutiveErrors = 3     # integer >=1
maxSleepCycles = 3           # integer >=0, per task, persists across wakes
[gates]
timeoutSec = 120             # integer >=1
# target path enforcement is mandatory; legacy enforceTargetPaths=true accepted
skepticPolicy = "always"     # always | risk-v1 | never
jevVerifierShadow = false
jevFailureTriageShadow = false
[delivery]
mode = "none"                # none | commit | pr; pr requires --deliver
[paths]
prd = "docs/prd.md"
specs = "specs/"             # reserved; no automatic spec-file writer
[sandbox]
backend = "local"            # local | microvm | remote; never auto-fallback
publicEnv = []                # names only, §2; network always denied
[cache]
retention = "short"          # off | short | 1h, request not a hit guarantee
[routing]
policy = "tiered-v1"         # fixed | tiered-v1
[telemetry]
local = false                # private bounded JSONL emission; no endpoint here
```

`configVersion` absent/1 reads old roles literally (no silent model substitution), `routing.policy` absent → `fixed`; in v2 absent → `tiered-v1`. Old `skepticSecondPass` absent/true → `always`, false → `never`; reject both keys, show replacement. Never disable mandatory scope (`enforceTargetPaths=false` errors with migration hint; previously the flag was ineffective). Majority of existing settings are not new. `piDurable` exact installed pin, `paths` normalized project-relative, refuse traversal/symlink/hidden inputs. Check rate conflicts for roles naming the same provider/model; for missing used-class rates see usage below. No repo-config endpoint, raw secret, trusted-binary path, image URL, spend bypass, open-ended extra flag or arbitrary mount. `init` never overwrites an existing config. Profiled fakes in tests are constructor injection only; `KIT_FAUX` changes inference, **not isolation**.

**Trusted installation resolution (M1-P01; amended 2026-11-25):** one
host-owned installation descriptor names the executable and argv prefix for
each host tool. The Node interpreter is `process.execPath`; the CLI/UI entries
are those of the running operator-selected kit installation (the running entry
and its sibling UI bin), not a target copy. On Linux the validated defaults for
Git/gh are `/usr/bin/git` and `/usr/bin/gh`; `helper`/`bwrap` and the approved
P03 `localLauncher` have no defaults and must be explicitly selected. Optional
absolute overrides live only in host policy. Target schema after P03-S1:
`installation?:{cli?:string,ui?:string,node?:string,git?:string,gh?:string,helper?:string,bwrap?:string,localLauncher?:string}`.
`localLauncher` is currently not implemented; do not enroll it before S1 lands.
No other P01 resolver/trust policy is relaxed by this additive extension.

- **Selection authority.** No PATH search, target `node_modules/.bin`,
  cwd-relative candidate, project config/env, `KIT_*` value, argv token or job
  record may select a host tool. `KIT_UI_CLI_BIN` is retired as authority.
- **No fallback.** A present but invalid override refuses; it never falls
  through to the fixed default. A missing default on a non-Linux host (or a
  missing Linux default) also refuses; it never triggers a PATH search.
- **On demand.** Resolve AND validate per use. An unused tool is never
  resolved: `delivery.mode=none` must not require `gh`, and a static command must
  not require Git, gh, the UI or a sandbox helper. An eager all-tool sweep may
  back an explicit host check, never production launch.
- **Trust.** Installation paths stay absolute, normalized, NUL-free and
  symlink-free at every component, with executable and ancestor-directory trust
  checks (regular non-symlink leaf; operator/root-owned; not group/world
  writable) and exclusion from the target checkout. `process.execPath` is the
  running process's resolved executable path and is validated the same way. A
  symlinked installation path is never resolved to its target; it refuses. A
  host whose fixed default is a symlink must name the canonical real file in
  `installation.*`; the kit does not silently realpath a default.
- **Dev-in-kit exception.** The running operator-selected source checkout is
  the installation: its own `dist/cli.js`, `ui/bin/llm-toolkit-ui.js` and
  `src/cli.ts`-via-`ui`-tsx entries are trusted even if the target is that same
  checkout. The exception is proven by the running entry/installation identity
  (the resolved module/entry URL), never inferred from `process.cwd()`,
  `argv[0]`, a target path or a project value; a target checkout that merely
  contains a kit copy is not trusted. It is limited to the outside-the-target
  rule: symlink, ownership and mode checks still apply.
- **Descriptor injection.** Production builds the descriptor from the profile
  plus fixed defaults. Tests inject an explicit descriptor in-process or through
  private job state; injection is host authority, not a weaker validation mode
  and not a production-authority source. Job launch and attached-stop use one
  descriptor/argv identity: the runner executes exactly the recorded canonical
  argv without re-resolution, and attached-stop compares the process
  argv/executable against that record.
- **Config reads.** `.orch/config.toml` is read asynchronously through the
  canonical root + `safe-read` + the pure `parseConfig`; absent, refused and
  malformed stay distinct. A sync legacy config read is not packet completion and
  no production caller may keep one.
- **Git/gh.** An absolute Git path is necessary, not sufficient. Every call
  uses fixed literal argv and a host-built environment with inherited
  `GIT_*`/`GH_*`/`SSH_*`/proxy/`BASH_ENV`/`NODE_OPTIONS` stripped, inherited
  `GIT_CONFIG*` removed, and hooks, fsmonitor, external diff/textconv, aliases and
  smudge/clean filters disabled or avoided by plumbing. Repository-controlled
  callbacks never execute on the host. `gh` is noninteractive,
  destination-pinned, resolved only for `delivery.mode=pr` with `--deliver`, and
  never receives a target-selected host or token.
- **Platforms.** Where the read primitive or a tool default is unavailable, the
  operation that needs it refuses with a typed result; commands that perform no
  project read or host launch still run.

M4-P04 changes CLI discovery to installed package metadata; it must retain M1's
trust validation, not re-enable project-local resolution. P01 installs these
host boundaries only; gate/probe containment and `[sandbox]` enforcement remain
P05.

**Host policy**, not repo config: path `~/.config/llm-toolkit-001/host-v1.json` (Windows `%LOCALAPPDATA%/llm-toolkit-001/host-v1.json`), user-owned, non-project, refuse insecure permissions/reparse points. Schema `{version:1,installation?:{cli?:string,ui?:string,node?:string,git?:string,gh?:string,helper?:string,bwrap?:string,localLauncher?:string},projects:[{root:absoluteCanonical, backends:("local"|"microvm"|"remote")[],toolchainId:string,publicValues:Record<string,string>,remoteProject?:string,deliveryOrigin?:string,otlpLoopback?:boolean}],toolchains:Record<string,{rootfs?:absoluteImmutablePath,manifestSha256:string,gondolinImage?:absoluteImmutablePath,daytonaSnapshot?:string,deps?:absoluteImmutablePath}>}`. Exact canonical root match, one entry, immutable image/deps validated against host manifest (manifest lists digests, platform, Node version and dependency lockfile digests); reject missing tier fields. One provisioned local default toolchain can be registered under `toolchains.default` for local, no-extra-env, no-network, no-upload projects without entries. No implicit remote use. Remote requires host allow + `--allow-remote` on **each** CLI invocation that might transfer bytes (`plan`, `run`, `verify`, executing `gates probe`, accepting `resolve`); UI does not add it. `deliveryOrigin` is operator-allowlisted HTTPS GitHub repository URL for PRs (no custom git transport or target-controlled gh host). OTLP export requires a separate foreground `telemetry export [--follow]`, local collection already enabled, and host `otlpLoopback:true`; fixed `http://127.0.0.1:4318/v1/traces`, no redirects, user-supplied headers, auth, or arbitrary network endpoint. Operators configure onward export in their collector.

### P03 local toolchain inventory (approved 2026-11-26; versioned bundle amendment)

**Supported provisioning direction:** publish versioned complete toolchain bundles,
not automatic harvesting of whichever tools happen to be installed on each host.
Cover launcher/bwrap identities, rootfs, exact guest Node/libraries, helper closure,
utilities/dependencies/locks and build/provenance inputs. Host-only tools remain
outside the guest. Project-specific dependency bundles remain separate reviewed
inputs; no project install hooks on the host. No concrete release/pins or artifact
hosting/signing infrastructure are claimed to exist yet.

Acquisition may be networked only in explicit, separately approved operator setup
(`sandbox/local/provision-toolchain.sh`, planned), with reviewed sources and
independent authenticity verification. Offline supplied bundles remain supported.
The fixture builder and all worker execution/recovery remain offline; no implicit
download, toolchain compiler installation, host dependency lookup, or version
fallback. Validate archives/staging before install, including malicious paths,
links/types/limits and interrupted installs. Versioned installations are
side-by-side with explicit selection; never overwrite/delete referenced recovery
assets or silently update to `latest`.

D1 review-first applies before host effects: present exact compiler/assets/sources,
provenance, versions, hashes, destinations, commands/privileges and profile changes
for approval. Rust toolchain setup on the development host is needed but not yet
performed/authorized at the command level. Documentation/source preparation is
not artifact enrollment. This model applies to all local installations, while
current session authority is limited to the operator's development machine.

The existing `toolchains.*.manifestSha256` anchors an operator-reviewed exact
inventory; it is not a guest-supplied checksum or permission to discover tools.
The only approved installation-schema addition is optional `localLauncher`
through the existing resolver (P03-S1); no additional toolchain-profile field or
second resolver is introduced. The host-policy shape above is the target shape
including this not-yet-implemented key. P03 must define a
versioned canonical encoding (stable ordering, paths, lengths, modes and SHA256
semantics) covering OS/architecture/ABI, exact guest Node version and executable,
loader/libraries, fixed helper/protocol identity and all transitive installed
imports, shell/utilities, prebuilt dependencies and their lockfile digests.
Distinguish installed input provenance from the resulting rootfs content
inventory/digest without a self-referential manifest hash. Define deterministic
content metadata and verify the complete rootfs/dependency identity before use.

The fixture pin record is `sandbox/local/fixture-assets.lock.json`; populate it
with actual measured/reviewed assets only. The builder consumes an explicitly
selected trusted installed copy plus absolute asset locations. A target copy,
PATH/cwd lookup, project config, inherited env or `KIT_*` cannot select or alter
assets/pins. Run offline, with fixed trusted subprocess invocations and an
explicit environment, no project scripts or install hooks. Copy through safe
reads into private staging, verify the staged bytes rather than hash-then-reopen
mutable paths, and accept a fixture only after complete validation. Failed or
interrupted builds never produce an admissible incomplete fixture. Identical
admitted inputs must reproduce the defined rootfs content identity.

Guest Node need not equal P01's selected host interpreter. `engines.node` remains
a host compatibility range. The observed v24.18.0 is a candidate only: choose and
review an exact version and real digest inventory before provisioning. Document
whether provenance is operator-approved installed assets alone or additionally
verified vendor release material; a local hash alone does not establish vendor
authenticity. Missing/version/platform/ABI/digest/lock mismatch refuses without
network or alternate-source fallback. Pin enrollment and required primitive
proofs remain prerequisites, not certification supplied by this amendment.

### Host-owned types (binding shapes; split modules by packet)

Strings for Git OIDs are full lowercase native Git object IDs (40/64 hex, verify object kind/existence); UUIDs lower-case UUIDv4; digests full SHA256. Persist JSON type literals, not class instances, `Map`, `BigInt` or explicit `undefined`; optional means omit. `RouterTask` keeps its immutable definition and adds references to execution fields; no provider type crosses into a UI DTO.

```ts
type Revision = string; type Oid = string; type Digest = string;
type TaskDef = Pick<RouterTask,'id'|'title'|'spec'|'dependsOn'|'acceptance'|'targetPaths'|'priority'>;
type PlanIdentity = {planRevision:Revision; definitionSha256:Digest; baseCommit:Oid;
  baseBranch:string|null; prdPath:string; prdSha256:Digest; controlsSha256:Digest};
type Grant = {planRevision:Revision; selected:string[]; humanApprovedAt:number}; // sorted unique IDs
// Key: revision + normalized task ID + monotonically increasing wave; a manual retry never reuses a wave number.
type WaveKey = {planRevision:Revision;taskId:string;wave:number};
type Stage = 'implement'|'gates'|'primary'|'skeptic'|'integrate'|'publish'|'rollback'|'terminal';
type Checkpoint = WaveKey & {stage:Stage;parent:Oid;startTree:Oid;candidate?:Oid;
  conversationId?:number;submissionKey?:string;leaseId?:string;grantedFeedbackIds:string[]};
type ModelStage = 'plan'|'implement'|'primary'|'skeptic'|'verify-primary'|'verify-skeptic';
type PendingRequest = {opId:string;stage:ModelStage;planRevision:Revision|null;taskId?:string;wave?:number;
  conversationId:number;submissionKey:string;attempt:number;status:'ready'|'submitted'|'budget-paused'|'settled'};
// Plan/one-off verify own operation keys, not fictitious waves. A wave's submissionKey links its pending request.
type GateCheck = {id:string;kind:'scope'|'recipe';outcome:'pass'|'fail'|'skip'|'error';exit:number|null;ms:number};
type GateReceipt = WaveKey & {id:string;tree:Oid;controlsSha256:Digest;checks:GateCheck[]};
type EvidenceRef = {kind:'gate';id:string} | {kind:'line';path:string;line:number};
// Criterion id = String(1-based index in the reviewed task's ordered acceptance array); never renumber after review.
type CriterionResult = {id:string;status:'pass'|'fail'|'unverifiable';evidence:EvidenceRef[]};
type ReviewPass = {pass:'primary'|'skeptic'|'human';verdict:'approve'|'reject'|'needs_human';
  criteria:CriterionResult[];notes:string;conversationId?:number};
type AcceptanceReceipt = WaveKey & {id:string;parent:Oid;tree:Oid;gateId:string;controlsSha256:Digest;
  policy:'always'|'risk-v1'|'never'|'human-v1';required:('primary'|'skeptic'|'human')[];
  passes:ReviewPass[];authority:'verifier'|'human';at:number;reason?:string};
type RollbackReceipt = WaveKey & {id:string;baseTree:Oid;producedTree?:Oid;
  state:'pending'|'discarded'|'failed'|'unknown';checkedAt:number;code?:string};
type DeliveryReceipt = WaveKey & {id:string;acceptedId:string;commit:Oid;mode:'none'|'commit'|'pr';
  state:'not_requested'|'pending'|'published'|'failed'|'unknown';ref?:string;baseRef?:string;
  prNumber?:number;prUrl?:string;checkedAt:number;code?:string};
type IntegrationIntent = WaveKey & {acceptedId:string;parent:Oid;candidate:Oid;commit:Oid;at:number};
type PassReceipt = WaveKey & {tree:Oid;gateId:string;policy:AcceptanceReceipt['policy'];review:ReviewPass};
type Resolution = WaveKey & {action:'retry'|'accept-tree';reason:string;evidenceSha256?:Digest;tree?:Oid};
type ReceiptPayloads = {gate:GateReceipt;pass:PassReceipt;acceptance:AcceptanceReceipt;integrate:IntegrationIntent;
  rollback:RollbackReceipt;delivery:DeliveryReceipt;resolution:Resolution;checkpoint:Checkpoint};
type ReceiptEvent = {[K in keyof ReceiptPayloads]:{kind:K;opId:string;at:number;value:ReceiptPayloads[K]}}[keyof ReceiptPayloads];
type RunResult = {outcome:'plan-complete'|'selection-complete'|'blocked'|'budget'|'sleeping'|'recovery-required';
  selected:string[];remainingPlanIds:string[];blockedIds:string[]};
```

**Transition protocol.** Actionable state is in pi-durable JSON docs. Add `loop.receipts` v1 (session scope: `{version:1,events:ReceiptEvent[]}`; tagged union of gate/pass/acceptance/intent/rollback/delivery/resolution/checkpoint transitions, with stable operation ID and timestamp). Append authoritative observation/intent with the Router/Run mutation in **one** `harness.commit`. Latest task pointers and checkpoint are small; keep raw output/patches out of documents. SQLite commit and Git/gh are **not** one transaction:

1. Capture `baseCommit=HEAD` once at planning. Only committed ordinary source is input. Surface staged/unstaged/untracked code as excluded; never stash or stage it. Snapshot actual regular-file PRD/PROMPT and `evals/**` plus approved remediations into a private content-addressed controls bundle. Bind effective verification/delivery/routing/sandbox policy (not `budgets.sessionUsd`) to `controlsSha256`; hash stable sorted relative names, lengths and bytes/canonical settings. Validate on approval/resume; changed HEAD or controls → refuse *new* grant/run with replan hint; reconciliation of **already recorded effects** may inspect pinned objects, never publish to a new destination. Replan doesn't erase history; refuse replacement while an intent/lease is unresolved.
2. Use a private directory per revision/task under `.orch/work/` (0700). Materialize ordinary files without `.git`, hooks, smudges, submodule update or dependency install. Initialize a private temp index from full parent tree. After fencing writers, enumerate all new/changed/deleted **projected** files (including modes) vs parent projection; reject protected/out-of-target changes before filtering for delivery. Don't treat hidden parent files as deletions. Exclude only the explicit scratch mounts. A *new* ignored path outside scratch is a diagnostic/refusal, not a silently accepted extra output. Tracked file edits/deletes are always accounted for. The operator's ignored/untracked files were never projected. Parse paths NUL-safe, use `hash-object --no-filters` and `git update-index -z --index-info`, not `git add` or an argv-sized path list. Result tree compared via literal tree-to-tree diff; stage exactly this delta incl. binary, deletes, executable bit. Keep host Git commands free of hooks, filters, textconv/external diff, filesystem monitors, aliases and project executables. Refuse invalid object/short read/truncated manifest; display truncation ≠ success for machine inputs.
3. Pin pre-wave and candidate trees under validated private refs `refs/kit/<revision>/waves/<task>/<wave>/{start,candidate}` (refs outside `heads` can name trees). Stop or diagnose on unknown state, never synthesize an empty changeset. Gate against frozen candidate+control bundle; verifier reads the same snapshot. On failed/rejected wave start next wave from previous produced tree; on quarantine seal evidence and discard **only** owned workspace, observe no live writers, workspace absent and integration ref unchanged. If cleanup/check fails, persist `failed`/`unknown`, stop; `quarantined` alone does not imply successful rollback. Unknown recovery is not manually approvable.
4. Create the checkpoint commit object with exactly `parent` and `candidate`, pinned while pending. Write acceptance + integration intent **before advancing** `refs/kit/<revision>/accepted` via `update-ref` compare-and-swap (initial ref = baseCommit). On recovery: ref==parent → retry same CAS, ref==recorded commit → finish recording, anything else → halt. `delivery=none`: append `not_requested`, `done`; result view: `git worktree add --detach <new-dir> refs/kit/<revision>/accepted`. `commit`: CAS `refs/heads/kit/<revision>/result` forward from previous published commit (absent on first); refuse checked-out result branch or foreign head. `pr`: require explicit `--deliver` **before beginning**, base branch at reviewed origin SHA, persist intent; create the remote ref for the exact commit at `kit/<revision>/<task>` using a create-only CAS (`git push --force-with-lease=<new-ref>: <approved-https-origin> <recorded-commit>:<new-ref>` with fully qualified ref names and literal argv; empty expected old OID only, **never** change an existing ref); first PR targets reviewed base branch, subsequent PR targets previous task branch at recorded OID. Verify host-reported repo/base/head SHA and PR identity before `published`. On retry query before create; matching effect = acknowledge, conflict/uncertain network = pending/unknown, not another branch/PR. No checkout of any delivery branch. Only after confirmed publication may B start; B's parent is the local **integration commit**, never a guessed PR merge/base branch. `run` on pending work retries reconciliation only (PR still needs `--deliver`); never re-run implementation to repair delivery.
5. Selection includes done tasks as no-ops; unsatisfied dependency outside selection = invalid at approval, named culprit; blocked/quarantined member inside = stopped-short, not success. Already accepted/integrated prerequisites are satisfied only if `done` with required receipt on this lineage. Run exit `0` iff full/selected work fulfilled (distinct strings), `2` policy stop incl. budget/quarantine/recovery, `42` sleeping, `1` invalid input/lock/hard error, `130` SIGINT. Stop the selection on its first quarantine. A different disjoint grant is possible only after any pending effects are reconciled. Preserve the four existing task statuses: `needs_human` is a typed block reason on a quarantined task, not `done`; accepted/publishing is `in_progress` with a non-implement stage, not an active worker. Derive live activity from the checkpoint, never from task color. Emit whole-plan success only if **every** task is `done` under these rules. Durable checkpoints include same-stage deterministic submission IDs; reconcile committed submissions before issuing new ones. Never resume a different pending task by approving a narrower scope. Unknown in-flight legacy work → stop, never replay blindly.

**Human path.** `resolve --revision R --task T --retry --reason TEXT` on a blocked task discards only a confirmed fenced lease, requeues from the current accepted head with fresh attempt quota, clears duplicate-failure hash/counters, preserves monotonically increasing wave/history, and performs no work without matching grant. `resolve --revision R --task T --accept-tree OID --evidence FILE --reason TEXT` is only for `needs_human` with a retained candidate, unchanged integrated parent, matching scope, confirmed discard/fence and control bundle. Evidence JSON is `{criteria:CriterionResult[]}`; require all IDs pass with validated refs. Rerun deterministic gates unchanged on the exact candidate; fail/skip-only as claimed proof, stale SHA, bad scope, recovery error or missing reason → no acceptance. Record **human authority**, not model approval, then reuse the integration/publication state machine; no remote PR side effect without `run --deliver`. `verify` may write review/usage history but cannot set task status or unblock dependencies. No “force done.”

### Execution, policy and observation interfaces

```ts
// import ExecutionEnv, Context, EnvTarget only via src/engine/kit.ts (pinned upstream types).
type Backend = 'local'|'microvm'|'remote'; type Purpose = 'plan'|'implement'|'verify'|'gate'|'probe';
type LeaseSpec = {id:string;purpose:Purpose;tree:Oid;controlsSha256:Digest;toolchainId:string;
  targets:readonly string[];publicValues:Readonly<Record<string,string>>;timeoutMs:number};
type ExecOutcome = {code:number|null;stdout:string;stderr:string;signaledBy?:string;
  timedOut?:boolean;stdoutCapped?:boolean;stderrCapped?:boolean}; // missing legacy flags = false
interface SandboxLease { readonly id:string; readonly env:ExecutionEnv; // entire FS + Shell, guest paths only
  execArgv(argv:readonly [string,...string[]],cwd:string,timeoutMs:number,signal:AbortSignal):Promise<ExecOutcome>;
  seal():Promise<{manifestId:string}>; close():Promise<void>; }
interface SandboxProvider {readonly backend:Backend;
  preflight(spec:LeaseSpec):Promise<void>; open(spec:LeaseSpec):Promise<SandboxLease>;
  fence(id:string):Promise<void>; } // idempotent; unknown ownership -> throw, never guess
interface EnvResolver {resolve(target:EnvTarget,context:Context):Promise<ExecutionEnv>}
type Recipe = {name:string;cwd?:string;on?:string[];match?:string[]} &
  ({argv:[string,...string[]];cmd?:never}|{cmd:string;argv?:never});
type RecipeSource = Recipe & {source:'human'|'generated';file:string;category?:GateCategory};
interface CostRates {costPerMillionInput?:number;costPerMillionOutput?:number;costPerMillionCacheRead?:number;
  costPerMillionCacheWrite5m?:number;costPerMillionCacheWrite1h?:number}
interface Usage {input:number;output:number;cacheRead:number;cacheWrite:number;cacheWrite1h?:number;
  totalTokens:number;cost:{input:number;output:number;cacheRead:number;cacheWrite:number;total:number;totalFromProvider?:boolean}}
interface UsageView {input:number;output:number;cacheRead:number;cacheWrite:number;cacheWrite1h:number|null;
  usd:number|null;knownSubtotalUsd:number;source:'sdk'|'configured'|'faux'|'unknown'|'mixed';cachedFraction:number|null;
  savingsUsd:number|null} // DTO; omit or null for missing entire observation, not synthetic zero counters
interface RouteFacts {role:'planner'|'implementer'|'verifier';pass?:'primary'|'skeptic';wave:number;
  lastFailure:'none'|'gate'|'reject'|'scope'|'transport';retryable:boolean;progress:boolean|null;
  rejectWithValidRef:boolean;priorGateOrRejectRepair:boolean;files:readonly string[];
  changedLines:number|null;targets:readonly string[];passedNonScopeRecipes:number;binary:boolean}
interface Route {provider:string;modelId:string;thinkingLevel?:RoleConfig['thinkingLevel'];tier:'role'|'frontier';
  reason:'configured'|'plan'|'repair'|'risk';requireSkeptic:boolean}
interface ModelRouter {choose(facts:RouteFacts):Route}
type ShadowStage = 'adoption'|'verifier'|'triage';
type ShadowKey = {eventId:string;stage:ShadowStage;planRevision?:Revision;taskId?:string;wave?:number};
type ShadowEnvelope<T> = ShadowKey & {v:1;at:number;policyVersion:string;evidenceSha256:Digest;assessment:T};
type IndexedText = {kind:'text';value:string}|{kind:'absent'}|{kind:'unknown';reason:'limit'|'read'|'unsafe'};
interface RepoIndex {files:readonly string[];complete:boolean;warnings:readonly string[];readText(path:string):Promise<IndexedText>}
interface DetectorOutput {findings:GateFinding[];warnings:string[]}
interface EcosystemDetector {readonly id:'js'|'go';detect(index:RepoIndex,inventory:Readonly<GateInventory>):Promise<DetectorOutput>}
```

The resolver uses `target.conversationId` + `target.read` to fetch the committed guard/lease. Never let `target.cwd` select a host directory. Persist the descriptor before submission; reopen verifies host grant/lease/phase before resuming; unknown or missing guard denies **all** operations. `env.id` unique per lease, stable within it, `env.cwd` in guest `/work`. Implement guest reader handles (`openBinaryReader` incl. scan/close), canonicalization, temp/spill, file writes and shell/argv in the guest; no host fallback for an unsupported FS method. `execArgv` calls array exec, not string exec; close stdin, cap during capture, timeout kills the lease process group/descendants. Guest `NodeExecutionEnv` is allowed **inside** containment; trusted host tool calls do not get one. Read-only mode has no write/edit/bash tool **and** OS read-only mounts.

**Cost rules:** normalize finite nonnegative counts; `L=cacheWrite1h` is a subset of `W=cacheWrite`, never add it to total; `0<=L<=W`. At a known tariff, fallback USD = `(I*in + R*read + (W-L)*write5 + L*write1h + O*out)/1e6`. Missing split with W>0: use aggregate writes only when both write rates are known equal or a documented provider class proves one rate; otherwise unknown, not “the requested TTL.” Only nonzero classes require rates. Reliable positive SDK total (or explicitly provider-billed zero) first, configured rates second; fixture provider with no price is simulated free. For accumulated mixed SDK records label `sdk`/`mixed`, not `billed`; do not infer source completeness from the first `totalFromProvider` bit. Value per submission/model from before/after ledger deltas, persist quote/source; sum once. Reconcile against session model ledger, include planning/verifiers/compaction and previous storage usage; unresolved/unpriced residual = `usd:null` with known subtotal, next paid admission stops; never add cumulative USD to itself. `cachedFraction=R/(I+R+W)`, null on zero denominator. Show uncached prompt reads/writes separately (`I`, `W`), output separately. Net estimated savings = `((R+W)*in - R*read - (W-L)*write5 - L*write1h)/1e6` at a comparable known tariff (negative allowed); null if unknown. This is a tariff comparison, not invoice savings. `faux` costs in routing experiments are explicitly *simulated* tariffs.

**Per-request budget seam (especially verifier):** M0 uses a host decorator of the pinned `Models` interface at `HarnessOptions.models`, SDK types/factory only through `engine/kit.ts`. Intercept generation `streamSimple` and compaction `completeSimple` **before** delegating; use an `AssistantMessageEventStream` forwarding bridge for async admission. Before `submit` (and before resumed scheduling), map the persisted `ProviderDoc.sessionId` to the conversation/guard and admitted stage under the lock; the dispatch option carries that session ID. No custom provider-session affinity. Check that mapping on each dispatch; unknown billable dispatch → refuse. Serialize checks per project outside the SDK commit line, use committed usage + newly observed/undebited model deltas, never the prompt. Check before the initial `submit` too. On denial interrupt/settle submission and persist its budget-blocked stage; intercept SDK retries too (no actual dispatch while blocked). On budget change reuse checkpointed work, never count a partial/error pass as conclusive. M2 adds retention/valuation at the same seam, not a second model client. If identity/interruption cannot be proven by the synthetic multi-call test, the spend spike is no-go, not license to submit on stale cost.

**Routing table** (one pure classifier; keys frozen on review). In `fixed`, role model always; the chosen skeptic policy still applies. In `tiered-v1`, planner uses planner; first implementer wave uses implementer; retryable non-scope executed-gate failure or an evidence-backed `reject` on a changed tree → planner model for the **next repair wave** (both require `retryable && progress===true`; rejects additionally require `rejectWithValidRef` from host validation of at least one failing criterion). Never escalate for sleeps, transport errors, duplicate/no-progress, invalid JSON, or `needs_human`. Primary/skeptic use verifier unless high risk, then planner. High risk is any of: previous gate/reject repair in this task; empty targets; binary or unmeasurable diff; >3 changed files or >100 added+deleted lines; no executed passing non-scope recipe; any changed path with component `auth`, `security`, `migrations`, or basename `package.json`, `package-lock.json`, `go.mod`, `go.sum` (case-fold ASCII). No model-supplied risk flags. `requireSkeptic = always || (risk-v1 && highRisk)`; `never` is explicit operator opt-out. Only call after a conclusive primary approval. Primary/skeptic never see one another's answer. Switching to a frontier route does not grant extra turns/budget/retries. Bundle policy version, risk flags, route and required passes with evidence.

```ts
type EventKind = 'run'|'wave'|'model'|'gate'|'review'|'quarantine'|'rollback'|'delivery'|'sandbox';
type SafeOutcome = 'start'|'end'|'ok'|'fail'|'skip'|'unknown'|'approve'|'reject'|'needs_human'|
  'blocked'|'budget'|'sleeping'|'discarded'|'pending'|'published'|'not_requested';
interface TelemetryEvent { v:1;kind:EventKind;outcome:SafeOutcome;atMs:number;durationMs?:number;
  runId:string;planRevision:string|null;traceId:string;spanId:string;parentSpanId?:string;eventId:string;
  taskId?:string;wave?:number;role?:'planner'|'implementer'|'primary'|'skeptic'|'human';
  provider?:string;modelId?:string;backend?:Backend;gateId?:string;receiptId?:string;
  usage?:Pick<UsageView,'input'|'output'|'cacheRead'|'cacheWrite'|'cacheWrite1h'|'usd'|'source'> }
interface TelemetrySink {tryEmit(event:Readonly<TelemetryEvent>):void;dispose():void} // no await/throw on run path
// planRevision=null before one exists (probe/pre-plan); runId + traceId correlate that operation.
// No dummy revision IDs and no task/wave IDs when not applicable.
// readout additions: optional on seam 1; incompatible unknown handling moves to seam 2.
type Observed<T> = {kind:'known';value:T}|{kind:'unknown';reason:'legacy'|'absent'|'invalid'|'mismatch'|'capped'};
type TaskFact = {def:TaskDef;status:TaskStatus;waveCount:number;feedbackCount:number;
  lastWave?:number;lastGate?:{tree:Oid;checks:GateCheck[]};lastVerdict?:{tree:Oid;pass:ReviewPass['pass'];verdict:ReviewPass['verdict']};
  accepted?:{tree:Oid;authority:'human'|'verifier'};rollback?:RollbackReceipt['state'];delivery?:DeliveryReceipt['state']};
interface LivePlan {v:1;planRevision:Revision;seq:number;asOf:number;tasks:TaskFact[]}
interface ReadFactsV2 {seam:2;mode:'storage'|'sidecars';plan:Observed<LivePlan>;
  freshness:{asOf:number|null;seq:number|null;state:'authoritative'|'last-observed'|'unknown'};
  cache:Observed<UsageView>;tasks:TaskSummaryV2[]|null}
type TaskSummaryV2 = {id:string;title:string;status:TaskStatus;waveCount:number;
  dependsOn:string[]|null;targetPaths:string[]|null;priority:number|null;feedback:number|null;
  baselineTreeSha?:Oid;lastGateHash?:Digest;diff?:DiffArtifactRef};
// Other v1 display fields (live, spans, capped diff refs, health, storage-only excerpts) remain DTOs.
interface CoreReaderV2 {snapshot(root:string):Promise<ReadoutV2>;
  entries(root:string,id:number):Promise<ReadReply<ConvEntriesView>>;
  diff(root:string,task:string,scope:'task'|'live'|{wave:number}):Promise<ReadReply<DiffDto>>;
  sources(root:string):Promise<SourcesDto>;status(root:string):Promise<StatusDto|null>}
type ReadReply<T> = {ok:true;value:T}|{ok:false;status:400|404|409;reason:string};
```

`ReadoutV2` replaces the overlapping v1 fields with `ReadFactsV2`, retains non-overlapping display metadata from `src/engine/inspector.ts:60–285`, uses plain local JSON usage, and exposes only plan/approval summary, **not** session handles or private workspace paths. `DiffDto` is the tagged union of the current bounded task/live/wave response bodies in `ui/server/diff.ts:93–113,148–165,210–227` plus observed timestamp. `SourcesDto` = current four capped file views in `ui/server/sources.ts:29–53`; `StatusDto` = host-safe status and role/preflight display facts, not raw env/config objects. Expose narrow named functions implementing `CoreReaderV2`, a `READ_CONTRACT_VERSION=2` constant and DTO **types**, not generic `.readFile`, `openProjectHarness`, `initProject`, SQL, `exec`, or a mutable client. Server owns HTTP/auth/jobs; core owns CLI facts, storage windows and validated evidence reads.

**Observer coherence:** `status.json` remains private. `planFacts` (the `LivePlan` object above) cohabits that single atomic file; it is not a transaction with SQLite or the JSONL tail. On lock contention report *last observed*, not current durable state. On version/revision/seq mismatch omit incompatible joins and prohibit approval. `StatusDto` adds safe role/config/sleep fields to bounded status. Summaries expose IDs/validated flags/counts only, never collect a raw verifier conversation while live. The view can be stale even when the last state says `running`.

**Migration / fallback rules.** Before mutating old state: owner stops all processes, uses SQLite's online backup or copies the closed DB with its side files and retained Git objects/`.orch` evidence; no deletion. Maintain `defineDoc` **kind**; bump RouterDoc and RunStatusDoc definitions and payload version from 1 to 2 using the pinned pure `migrate(value,fromVersion)`. Old docs/read-only views preserve historical task statuses/rows as *legacy, unproven*, never synthesize UUIDs, acceptance, rollback, spend or delivery receipts from markdown/status/log prose. Mutating run on old non-empty plans refuses: reconcile any old operator changes manually, commit intended base, `plan` again, review and grant; no retroactive `done`, no automatic redo. Empty old stores may plan immediately. Replan archives prior plan/receipt references, clears grant/checkpoint/sleep only after effects fenced; **does not reset cumulative storage spend**. Unknown future schema refuses mutation. Old side-cars remain readable with unknown fields; legacy file names/history are never interpreted as evidence for a new revision. Version new artifact names by revision and wave (flat safe filenames under `artifacts/`); historical aliases read only for legacy reports. Keep old `gate-decisions.json` and JS finding identities; legacy assessment files read as a single unattributed historical observation if present; no invented history. Never silently `init` over old configs. Downgrade after v2 writes requires restoring the backup, not running an older writer.

## Section 4: Phased Implementation Roadmap (DAG for Smaller Models)

**M1 onwards:** read and follow [the packet execution contract](IMPLEMENTATION.md)
before dispatch. Its obligation map, boundary tests, effect/recovery table,
per-packet evidence file and review-before-advancement rule are mandatory.
M0 merged through `0648037`; this records history, not blanket certification of
all §2/§3 invariants. Audit inherited boundaries touched by a packet and block
on an unimplemented prerequisite instead of treating a green suite as proof.

Read the applicable sheet as part of this section. Each bold **ID & Title** starts one dispatch. Use numeric milestone/packet order as the default dispatch order; begin new work at **M1-P01** (M0 is historical). Dependency fields name earlier prerequisites; inherit their proofs transitively. Do not dispatch dependent work on red/missing packet acceptance. One packet at a time, no concurrent changes even where the dependency graph would allow them. M0 is a **hard merge/release gate** before M1–M4. Packets preparing internal helpers do not advertise unconnected behavior. Historical changelog entries remain historical. Record shipped doc/default changes in the packet that switches them on, not just in the final audit.

| Milestone | Packet sheet | Exit condition |
|---|---|---|
| M0 | [Soundness and recovery](M0.md) | Actual demo output, exact grant, candidate-specific review, A→B in all modes, recoverable effects, governor and human resolution |
| M1 | [Containment](M1.md) | No production host fallback; each enabled tier passes the same real negative-permission controls |
| M2 | [Cache, cost, routing, provenance and telemetry](M2.md) | Measured deltas and reproducible offline policy report; no observer affects decisions |
| M3 | [Brownfield and greenfield](M3.md) | Mixed JS/Go evidence and consent; bootstrapped CLI passes an actual separately run smoke gate |
| M4 | [Read contract and parity audit](M4.md) | Locked side-car truth; package-only consumer and automated doc/template checks |

For **every** packet: read `AGENTS.md`, `docs/api-map.md`, `src/engine/kit.ts`, `src/engine/harness.ts`, this file's relevant ADRs/types, the indicated paths and their tests; for UI targets also `ui/PRD.md` and `ui/CHANGELOG.md`. Commands run from repo root with dependencies installed, Node >=22.19 (use Node 24 for reproducible CI). Brace lists in **Target Paths** mean exactly the listed alternatives, not a whole directory. New named paths may be created. `npm test -- test/x.test.ts` is the repo's `vitest run`; `npm run typecheck` runs `tsc -p tsconfig.json --noEmit`. No network/API keys for default tests. After M1-P05, built-CLI positive execution tests (including UI `test:e2e`) require a provisioned, certified backend; run the local release lane with `KIT_TEST_BACKEND=local`. Ordinary CI runs the deterministic unit/in-process fixture tests and unprovisioned production-CLI refusal tests. No test env var may grant a production host execution path. Check the packet's doc/template criterion alongside its targeted tests. No modifying tests merely to hide a change in guarantees. Do not touch the user's untracked roadmap or commit without an explicit order.

## Section 5: Risks, Unknowns & Pre-Execution Spikes

Record each spike's tested versions/host, reproduction command, observed result and go/no-go before its consumer. Gates: storage before M0-P02/P04, Git before M0-P09/P12/P13, governor before M0-P16/P17, guest before M1-P02/P03, each optional adapter before advertising its tier, cache before M2-P01/P02/P03, exporter before M2-P09 and pack before M4-P03. Use disposable spike environments; this plan contains no certification receipts. Time-box each to a half day except platform certification (one day per supported host). Use disposable projects, synthetic credentials and local mocks. Do not hand a small model “figure it out while implementing”. If a required proof fails, **block that packet/tier**, preserve diagnostic evidence, return to the architect; do not downgrade a guarantee.

| Before | Spike and concrete pass/stop evidence |
|---|---|
| M0 state/approval | On installed `@earendil-works/pi-durable@1.5.0`, inspect `dist/documents.d.ts:35–38` and exercise old tokens → pure migration, read-only viewer and recovery-open behavior. Seed SQLite with v1 approved/in-progress data; read without scheduling, reopen for mutation, crash after each intent. Require no tool/model execution before validating the current grant. `HarnessOptions.readOnly` exists (`dist/harness/types.d.ts:669ff`); if the storage open/migration itself writes on a read, serve side-cars instead of mutating for a view. |
| M0 workspace / delivery | Disposable Git repo with staged/unstaged/untracked/ignored files, deletes, binary/mode changes, odd filenames, hostile project hook/filter *canaries*. Prove zero operator HEAD/index/workfile mutation, no host callback; ledger OIDs survive `git gc --prune=now`. Interrupt before and after Git CAS and after mocked push/PR creation. Reopen: exactly one effect or explicit recovery-required. Simulate a moved/deleted PR base; do not choose a new base. Test no-root/worktree-pointer assumptions. |
| M0 governor | Check scheduler recovery, conversation/request idempotency, sleep create+record in one transaction, read-only observers not waking jobs. Fake clock + injected prices show stops before repair/primary/skeptic and a restart at pending skeptic without a second primary. In a multi-turn verifier, check fresh spend before every kit-visible `streamSimple`/`completeSimple` call; test interrupted retries. Prove these admission reads happen outside the session commit line and denial cannot turn into a verdict or a provider retry storm. Measure which charges are invisible (provider transport, Jev, remote VM); document exclusions. |
| M1 local and guest protocol | `command -v bwrap` isn't proof. Require a delegated cgroup-v2 subtree with `cgroup.kill`/empty-population proof as well as working namespaces. On the certification host run the real built-in read/write/edit/bash and real gate/probe on a sanitized fixture; negative canaries for host-only file/env/socket/network, symlink/ancestor replacement, timeout/orphan, spill/temp paths, and read-only candidate. Verify PID visible in `.orch/lock` is host CLI. Pinned `pi-durable/dist/env/index.d.ts:166–305` includes far more than `exec`; `dist/harness/types.d.ts:608–633` supplies conversationId + document reader. Validate binary reader and cancellation against actual tools. No live exploit/attack corpus needed. |
| M1 VM/remote | Pinned Gondolin `0.14.0` / `@daytonaio/sdk@0.232.0` in **separate adapter packages**, pin transitive lockfiles; check native arch, no network by default, RO mounts/identity, orphan fencing, immutable image digest and bounded import/export. Measure cold/warm p50/p95 over 20 no-op leases, 100 small reads, one representative gate; report preparation/transfer separately. Offline CI uses protocol fakes; real VM canaries mandatory on advertised hosts; remote release certification is owner-run against approved disposable infrastructure, never a default CI dependency. No cloud account = remote adapter unavailable, not simulated certification. |
| M2 caching/valuation | Pinned `pi-ai/dist/providers/model-schema.d.ts:10` supports `none|short|long`; Anthropic maps supported `long` to `1h` (`dist/api/anthropic-messages.js:24–42`); OpenAI retention can mean **24h**. Generation checkpoints `settings.stream`; compaction explicitly overrides retention to `none` (`pi-durable/dist/harness/compaction.js:119–140`). Capture serialized provider requests using synthetic auth and intercepted/local transport, compare static portions across two tasks, dynamic tails and reset boundaries. Confirm model catalog entry and TTL capability for every shipped route. No provider API call or promised cross-conversation hit. `pi-ai/dist/types.d.ts:285–312` defines write1h as subset; `pi-durable/dist/harness/usage.js:24–39` accumulates it but does **not** establish mixed provenance. Test split missing/zero/mixed/error, synthetic negative savings, crash-reconciled deltas; stop dispatch on unexplained ledger mismatch. |
| M2 telemetry | Use built-in `fetch` in exporter only; test an OTLP/HTTP JSON request against local mock collector (trace/span ID formats, nanosecond strings, numeric attrs), full disk, collector hung/offline and queue overflow. Compare authority-state digests with telemetry off. Zero new root runtime deps. No signal that a collector was reachable is required for a run. |
| M3–M4 packaging | Pack core with `npm pack` and install in an empty offline temp app; `smol-toml` currently sits in devDependencies despite runtime imports, and TS uses `.ts` specifiers. Prove JS and `.d.ts` resolve under NodeNext, CLI can find templates, and a UI consumer can run without reaching a sibling `src/` or pulling UI deps into core. Audit side-car payload size/stale/missing cases and compare an idle and locked snapshot from the same revision. |

No comparative model-quality, savings, latency or production isolation result is asserted by this plan. Those are outputs of the specified tests and certifications.

# Packet execution contract — M1 onwards

This is a normative supplement to README.md §4 and every M1–M4 packet,
not permission to implement later packets. It exists because green M0 tests
missed boundary ordering, incomplete pricing and crash-window failures.
M0 and its post-review fixes are history, not proof that every inherited
requirement is implemented. Do not modify roadmap ideas or weaken guarantees.

## One dispatch, bounded steps

Implement ONE packet per session. If it does not fit, stop at a named internal
step with a self-contained handoff; do not declare the packet complete or start
its successor. Preparation, wiring and certification are distinct deliverables.
Use this order within each packet:

1. **Map:** inspect status and current symbols, then record each Specification,
   EARS, documentation and non-goal obligation with its owning function/caller,
   planned negative test, and verification command. Include every production
   caller, not only the helper. Missing target path/API/spike = stop and request
   a specification amendment, never invent a replacement or quietly omit it.
2. **Prove the boundary:** add focused regression tests and observe the expected
   failure before changing behavior. Existing coverage can be cited rather than
   duplicated. For a new private module, prove its contract before wiring it.
3. **Wire:** enumerate the real CLI/UI/driver paths that now invoke it. A helper
   passing in isolation is not a cutover. Keep one implementation of each
   decision; no parallel budget client, scope matcher or recovery driver.
4. **Attack the transition:** exercise the applicable cases below through the
   public caller, including close/reopen with durable state retained. Tests must
   assert forbidden effects did NOT happen, not only that an error was returned.
5. **Close:** update the packet's operator docs/templates, run its targeted
   commands, and inspect the diff against strict paths/non-goals. Before marking
   the packet complete run core typecheck/build/tests and diff check, plus UI
   typecheck/check/tests when UI code or seam behavior changed. Run required real
   lanes only on qualified hosts; record unavailable lanes as BLOCKED, not green.
   Full release lanes remain required at cutover/milestone exits. Do not rerun
   unchanged known-green baselines merely for narration.

## Evidence and advancement

Each packet additionally authorizes ONLY its own
`docs/engineering-plan/evidence/<packet-id>.md` (for example `M1-P01.md`).
This is implementation evidence, never runtime authority or a certification
flag read by the program. Write it incrementally; do not fabricate prior results.
Use these fields:

- base commit and packet/step; current diff paths;
- obligation → production entry/call site → test/assertion → observed result;
- effect ordering/recovery table when applicable;
- commands, exit outcomes and environment/pins for required real lanes;
- docs/templates changed; explicit deferred behavior and remaining blockers;
- disposition: PREPARED / BLOCKED / READY FOR REVIEW (not self-certified release).

Tests green + review-ready are necessary, not sufficient. A reviewer must check
scope, caller completeness and the effect table before advancing. If no separate
reviewer is available, stop at READY FOR REVIEW and request review rather than
inventing approval. An implementation handoff names the next internal step or
packet, constraints and exact checks; it ends with NEXT PROMPT per AGENTS.md.
No commit/push without the operator's explicit request.

## Required adversarial cases (apply by obligation, not cargo-cult)

| Boundary | Required cases and observations |
| --- | --- |
| Authority | missing/stale revision, wrong task/lease/role/session, empty scope, dependency outside grant, mirror edit; zero model/tool/remote calls and unchanged grant on refusal |
| Controls and destination | change HEAD, actual PRD, a non-recipe eval script, recipe, verification/delivery/routing/sandbox policy or enrolled destination after review; refuse new work, reconcile recorded effects only with their original identity; raising only sessionUsd may resume |
| Safe reads/import | leaf AND ancestor symlink, dangling link, replacement during read, directory/FIFO, unreadable/malformed, size/count boundary and overflow; no outside bytes disclosed, no partial-success import; ENOENT alone means absent |
| Costs | each used class missing/zero/positive independently, exact ceiling and zero ceiling, mixed provenance and unpriced residual, tool follow-up/retry/compaction; unknown never becomes free; stop never becomes reject |
| Lease lifecycle | journal before launch, crash before/after launch/attach, timeout, controller death, reopen, fence failure; no project exec before ownership, no import before verified fence, no dependent work on uncertain recovery |
| Effects | before/after every durable intent, attempt marker, external effect and result receipt; include receipt-write failure, response loss, changed/deleted/conflicting target; same key/OID or explicit recovery-required, never duplicate or redirected effect |
| Production versus fixtures | built CLI with no backend, KIT_FAUX, KIT_TEST_BACKEND and hostile env; inference fakes never grant host execution; constructor-only adapters absent from CLI selection |
| Observation | held lock, absent/legacy/capped/mismatched revision/sequence; zero scheduling/writes, no fabricated empty/zero/success, no approval from degraded facts |

For each external effect write a table BEFORE coding:
`durable phase | observed resource | allowed next action | forbidden action`.
Distinguish not-attempted, may-have-run, confirmed and conflict; an intent alone
is not proof an effect occurred. A pre-attempt crash must either safely retry the
same bounded effect or explicitly remain recovery-required with an operator
remedy. Do not claim automatic recovery for an intentionally ambiguous window.
An extra attempt marker does not make SQLite and the external system atomic.

## Invariants inherited from M0

- Binding is to actual immutable bytes/settings, not a digest attached to
  unrelated current or committed files. Snapshot before model disclosure and
  use the same bundle in gates, both review passes and human acceptance.
- Every new wave/pass/dispatch requires current authority and cost admission.
  Reconciliation may acknowledge already-recorded effects after inputs change,
  but must not fall through into a fresh retry wave, another model call or a
  new destination. Check at the actual effect boundary, not only loop entry.
- New plans cannot strand leases, pending submissions or effects. Check latest
  state, not just task color. Preserve monotone waves, usage and old receipts.
- Only genuine absent inputs are absent. Permission/parse/cap/unsafe-path errors
  refuse. Do not read first and validate after model submission. Static
  realpath/lstat checks are not a concurrent no-follow security boundary.
- Pricing uses presence tests, not truthiness: explicit zero is a tariff;
  missing price for a nonzero class is unknown. Faux zero is explicitly
  simulated and must not leak to real providers or suppress injected tariffs.
- Receipt failure for an authoritative effect is blocking; display/telemetry
  failure is best-effort. A catch-all returning empty/success is not recovery.

## Block rather than guess

An inherited spec gap discovered while implementing is a blocker to that path,
not authorization for a broad engine rewrite. Record exact evidence and proposed
owning packet/strict paths. Ask for amendment if outside this packet. Unsupported
platforms/adapters remain unavailable. No live-model, live-PR, savings, latency or
containment claim may be inferred from mocks. Real backend measurements must be
explicitly labeled with host, pin and method, never generalized benchmarks.

### Active packet — M1-P03: S1 implemented; launcher/certification still blocked

As of 2026-11-26, P03's standalone helper ABI/stdio adapter has a bounded
implementation in `src/sandbox/guest-helper-main.ts`, but no production launcher
uses it. A disposable Linux `clone3(CLONE_INTO_CGROUP)` canary proved kernel
placement into the exact UUID-named delegated child before the child ran; the
same child was killed through `cgroup.kill` and the child reported `populated 0`.
Production wiring is still blocked: Node has no syscall interface in this
implementation, and there is no reviewed native launcher asset or P01 selection
for one. `LinuxCgroupOps.writePid()` remains an unsuitable post-spawn move. The
transient user-systemd scope canary also remains unsuitable because its scope
was outside the delegated subtree. Fixture creation remains blocked until
operator-provisioned offline runtime assets and reviewed exact inventory values
are available. Import wiring remains blocked until the complete fenced scan,
host-only durable seal, destination identity, and atomic result
visibility/recovery mechanism are proved. Existing Git object/ref primitives
are reusable candidates, but no P03 importer/receipt currently binds them to
the lease journal. See
`docs/engineering-plan/evidence/M1-P03.md` for the obligation map and effect
ordering. These are blockers, not permission to substitute timing, guessed
pins, or a different destination contract.

Bounded follow-up (2026-11-26): interrupted `fencing` is now retryable;
reopened `fenced` state/import admission require fresh cgroup observation and
persist recovery-required on uncertainty. Journal decoding checks UUID-child
binding and imported receipt shape. Complete manifest validation now uses one
canonical ordering, rejects implicit-directory/name collisions and enforces
non-raiseable bounds. Pure full-delta validation reuses the existing scope
matcher for additions/deletions/content/mode changes. These close offline
preparation gaps only: complete filesystem scan, writer exclusion, durable seal
and result publication remain unimplemented. P03-S1 now implements optional
`installation.localLauncher` through the existing P01 types, strict profile
parser, descriptor and `requireTrustedTool` validation. It has no default or
fallback, is checked only on use, receives no dev-in-kit exception, and is bound
by the descriptor digest. This is selection trust only: it does not prove
artifact bytes or launch anything. Enrolled assets remain absent. P03
certification is still BLOCKED; no production cutover or real certification.
Current verification is at the top of `evidence/M1-P03.md`.

**Operator decision (2026-11-26):** use a kit-owned Rust clone3 launcher (Rust
build-toolchain prerequisite accepted), versioned complete bundles with explicit
setup/offline execution, existing private candidate refs plus CAS/receipt recovery,
and D1 review-before-host-changes. M1.md P03 and README §§2–3 now record the
approved narrow strict-path/schema extension. No further design approval is
needed for these directions. Do not ask the next agent to rediscover the choice.
No Rust install, bundle download/enrollment or profile change is authorized until
exact assets/provenance/pins/paths/commands have been presented and approved.

**Active slice: P03-S2 only.** The standalone Rust launcher, reviewed ABI and
offline build/canary sources live under `sandbox/local/`. Use P03 evidence for
the actual compiler/build and real-lane disposition. D1 still gates exact
host setup. The current slice has no bundle enrollment, scan/seal/import,
production wiring or containment certification.

Then S2 proves the Rust launcher/build/ABI; S3 implements versioned bundle
inventory/provisioning and offline fixture; S4 proves full scan/seal/private-ref
recovery; S5 wires/certifies local. Each remains bounded by M1.md P03; packet
closure still needs real conformance and reviewer acceptance.

# Linux local sandbox — setup and implementation status

**Approved product design; not yet a shipped/certified backend.** The current
loop still executes project tools/gates/probes on the host. Use trusted projects
and fixtures only. No bundle release, Rust launcher build script, provisioning
script, fixture builder or runnable setup command exists yet. This document is
an operator/implementation contract, not installation instructions that already
work. The local adapter stays non-default until M1-P05.

## Approved choices (2026-11-26)

- A kit-owned **Rust launcher**, separate from the JS guest helper, uses Linux
  `clone3(CLONE_INTO_CGROUP)` to place a child in the exact already-journaled
  cgroup-v2 lease before executable/project instructions can run. No spawn-then-
  move, PID-only fence or systemd scope substitution. On owner loss/timeout,
  kill the exact cgroup and verify `populated 0`; never trust guest fence claims.
- **Versioned complete toolchain bundles** are the supported setup direction,
  rather than rebuilding from arbitrary host installations. Cover host launcher
  and selected bwrap identity, guest Node/rootfs/ABI/loader/libraries, fixed helper
  plus full imports, shell/utilities and dependencies/locks. Do not expose host-
  only launcher/bwrap to the guest. Project-specific dependencies are separate
  reviewed prebuilt bundles; never execute project setup hooks on the host.
- Reuse the existing private candidate Git ref with **create-only CAS and durable
  receipt reconciliation** after host-fenced full scan/seal. No partial import
  into the checkout, alternate result store or integration/delivery rewrite.
- **D1, review before host changes:** prepare exact inputs and commands first;
  obtain approval before compiler setup, downloads, installs, bundle enrollment
  or host-profile edits. Accepting Rust as a prerequisite is not permission to
  run rustup or a privileged installer now. Session authority is for this
  development host only; this provisioning model applies to all local operators.

## Setup/build/run separation

Planned source-build module: `launcher/` with Cargo.toml, actual Cargo.lock,
rust-toolchain.toml and Rust sources/tests. Pin an exact reviewed compiler/target
and minimal syscall dependencies independently of npm. Explain/minimize unsafe
code; Rust does not prove correct FDs, process ownership or recovery ordering.
`build-launcher.sh` will be an explicit offline build from reviewed locked inputs,
not an npm/worker hook. Maintainers/source builders need Rust/Cargo; ordinary
users should obtain the verified prebuilt launcher. Linux x86_64 is the first
qualification target; other hosts/architectures remain unavailable until proved.

Planned `bundle-format.md` defines canonical inventory/provenance without a
self-referential digest. Existing `toolchains.*.manifestSha256` remains its trust
anchor. Actual compiler/Node versions, artifact hashes and dependency closure
are not selected by this document. Host Node v24.18.0 is an observation, not a
bundle pin. Local hashes establish content identity, not vendor authenticity.

Planned `provision-toolchain.sh` will separate preparation from approved host
installation. Explicit operator setup may acquire named assets only from reviewed
sources with independent authenticity checks, or accept an offline supplied bundle.
Safe bounded archive/path/type/size handling and complete private staging must
precede installation; never execute unverified content, project hooks or curl-
pipe-shell. No inherited credential/env selection or unreviewed redirect authority.
This docs checkpoint performs none of those operations.

Planned `make-fixture-rootfs.sh` consumes explicitly selected trusted installed
inputs and stays offline. Worker launch, recovery and ordinary project runs may
not download, compile, install dependencies or silently select another version.
Install versions side-by-side; selection is explicit, old referenced bundles stay
available for recovery, and interrupted/failed setup never admits a partial bundle.
There is no automatic upgrade/overwrite/GC or project-config installation path.

Before setup approval, present:

- exact compiler/target/dependency and bundle versions;
- asset sources, authenticity method and measured canonical inventory/hashes;
- safe absolute installation destinations outside the target and their modes;
- literal build/install commands and any requested privileges;
- exact proposed host-profile diff and how existing selections are preserved.

The planned optional profile key `installation.localLauncher` has **no default**
and is **not accepted by the current parser**. P03-S1 adds it through the existing
P01 resolver/per-use validator; do not enroll it yet. Do not expand P01's CLI/UI
in-target exception, allow symlinks or relax ownership/mode checks. This key is
not `installation.helper` or `installation.bwrap`; each has its own identity.
Artifact bytes must also match the reviewed inventory before project admission.

## Result publication contract

After exact-cgroup fencing, exclude reattachment and all other projection writers;
scan the full projection using bounded descriptor-relative no-follow reads. Derive
all additions/deletions/content/mode changes before filtering; protected/scope/
ignored-output/scratch-masking violations refuse with no visible result change.
Hidden base inputs are not deletions. Existing pure manifest/delta validation is
not this scanner and is not a durable seal.

Retain validated host-only sealed bytes bound to lease/base/controls/projection
before import intent. Record the exact destination, expected ref state, seal digest
and tree OID before effects. Construct the tree privately and create-only CAS:

`refs/kit/<planRevision>/tasks/<taskId>/leases/<leaseId>/candidate`

Only identical retained bytes/bindings and the same observed OID can reconcile a
lost result receipt. Conflict or ambiguous/missing post-attempt refs block recovery;
no changed destination, guest rerun or blind recreation. Git ref publication and
the journal receipt are separate ordered durable effects, not a cross-store
transaction. Accepted integration/delivery refs retain their existing owners.

## Implementation dispatch

Authoritative strict paths/acceptance are in
[`docs/engineering-plan/M1.md`](../../docs/engineering-plan/M1.md), P03 amendment.

| Slice | Work | Current state |
| --- | --- | --- |
| S1 | Optional localLauncher parser/types/resolver selection and refusal/digest tests | **Ready to implement now** with Node tooling; no Rust/asset prerequisite |
| S2 | Rust crate/build inputs/fixed argv-FD-status ABI and real placement/FD/owner-loss proofs | Approved design; compiler/host setup waits for D1 |
| S3 | Bundle format/provenance/approval/install separation and offline fixture | Approved design; exact pins/assets not enrolled |
| S4 | Full scan/writer exclusion/durable seal/private candidate-ref recovery | Pure inventory/delta preparation only |
| S5 | local.ts public lease wiring, in-namespace checks and real conformance | Not implemented; not certified |

Existing helper ABI, lifecycle and manifest fixtures do not prove host containment.
S1 does not execute native code, add runtime npm dependencies, select production
backends or change the SDK/readout seam. Ordinary core tests must remain offline.

Current preparation verification:

```bash
npm run typecheck
npm run build
npm test -- test/local-sandbox.test.ts test/host-paths.test.ts test/trusted-exec.test.ts
npm test
git diff --check
```

Future required real lane, **not runnable until its files/assets/prerequisites
exist**:

```bash
bash sandbox/local/make-fixture-rootfs.sh
KIT_TEST_BACKEND=local npm test -- test/sandbox-conformance.test.ts
```

A missing namespace/cgroup/clone3 capability or artifact in the explicit real lane
must fail, not skip or report certification. Bubblewrap uses positive binds only,
isolated network/PID/IPC, dropped capabilities, minimal devices/proc, read-only
controls and read-only role views; shared-kernel limits remain. P03 closure needs
real conformance and reviewer acceptance before dependent P04/P05 advancement.

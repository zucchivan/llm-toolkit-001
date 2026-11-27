# Linux local sandbox — setup and implementation status

**Approved product design; not yet a shipped/certified backend.** The current
loop still executes project tools/gates/probes on the host. Use trusted projects
and fixtures only. The S2 native source and offline build script are present.
The versioned bundle, fixture builder and production adapter are later slices.
The local adapter stays non-default until M1-P05.

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

The standalone source-build module is `launcher/` with Cargo.toml, Cargo.lock,
rust-toolchain.toml and Rust sources/tests. Pin an exact reviewed compiler/target
and minimal syscall dependencies independently of npm. Explain/minimize unsafe
code; Rust does not prove correct FDs, process ownership or recovery ordering.
`build-launcher.sh` performs an explicit offline build from reviewed locked inputs,
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

## S2 compiler and reproducible build

S2 uses the official signed standalone Rust 1.100.0 x86_64 GNU distribution and
exactly `libc 0.2.189` from crates.io. The compiler is a build input. The native
binary is staged here for verification, and S3 owns enrollment and any live
host-profile edit. An approved offline copy of the same inputs works as well.

| Input | Reviewed source and identity |
| --- | --- |
| Standalone archive | [Rust 1.100.0 distribution manifest](https://static.rust-lang.org/dist/channel-rust-1.100.0.toml), SHA-256 `98ee6bec240e1cfe944f17e7092412dc5ef6e008484bb668c6936d35a7d15acd` |
| Detached signature and public key | [Rust Forge signing guidance](https://forge.rust-lang.org/infra/other-installation-methods.html), primary fingerprint `108F66205EAEB0AAA8DD5E1C85AB96E6FA1BE5FE` |
| Syscall dependency | [crates.io sparse index](https://index.crates.io/li/bc/libc), SHA-256 `3eaf3ede3fee6db1a4c2ee091bf8a8b4dccdc6d17f656fb07896ee72867612f2` |

After D1 approval for the exact paths and commands, an operator can stage the
inputs under a private directory outside the checkout. The following Bash
session uses no elevated privileges. The temporary GPG keyring has only the
verified release key. All compiler and crate acquisition occurs in this step.

```bash
set -euo pipefail
umask 077
stage=$(mktemp -d /tmp/kit-p03-s2.XXXXXXXX)
mkdir -m 700 "$stage/gnupg" "$stage/compiler" "$stage/build"
archive=rust-1.100.0-x86_64-unknown-linux-gnu.tar.xz
dist=https://static.rust-lang.org/dist/2026-11-12
curl --proto '=https' --tlsv1.2 -fsS "$dist/$archive" -o "$stage/$archive"
curl --proto '=https' --tlsv1.2 -fsS "$dist/$archive.asc" -o "$stage/$archive.asc"
curl --proto '=https' --tlsv1.2 -fsS https://static.rust-lang.org/rust-key.gpg.ascii -o "$stage/rust-key.asc"
curl --proto '=https' --tlsv1.2 -fsS https://static.crates.io/crates/libc/libc-0.2.189.crate -o "$stage/libc-0.2.189.crate"
(
    cd "$stage"
    printf '%s  %s\n' 98ee6bec240e1cfe944f17e7092412dc5ef6e008484bb668c6936d35a7d15acd "$archive" | sha256sum --check
    printf '%s  %s\n' 3eaf3ede3fee6db1a4c2ee091bf8a8b4dccdc6d17f656fb07896ee72867612f2 libc-0.2.189.crate | sha256sum --check
)
fingerprint=$(gpg --homedir "$stage/gnupg" --batch --with-colons --show-keys "$stage/rust-key.asc" |
    awk -F: '$1 == "pub" { primary=1; next } primary && $1 == "fpr" { print $10; primary=0 }')
test "$fingerprint" = 108F66205EAEB0AAA8DD5E1C85AB96E6FA1BE5FE
gpg --homedir "$stage/gnupg" --batch --import "$stage/rust-key.asc"
gpg --homedir "$stage/gnupg" --batch --verify "$stage/$archive.asc" "$stage/$archive"
tar -xJf "$stage/$archive" --no-same-owner --no-same-permissions -C "$stage/compiler"
env -i PATH=/usr/bin:/bin LC_ALL=C "$stage/compiler/${archive%.tar.xz}/install.sh" \
    --prefix="$stage/toolchain" --disable-ldconfig \
    --components=rustc,cargo,rust-std-x86_64-unknown-linux-gnu
bash sandbox/local/build-launcher.sh "$stage/toolchain" "$stage/libc-0.2.189.crate" "$stage/build"
```

The offline script rechecks the crate bytes, pins the compiler, isolates Cargo
configuration, records the GNU linker/compiler and glibc baseline, runs locked
tests, compares two clean release builds byte for byte, and prints their
digests. The build script has no acquisition path. Its output is development
evidence for the recorded build inputs and host. It is not a bundle release.

## S2 fixed host-launcher ABI

The trusted host selects the launcher and Bubblewrap and constructs the entire
argv with literal tokens. It starts with the following fixed forms.

```text
kit-local-launcher --protocol=1 --cgroup-fd=3 --gate-fd=6 -- <selected-absolute-bwrap> <host-built-bwrap-argv...>
kit-local-launcher --protocol=1 --cgroup-fd=3 --gate-fd=6 --fence
```

| FD | Launch use |
| --- | --- |
| 0–2 | Bubblewrap and helper stdin/stdout (bounded P02 RPC) and bounded diagnostics on stderr. The launcher parent closes its copies after placement. |
| 3 | Open exact journaled direct-child cgroup-v2 directory. Never passed through to Bubblewrap. |
| 4 | Launcher-only writable pipe or connected Unix stream for status. The host parses the byte stream and enforces the grammar below. |
| 5 | Launcher-only readable pipe or connected Unix stream with one controller peer. The channel carries no payload. EOF, unexpected data, or any error denotes owner loss. |
| 6 | Private single-use gate file opened read/write with append mode disabled. It is also supplied with FD 3 for `--fence`. |

The controller owns a stable delegated parent and records its boot, delegation,
lease cgroup and gate identities before invoking the launcher. It must resolve
the cgroup and its gate from those retained identities, including on reopen with another
controller. An unavailable or substituted parent, cgroup or gate requires
recovery. The normal adapter must supply a sanitized launcher environment and
enforce approved artifact bytes. S2 has no production caller.

The gate is an operator-owned mode-0600, 24-byte regular file with one hard
link. Its record is magic `KLG1`, state byte (1 ready, 2 spent, 3 revoked),
three zero bytes, and little-endian 64-bit cgroup device and inode numbers.
The host creates, binds and durably records the gate once per lease. Both
launch and fence use a process-associated kernel lock on the same gate inode.
The launcher checks the cgroup identity and filesystem, consumes the gate
durably, checks that the exact lease cgroup is an empty domain with a writable
kill control,
checks controller/status liveness, then performs
`clone3(CLONE_INTO_CGROUP)` under the lock. A cgroup cannot be rearmed or
substituted on recovery. Bubblewrap is the immediate child, receives a clean
environment and inherits only the specified standard streams. Workload
processes need separate stdio and must be unable to obtain helper control
handles. Host namespace/resource checks and the matching P02 helper handshake
are still required before project admission.

FD 4 carries at most two 16-byte `KLS1` records. Byte 4 is version 1, byte 5
is the event, bytes 6–7 are zero, bytes 8–11 are the little-endian PID and
bytes 12–15 carry a signed little-endian detail. The legal forms are:

- Pre-clone refusal after status setup can emit only `launch-error` (3),
  PID zero and positive errno. Bad argv or unusable channels can fail without
  any records.
- `placed` (1), PID greater than 1 and detail zero, followed by one
  same-PID terminal record. `exited` (2) carries an exit code, `launch-error`
  (3) carries a positive errno for child startup failure, and `signaled` (4)
  carries a signal number. The private close-on-exec error pipe can report
  child setup/exec failure. Empty error-pipe EOF does not establish readiness.
- Unknown events, invalid fields, a PID mismatch, extra data, early EOF, or an
  inoperable channel deny admission and require exact-lease recovery.

When the child terminates or the launcher detects controller/status loss, the
launcher revokes permission under the same lock before issuing
`cgroup.kill` and observing `populated 0`. A fresh controller uses
`--fence` after launcher loss, with the same FD 3 and FD 6 bindings. This
operation returns success only after revocation and empty observation. A
failure with uncertain state must remain recovery-required. The future
adapter independently verifies the fence before scanning or import.
Keep the fresh cgroup free of kill writes before launch. On affected Linux
kernels a pre-launch write advances its kill sequence and can kill the first
clone. See the [upstream kernel fix](https://kernel.googlesource.com/pub/scm/linux/kernel/git/tip/tip/+/8e359920216689b3b79e0fe8961a77fe312a511f).

For S2 native tests, the ordinary locked Cargo run checks ABI refusal. An
explicit lane passes the path to a stable, already delegated cgroup-v2 parent
and runs the ignored native integration tests. Missing delegation, clone3 or
fencing capabilities fail that lane. The real tests use disposable children
of the supplied parent and a synthetic probe; they precede the S5
Bubblewrap/guest conformance lane. Use the native test executable printed by
the successful build and supply the approved delegation explicitly.

```bash
test_dir="$stage/build/tests/target/x86_64-unknown-linux-gnu/debug"
mapfile -d '' native_tests < <(find "$test_dir" -type f -executable -name 'launcher-*' -print0)
test "${#native_tests[@]}" -eq 1
KIT_S2_REAL_CGROUP_PARENT='/sys/fs/cgroup/<approved-delegated-parent>' \
    "${native_tests[0]}" --ignored --test-threads=1
```

The optional `installation.localLauncher` selection has no default and uses
the existing P01 resolver. S2 leaves the live profile alone and S3/S5 retain
byte identity and use-time verification.

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
| S1 | Optional localLauncher parser/types/resolver selection and refusal/digest tests | **Implemented** with Node tooling; no Rust/asset prerequisite |
| S2 | Rust crate/build inputs/fixed argv-FD-status ABI and real placement/FD/owner-loss proofs | Locked build and six real native canaries passed on the development host. [Evidence](../../docs/engineering-plan/evidence/M1-P03.md#s2-merge-review-verification-2026-11-27). |
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

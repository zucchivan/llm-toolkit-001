# Linux local toolchain bundle format, schema 1

A bundle pins a release and its complete host and guest file inventories.
Select an exact `bundleVersion` and obtain the reviewed `manifestSha256` from
the operator's trusted selection, using the existing
`toolchains.<id>.manifestSha256` anchor. The digest is SHA-256 over the entire
canonical manifest byte sequence, including its final LF. The manifest has no
self-digest. A digest supplied by the bundle itself has no selection authority.

## Canonical representation

The manifest is compact UTF-8 JSON with one final LF and no BOM. All object
keys are in ascending ASCII order, `sources` is ordered by `id`, and `files`
is ordered by `path`. The format admits printable ASCII strings and
nonnegative integer numbers only. Use the shortest decimal form for numbers,
literal ASCII for string contents except for JSON's required escaping, and
no insignificant whitespace. The schema is closed at every object. Unknown
or duplicate keys, alternate encodings, unsupported schemas and unsupported
ABI values are refused, including when those bytes match a supplied digest.

| Root field | Value |
| --- | --- |
| `abi` | Object with `guest` and `host` both `gnu`, `guestProtocol` and `launcherProtocol` both integer `1`, `guestGlibc` pinning the bundled guest glibc, and `hostMinGlibc` declaring the minimum glibc for the host executables. Both glibc values are decimal `major.minor[.patch]` strings. |
| `bundleVersion` | Exact release in decimal `major.minor.patch` form. Components have 1–9 digits and no leading zeros except for zero itself. The same component rule applies to glibc versions. |
| `files` | Complete list of regular payload files in both namespaces. |
| `platform` | `linux-x64` for both host and guest. |
| `releaseSource` | ID of the independent release provenance record. Its version equals `bundleVersion`. |
| `schemaVersion` | Integer `1`. |
| `sources` | Exact source and authenticity evidence records. |

## Sources and authenticity

A source has `id`, `version`, `uri`, `sha256` and `evidence` fields. An ID
is 1–64 lowercase ASCII letters, digits, dots, underscores or hyphens,
starting with a letter or digit. A version is a digit-led version token
(optionally prefixed by `v`, followed by up to 127 ASCII letters, digits or
`._+~:-`) or a full lowercase 40- or 64-hex commit ID. Use the upstream's
exact version or commit and an immutable source locator. There is no
implicit `latest` selection.

The source digest identifies the source artifact or release record at
`uri`. The release record must be independent of this manifest to avoid
a circular digest. The `evidence` object has `method`, `signer`, `uri` and
`sha256`. Select `signed-release`, `signed-checksums` or `signed-build` and
record the independently reviewed signer identity and the different locator
and digest of the evidence. Signer identifiers use 1–256 characters from
ASCII letters, digits and `._:@+/-`. Both locators are canonical absolute
HTTPS URLs of at most 2,048 printable ASCII bytes with a non-root path and
without credentials, query, fragment or a `latest` path component, including
percent-encoded spellings. All digests are 64 lowercase hex digits. These are provenance metadata for the operator's D1 review. The
offline validator checks their structure and binding to the anchored
manifest. Source and signature acquisition and authenticity verification
belong to the separate setup phase.

## Inventory

Every file has `mode`, `path`, `role`, `sha256`, `size` and `source`.
The source is a declared source ID. The digest covers the exact file bytes,
and `size` is the integer byte count. The mode is encoded as decimal 420
(`0644`) or 493 (`0755`).

| Namespace | Required roles |
| --- | --- |
| `host/` | Exactly one `launcher` and one `bwrap`. Both are host-only and executable. |
| `guest/` | Exactly one executable `node`, `loader` and `shell`, and one `helper` entrypoint. Also include one or more `rootfs` files, `library` files, `helper-import` files and executable `utility` files. |
| `guest/` | Any bundled prebuilt `dependency` file requires an additional `lockfile` field whose path resolves to a declared guest file with role `lockfile`. With no dependency records the bundle declares no prebuilt dependency payload. |

Executable roles require nonempty files with mode `0755`. Every regular
file required by the selected rootfs, runtime, libraries, helper imports,
shell and utilities belongs in the inventory, even when unused by the
fixture. The validator requires the roles and an exact match to a
materialized inventory. Establishing that the selected files give a working
runtime and import closure requires independent review and conformance.
Host launcher and Bubblewrap digests are refused anywhere in the guest
inventory. The host uses its existing trusted executable selection, and
future wiring must bind the selected executable bytes to these host records
without making those paths available in the guest. Project-specific prebuilt
dependency bundles keep their separate review and selection.

Paths are case-sensitive bundle-relative names using ASCII letters, digits
and `._+@/-`. Components are separated by one slash. Empty, dot, dot-dot,
reserved project or platform names, trailing slashes, and case-folding
collisions at any prefix are refused. Directories are implicit. A path
cannot be both a file and a directory. Payloads consist only of regular
files. Symlinks, hardlinks, special files, and special permission bits are
outside the format. An input adapter must enforce these properties and produce
a complete bounded observation before it constructs the in-memory records.

| Limit | Maximum |
| --- | --- |
| Manifest | 4 MiB |
| Source records | 1,024 |
| File records | 16,384 |
| Distinct paths, including directory prefixes | 65,536 |
| Path and component lengths | 512 and 255 ASCII bytes |
| Single file | 256 MiB |
| Combined file bytes | 2 GiB |

## Offline verification boundary

`validateLocalBundle(manifestBytes, assets, selection)` checks the explicit
selection, canonical manifest and inventory before consulting asset
observations. It requires one observation per declared path, in any order.
Each observation consists of `path`, `kind: "file"`, permission `mode` and
the actual file `bytes` as an unshared `Uint8Array`. It rejects an incomplete,
extra or substituted inventory and compares each file's exact type, mode,
size and SHA-256. Successful validation returns the parsed manifest.
Refusals throw before any external effect. The function accepts an
already materialized snapshot and has no file, staging, installation,
execution, network or profile access. The caller owns safe traversal,
retention of verified bytes and use-time binding, including platform and
ABI qualification. No trust in observed files survives a change to the
bytes or their selected installation.

## Offline ustar archive

The preparation script accepts one **uncompressed ustar archive** with no
record padding beyond the required two end blocks. Each entry is a 512-byte
ustar header, the specified byte count, then zero padding to the next 512-byte
boundary. Use magic `ustar\0`, version `00`, and regular-file type byte `0`
(ASCII). Use zero-padded ASCII octal digits with a final NUL in the numeric
fields. The checksum field has six octal digits, a NUL and a space. Calculate
the unsigned byte sum of the header with that field filled with spaces. Device
fields must be all zero bytes or octal zero, and the link name and reserved
bytes must be zero. Text fields use printable ASCII and zero padding when
shorter than their field width. UID, GID, timestamp, user and group fields
carry no authority and are discarded.

Include exactly one root `manifest.json` at mode `0644`, plus every declared
`host/` and `guest/` file at its declared mode, in any order. Paths are taken
from the ustar name (up to 100 bytes) and optional prefix (up to 155 bytes),
joined with a single slash. The resulting names must meet the inventory path
rules. Directories are implicit. The adapter refuses directory records, links,
special files, sparse encodings, GNU and PAX extensions, duplicate and
colliding paths, and trailing bytes after the two zero end blocks.

Pass a descriptor for a stable single-link regular file, opened read-only by
the operator. The script takes that descriptor as standard input. A pipe,
terminal or device is refused. The script receives no archive filename and
does not resolve a source pathname. Select and open the source in trusted
operator context. Intake reads positionally from byte zero without changing
the descriptor's offset, with requests of at most 64 KiB. The caller retains
ownership of the descriptor and should keep the archive unchanged during the
operation. Intake checks the opened file's size, link count and modification
and change timestamps around the read.

Intake caps the archive at the manifest and combined payload byte limits plus
up to 1,023 bytes of header and padding per entry and 1,024 end bytes. It
checks all headers, the path and entry limits, per-entry and aggregate byte
limits, padding and the terminator before materializing file bytes. It checks
the manifest against the separately supplied version and digest and matches
the complete archive layout to the declared inventory before allocating any
payload buffers. `prepareLocalBundle` measures the materialized payloads under
that same selection and writes the verified bytes. Intake only reads from
the archive descriptor.

For the shell invocation and output, see the [setup contract](README.md#setupbuildrun-separation).
On a handled error or SIGINT/SIGTERM during intake or staging, the command exits
without a completed stage receipt and attempts to remove any stage already started.
A hard process exit can leave private residue. Only accept the complete JSON
record from a successful invocation.

## Private offline preparation

`prepareLocalBundle(manifestBytes, assets, selection, signal?)` applies the same
validation to materialized observations. It retains private byte copies and the
explicit version and reviewed digest before any asynchronous filesystem
operation. The schema limits apply to the retained inventory. Callers must
also enforce bounds during materialization. This entrypoint accepts bytes
and file observations, with no archive or filesystem source-path argument.

On Linux it creates a fresh mode-`0700` directory under root-owned sticky
`/tmp`. Payloads are exclusive new regular files at their declared paths and
modes. The canonical `manifest.json` is written last at mode `0600`. The
operation returns the private directory and its selection only after closing
every file. Separate preparations use separate directories, including for
different explicit versions. The receiving caller owns cleanup.

On cancellation or an I/O error the operation attempts to remove its stage
and rejects. A process killed before return may leave a private directory.
Completion exists only in the returned result. Temporary directories and
their manifests must never be discovered or adopted as completed stages.
Preparation provides no durable recovery receipt. Future installation must
bind its own admission to the reviewed selection and measured bytes.

Under D1, present exact sources, authenticity evidence, pins, canonical
destinations, commands, privileges and profile changes for review before
any host setup. Keep installed versions side by side, select a version
explicitly and retain old versions for recovery. See the
[setup contract](README.md) for the separate preparation and install phases.

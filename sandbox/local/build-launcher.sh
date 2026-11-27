#!/bin/bash
set -euo pipefail
umask 077

if (( $# != 3 )); then
    echo "usage: build-launcher.sh VERIFIED_TOOLCHAIN_PREFIX VERIFIED_LIBC_CRATE EMPTY_STAGING_DIRECTORY" >&2
    exit 2
fi
if [[ "$(uname -s -m)" != "Linux x86_64" ]]; then
    echo "the launcher build requires Linux x86_64" >&2
    exit 2
fi

export PATH=/usr/bin:/bin
kit_source=$(realpath -e -- "$(dirname -- "${BASH_SOURCE[0]}")/launcher")
kit_root=$(realpath -e -- "$kit_source/../../..")
toolchain=$(realpath -e -- "$1")
crate=$(realpath -e -- "$2")
staging=$(realpath -e -- "$3")
if [[ ! -d "$staging" || ! -O "$staging" || $(stat -c '%a' "$staging") != 700 ||
      -n "$(find "$staging" -mindepth 1 -maxdepth 1 -print -quit)" ||
      "$staging" == "$kit_root" || "$staging" == "$kit_root/"* ]]; then
    echo "provide an empty, operator-owned mode 0700 staging directory outside the checkout" >&2
    exit 2
fi

target=x86_64-unknown-linux-gnu
cargo="$toolchain/bin/cargo"
rustc="$toolchain/bin/rustc"
mkdir -m 700 "$staging/home" "$staging/cargo-home" "$staging/vendor"
for root_config in /.cargo/config /.cargo/config.toml; do
    if [[ -e "$root_config" || -L "$root_config" ]]; then
        echo "Cargo configuration at the filesystem root would affect the isolated build" >&2
        exit 2
    fi
done
env_args=(env -i "HOME=$staging/home" "CARGO_HOME=$staging/cargo-home" PATH=/usr/bin:/bin LC_ALL=C TZ=UTC)

compiler=$("${env_args[@]}" "$rustc" --version --verbose)
cargo_version=$("${env_args[@]}" "$cargo" --version --verbose)
if [[ "$compiler" != "rustc 1.100.0 (0ef1bc386 2026-11-09)"$'\n'* ||
      "$compiler" != *$'\nhost: '"$target"$'\n'* ||
      "$cargo_version" != "cargo 1.100.0 ("* ]]; then
    echo "the launcher requires the pinned Rust 1.100.0 native toolchain" >&2
    exit 2
fi
{
    printf '%s\n%s\n' "$compiler" "$cargo_version"
    /usr/bin/cc --version
    /usr/bin/ld --version
    getconf GNU_LIBC_VERSION
} >"$staging/build-inputs.txt"

# Confirm the exact compressed registry input before creating a Cargo source.
crate_sha=3eaf3ede3fee6db1a4c2ee091bf8a8b4dccdc6d17f656fb07896ee72867612f2
actual_sha=$(sha256sum -- "$crate")
if [[ "${actual_sha%% *}" != "$crate_sha" ]]; then
    echo "libc archive differs from the reviewed registry input" >&2
    exit 2
fi
tar -xzf "$crate" --no-same-owner --no-same-permissions -C "$staging/vendor"
python3 - "$staging" "$crate_sha" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

staging = Path(sys.argv[1])
vendor = staging / "vendor"
crate = vendor / "libc-0.2.189"
files = {}
for file in sorted(crate.rglob("*")):
    if file.is_symlink():
        raise SystemExit("unexpected link in the pinned libc archive")
    if file.is_file():
        files[file.relative_to(crate).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
if "Cargo.toml" not in files or ".cargo-checksum.json" in files:
    raise SystemExit("unexpected pinned libc archive layout")
(crate / ".cargo-checksum.json").write_text(json.dumps({"files": files, "package": sys.argv[2]}))
(staging / "cargo-home/config.toml").write_text(
    '[source.crates-io]\nreplace-with = "reviewed"\n'
    '[source.reviewed]\ndirectory = ' + json.dumps(str(vendor)) + '\n'
)
PY

build() {
    local lane=$1 action=$2
    shift 2
    local source="$staging/$lane"
    mkdir "$source"
    cp -R -- "$kit_source"/{Cargo.lock,Cargo.toml,rust-toolchain.toml,src,tests} "$source"
    local flags
    printf -v flags '%s\x1f%s\x1f%s' \
        "--remap-path-prefix=$source=/kit-launcher" \
        "--remap-path-prefix=$staging/vendor=/kit-vendor" \
        "--remap-path-prefix=$toolchain=/kit-rust"
    (
        # Cargo searches the working directory and its ancestors for configuration.
        # Running from / leaves the private CARGO_HOME as its only configuration.
        cd /
        "${env_args[@]}" "RUSTC=$rustc" "CARGO_ENCODED_RUSTFLAGS=$flags" \
            "CARGO_TARGET_DIR=$source/target" "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=/usr/bin/cc" \
            "$cargo" "$action" --manifest-path "$source/Cargo.toml" \
            --locked --offline --target "$target" "$@"
    )
}

build tests test
build release-a build --release
build release-b build --release
first="$staging/release-a/target/$target/release/kit-local-launcher"
second="$staging/release-b/target/$target/release/kit-local-launcher"
cmp -- "$first" "$second"
sha256sum -- "$first" "$second"

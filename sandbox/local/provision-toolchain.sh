#!/bin/bash -p
set -euo pipefail
umask 077

if (( $# != 3 )) || [[ "$1" != /* ]]; then
    echo "usage: provision-toolchain.sh /absolute/trusted/node BUNDLE_VERSION MANIFEST_SHA256 < bundle.tar" >&2
    exit 2
fi

script_dir=${BASH_SOURCE[0]%/*}
if [[ "$script_dir" == "${BASH_SOURCE[0]}" ]]; then
    script_dir=.
fi
unset CDPATH
cd -P -- "$script_dir/../.."

exec /usr/bin/env -i "$1" --input-type=module -e '
    import { writeSync } from "node:fs";
    import { rm } from "node:fs/promises";
    import { prepareLocalBundleArchive } from "./src/sandbox/manifest.ts";

    const [, bundleVersion, manifestSha256] = process.argv;
    const cancel = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => cancel.abort(new Error("offline bundle preparation interrupted by " + signal)));
    }

    let stage;
    try {
        stage = await prepareLocalBundleArchive(0, { bundleVersion, manifestSha256 }, cancel.signal);
        cancel.signal.throwIfAborted();
        const receipt = Buffer.from(JSON.stringify(stage) + "\n");
        if (writeSync(1, receipt) !== receipt.length) throw new Error("incomplete preparation result");
    } catch (error) {
        process.exitCode = 1;
        if (stage) {
            try {
                await rm(stage.directory, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error("could not remove the private stage", stage.directory, cleanupError.message);
            }
        }
        console.error(error.message);
    }
' "$2" "$3"

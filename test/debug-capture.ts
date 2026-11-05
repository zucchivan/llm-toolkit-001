/** one-off: replicate captureBaselineTree in isolation */
import { exec } from "../src/util/exec.ts";
import { captureBaselineTree } from "../src/util/git.ts";
const root = process.argv[2] ?? "/tmp/kit-diff-check";
const trimmed = await captureBaselineTree(root);
console.log("baseline:", trimmed);
const ls = await exec(["git", "ls-tree", "-r", "--name-only", trimmed], { cwd: root, timeoutMs: 10_000 });
console.log(ls.stdout);

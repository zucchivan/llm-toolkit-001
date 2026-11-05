import { exec } from "../src/util/exec.ts";
import { workingTreeStatus } from "../src/util/git.ts";
const root = process.argv[2]!;
const tree = process.argv[3]!;
const tracked = await exec(["git", "diff", "--name-only", "--diff-filter=ACMRTUXB", tree], { cwd: root, timeoutMs: 10_000 });
console.log("tracked:", JSON.stringify(tracked.stdout), "code:", tracked.code, "err:", tracked.stderr.slice(0, 100));
console.log("status:", (await workingTreeStatus(root)).slice(0, 10));

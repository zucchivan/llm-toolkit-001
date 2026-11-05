import { exec } from "../src/util/exec.ts";
import { changedFilesVsTree } from "../src/util/git.ts";
const root = process.argv[2]!;
const tree = process.argv[3]!;
console.log("changedFilesVsTree:", await changedFilesVsTree(root, tree));
const d = await exec(["git", "diff", "--name-only", tree], { cwd: root, timeoutMs: 10_000 });
console.log("raw diff stdout:", JSON.stringify(d.stdout), "code:", d.code, "stderr:", d.stderr.slice(0, 200));

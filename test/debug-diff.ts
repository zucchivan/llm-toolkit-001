/** one-off: changedFilesVsTree and restoreTree on a fixture copy */
import { readdirSync } from "node:fs";
import { cpSync } from "node:fs";
import { exec } from "../src/util/exec.ts";
import { changedFilesVsTree, restoreTree, captureBaselineTree } from "../src/util/git.ts";

const SRC = readdirSync("/tmp").filter((d) => d.startsWith("kit-demo-")).sort().pop()!;
cpSync(`/tmp/${SRC}`, "/tmp/kit-diff-check", { recursive: true });
const root = "/tmp/kit-diff-check";

const ls = async (argv: string[]) => (await exec(argv, { cwd: root, timeoutMs: 15_000 })).stdout.trim();
const tree = await ls(["git", "ls-tree", "-r", "--name-only", "HEAD"]);
console.log("HEAD tree:", tree.slice(-200));
const pickANode = (await ls(["git", "ls-tree", "-r", "-t", "HEAD^"])).split("\n")[0];
void pickANode;

// find a tree sha in .orch baseline table: use the LAST wave-log baseline row? simpler: read sqlite via ls-tree of the sqlite docs...
// instead: capture baseline fresh, modify a file, evaluate.
const baseline = await captureBaselineTree(root);
console.log("baseline:", baseline);
await exec(["git", "show", `-s`, `--format`, "pre"], { cwd: root, timeoutMs: 15_000 });

// mutate: BROKEN append
const fsMod = await import("node:fs/promises");
const listPath = `${root}/src/list.ts`;
const before = await fsMod.readFile(listPath, "utf8");
await fsMod.writeFile(listPath, before + "\nexport const BROKEN = true;\n");
console.log("changed (should include src/list.ts):", await changedFilesVsTree(root, baseline));

// restoreTree
await restoreTree(root, baseline);
console.log("after restore, BROKEN gone?", !(await fsMod.readFile(listPath, "utf8")).includes("BROKEN"));
console.log("changed now (should be empty-ish):", await changedFilesVsTree(root, baseline));

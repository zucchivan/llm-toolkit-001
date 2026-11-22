import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/util/exec.ts";
import { diffTrees, hashBlob, pinObject, readBlob, readTreeEntries, resolveTree, writeTreeFromChanges } from "../src/util/git-objects.ts";

const roots: string[] = [];
async function repo(): Promise<{ root: string; commit: string }> {
	const root = await mkdtemp(join(tmpdir(), "kit-git-objects-"));
	roots.push(root);
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "base.bin"), Buffer.from([0, 0xff, 1, 2]));
	await writeFile(join(root, "src", "delete.txt"), "delete me\n");
	await writeFile(join(root, "src", "mode.sh"), "#!/bin/sh\nexit 0\n");
	await chmod(join(root, "src", "mode.sh"), 0o755);
	for (const args of [["init"], ["add", "-A"], ["-c", "user.email=t@example.com", "-c", "user.name=test", "commit", "-m", "base"]]) {
		const result = await exec(["git", ...args], { cwd: root, timeoutMs: 10_000 });
		if (result.code !== 0) throw new Error(result.stderr || result.stdout);
	}
	const head = await exec(["git", "rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 });
	return { root, commit: head.stdout.trim() };
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("host Git object helpers", () => {
	it("writes exact binary, create/delete, and executable-mode changes through a private index", async () => {
		const { root, commit } = await repo();
		const parent = await resolveTree(root, commit);
		const binary = Buffer.from([0, 255, 17, 0, 128]);
		const binaryOid = await hashBlob(root, binary);
		const textOid = await hashBlob(root, Buffer.from("space\tand\nnewline\n"));
		const tree = await writeTreeFromChanges(root, parent, [
			{ path: "src/base.bin", mode: "100644", oid: binaryOid },
			{ path: "src/delete.txt", mode: "0", oid: "" },
			{ path: "src/mode.sh", mode: "100644", oid: await hashBlob(root, Buffer.from("#!/bin/sh\nexit 0\n")) },
			{ path: "a file\tname.txt", mode: "100755", oid: textOid },
		]);
		expect(await readBlob(root, binaryOid)).toEqual(binary);
		const changes = await diffTrees(root, parent, tree);
		expect(changes.map(({ path, kind }) => [path, kind])).toEqual([
			["a file\tname.txt", "create"],
			["src/base.bin", "modify"],
			["src/delete.txt", "delete"],
			["src/mode.sh", "modify"],
		]);
		const rows = await readTreeEntries(root, tree);
		expect(rows.find((row) => row.path === "a file\tname.txt")?.mode).toBe("100755");
		expect(rows.some((row) => row.path === "src/delete.txt")).toBe(false);
		expect(await readBlob(root, rows.find((row) => row.path === "src/base.bin")!.oid)).toEqual(binary);
	});

	it("pins trees under private refs so normal pruning does not collect candidates", async () => {
		const { root, commit } = await repo();
		const tree = await resolveTree(root, commit);
		await pinObject(root, "refs/kit/11111111-1111-4111-8111-111111111111/tasks/t1/start", tree);
		const gc = await exec(["git", "gc", "--prune=now"], { cwd: root, timeoutMs: 30_000 });
		expect(gc.code).toBe(0);
		expect((await readTreeEntries(root, tree)).map((row) => row.path)).toContain("src/base.bin");
	});
});

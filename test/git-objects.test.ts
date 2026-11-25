import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { exec } from "../src/util/exec.ts";
import { captureBaselineTree } from "../src/util/git.ts";
import { diffTrees, hashBlob, pinObject, readBlob, readTreeEntries, resolveTree, runGit, writeTreeFromChanges, writeWorktreeTree } from "../src/util/git-objects.ts";
import {
	installTrustedInstallationForTests,
	runningInstallationFrom,
	selectInstallation,
} from "../src/sandbox/trusted-exec.ts";

const spawned = vi.hoisted(() => [] as { file: string }[]);
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (file: string, args: readonly string[], options?: object) => {
			spawned.push({ file });
			return (actual.spawn as typeof import("node:child_process").spawn)(file, args, options as never);
		},
	};
});

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
	installTrustedInstallationForTests(undefined);
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
	spawned.length = 0;
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

	it("stages worktree bytes through filter-free plumbing with the exact git add -A tree", async () => {
		const { root } = await repo();
		await symlink("src/base.bin", join(root, "link.bin"));
		await writeFile(join(root, "src", "new.txt"), "new\n");
		const indexRoot = await mkdtemp(join(tmpdir(), "kit-git-index-"));
		roots.push(indexRoot);
		const plumbed = await writeWorktreeTree(root, { indexFile: join(indexRoot, "index") });

		const control = await exec(["git", "add", "-A"], { cwd: root, timeoutMs: 15_000 });
		expect(control.code).toBe(0);
		const added = await exec(["git", "write-tree"], { cwd: root, timeoutMs: 15_000 });
		expect(plumbed).toBe(added.stdout.trim());
		const entries = await readTreeEntries(root, plumbed);
		expect(entries.find((entry) => entry.path === "link.bin")?.mode).toBe("120000");
		expect(entries.find((entry) => entry.path === "src/mode.sh")?.mode).toBe("100755");
	});

	it("never executes a repository clean filter while staging (the control add does)", async () => {
		const { root } = await repo();
		const marker = join(root, "filter-ran.txt");
		await writeFile(join(root, ".gitattributes"), "* filter=evil\n", "utf8");
		await writeFile(join(root, "src", "filtered.txt"), "content\n", "utf8");
		const config = await exec([
			"git", "config", "filter.evil.clean", `sh -c 'echo ran >> "${marker}"; cat'`,
		], { cwd: root, timeoutMs: 10_000 });
		expect(config.code).toBe(0);

		const indexRoot = await mkdtemp(join(tmpdir(), "kit-git-index-"));
		roots.push(indexRoot);
		await writeWorktreeTree(root, { indexFile: join(indexRoot, "index") });
		expect(await (await import("node:fs/promises")).stat(marker).catch(() => undefined)).toBeUndefined();

		// Control: the legacy `git add` DOES run the repository filter, which is
		// exactly why staging must not use it.
		const add = await exec(["git", "add", "-A"], { cwd: root, timeoutMs: 15_000 });
		expect(add.code).toBe(0);
		expect((await (await import("node:fs/promises")).readFile(marker, "utf8"))).toContain("ran");
	});

	it("treats a project symlinked directory as a link entry and never walks through it", async () => {
		const { root } = await repo();
		const outside = await mkdtemp(join(tmpdir(), "kit-git-outside-"));
		roots.push(outside);
		await writeFile(join(outside, "host-secret.txt"), "host secret\n", "utf8");
		await mkdir(join(root, ".orch"), { recursive: true });
		await symlink(outside, join(root, "linkdir"));
		const baseline = await captureBaselineTree(root);
		const entries = await readTreeEntries(root, baseline);
		expect(entries.find((entry) => entry.path === "linkdir")?.mode).toBe("120000");
		expect(entries.some((entry) => entry.path.startsWith("linkdir/"))).toBe(false);
	});

	it("refuses an invalid selected Git without spawning any process or falling back", async () => {
		const { root, commit } = await repo();
		const descriptor = selectInstallation({
			platform: "linux",
			running: runningInstallationFrom(pathToFileURL(join(process.cwd(), "src", "sandbox", "trusted-exec.ts")).href, "linux"),
			execPath: process.execPath,
			installation: { git: join(root, ".bin", "git") },
		});
		installTrustedInstallationForTests(descriptor);
		spawned.length = 0;
		await expect(resolveTree(root, commit)).rejects.toThrow(/trusted installation refused/);
		expect(spawned).toHaveLength(0);
		// The other selected tool is untouched by the invalid Git selection.
		const other = selectInstallation({ platform: "linux", running: null, execPath: process.execPath });
		expect(other.tools["git"]?.path).toBe("/usr/bin/git");
	});
});

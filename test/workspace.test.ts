import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/util/exec.ts";
import { createTaskControls, isTargetPath, matchesPath } from "../src/engine/controls.ts";
import { discard, diffTaskTrees, fenceWorkspace, freeze, materializeRead, openTask } from "../src/engine/workspace.ts";
import { readBlob, readTreeEntries } from "../src/util/git-objects.ts";
import type { PlanIdentity } from "../src/engine/plans.ts";

const roots: string[] = [];
const revision = "11111111-1111-4111-8111-111111111111";
const identity: PlanIdentity = {
	planRevision: revision,
	definitionSha256: "a".repeat(64),
	baseCommit: null,
	baseBranch: null,
	prdPath: "docs/prd.md",
	prdSha256: "b".repeat(64),
};

async function repo(): Promise<{ root: string; head: string }> {
	const root = await mkdtemp(join(tmpdir(), "kit-workspace-"));
	roots.push(root);
	await mkdir(join(root, "src"), { recursive: true });
	await mkdir(join(root, "evals"), { recursive: true });
	await mkdir(join(root, ".orch"), { recursive: true });
	await writeFile(join(root, ".gitignore"), "coverage/\n");
	await writeFile(join(root, "src", "a.ts"), "export const a = 'base';\n");
	await writeFile(join(root, "src", "delete.ts"), "delete me\n");
	await writeFile(join(root, "src", "tool.sh"), "#!/bin/sh\necho base\n");
	await chmod(join(root, "src", "tool.sh"), 0o755);
	await writeFile(join(root, "outside.ts"), "untouched\n");
	await writeFile(join(root, "evals", "recipes.toml"), "[reviewed]\n");
	await writeFile(join(root, ".orch", "config.toml"), "private control\n");
	await writeFile(join(root, ".env"), "SECRET=not-projected\n");
	for (const args of [["init"], ["add", "-A"], ["-c", "user.email=t@example.com", "-c", "user.name=test", "commit", "-m", "base"]]) {
		const result = await exec(["git", ...args], { cwd: root, timeoutMs: 10_000 });
		if (result.code !== 0) throw new Error(result.stderr || result.stdout);
	}
	const head = await exec(["git", "rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 });
	return { root, head: head.stdout.trim() };
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("immutable task-tree workspaces", () => {
	it("freezes exact permitted bytes/modes without touching staged, unstaged, ignored files or HEAD", async () => {
		const { root, head } = await repo();
		// Deliberately conflicting operator state is outside the committed parent.
		await writeFile(join(root, "src", "a.ts"), "operator unstaged\n");
		await writeFile(join(root, "staged.txt"), "staged one\n");
		expect((await exec(["git", "add", "staged.txt"], { cwd: root, timeoutMs: 10_000 })).code).toBe(0);
		await writeFile(join(root, "staged.txt"), "staged two\n");
		await mkdir(join(root, "coverage"), { recursive: true });
		await writeFile(join(root, "coverage", "sentinel"), "ignored coverage\n");
		const originalOperator = await readFile(join(root, "src", "a.ts"), "utf8");
		const originalStage = await readFile(join(root, "staged.txt"), "utf8");
		const beforeHead = (await exec(["git", "rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 })).stdout.trim();
		const beforeIndex = (await exec(["git", "write-tree"], { cwd: root, timeoutMs: 10_000 })).stdout.trim();
		const status = (await exec(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: root, timeoutMs: 10_000 })).stdout;

		const lease = await openTask({ root, oid: head }, identity, "task-1");
		expect(await readFile(join(lease.workspacePath, "src", "a.ts"), "utf8")).toContain("base");
		expect(await readFile(join(lease.workspacePath, "outside.ts"), "utf8")).toBe("untouched\n");
		expect(lease.projectedParentPaths).toContain("src/a.ts");
		expect(lease.excludedParentPaths).toEqual(expect.arrayContaining([".env", ".orch/config.toml"]));
		expect(lease.projectedParentPaths).toEqual(expect.arrayContaining(["evals/recipes.toml", ".gitignore"]));
		expect((await stat(join(lease.workspacePath, "evals", "recipes.toml"))).mode & 0o222).toBe(0);
		expect(await stat(join(lease.workspacePath, ".git")).then(() => true, () => false)).toBe(false);

		await writeFile(join(lease.workspacePath, "src", "a.ts"), "candidate\n");
		await rm(join(lease.workspacePath, "src", "delete.ts"));
		await writeFile(join(lease.workspacePath, "src", "new.bin"), Buffer.from([0, 255, 1]));
		await chmod(join(lease.workspacePath, "src", "tool.sh"), 0o600);
		const controls = createTaskControls({ root, targetPaths: ["src/"] });
		const candidate = await freeze(fenceWorkspace(lease, controls));
		expect(candidate.changes.map(({ path, kind }) => [path, kind])).toEqual([
			["src/a.ts", "modify"], ["src/delete.ts", "delete"], ["src/new.bin", "create"], ["src/tool.sh", "modify"],
		]);
		const rows = await readTreeEntries(root, candidate.tree);
		expect(rows.find((row) => row.path === "outside.ts")?.oid).toBe((await readTreeEntries(root, head)).find((row) => row.path === "outside.ts")?.oid);
		expect(rows.some((row) => row.path.startsWith("coverage/"))).toBe(false);
		expect(rows.find((row) => row.path === "src/tool.sh")?.mode).toBe("100644");
		expect(await readBlob(root, rows.find((row) => row.path === "src/new.bin")!.oid)).toEqual(Buffer.from([0, 255, 1]));
		const privateRefs = await exec(["git", "for-each-ref", "--format=%(refname)", "refs/kit"], { cwd: root, timeoutMs: 10_000 });
		expect(privateRefs.stdout).toContain("/candidate");
		expect((await exec(["git", "branch", "--list", "kit/*"], { cwd: root, timeoutMs: 10_000 })).stdout).toBe("");
		expect((await exec(["git", "gc", "--prune=now"], { cwd: root, timeoutMs: 30_000 })).code).toBe(0);
		expect((await readTreeEntries(root, candidate.tree)).some((row) => row.path === "src/new.bin")).toBe(true);

		await discard(lease);
		expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe(originalOperator);
		expect(await readFile(join(root, "staged.txt"), "utf8")).toBe(originalStage);
		expect(await readFile(join(root, "coverage", "sentinel"), "utf8")).toBe("ignored coverage\n");
		expect((await exec(["git", "rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 })).stdout.trim()).toBe(beforeHead);
		expect((await exec(["git", "write-tree"], { cwd: root, timeoutMs: 10_000 })).stdout.trim()).toBe(beforeIndex);
		expect((await exec(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: root, timeoutMs: 10_000 })).stdout).toBe(status);
		await expect(discard(lease)).rejects.toThrow(/live lease/);
	});

	it("materializes a read-only safe projection and pins it", async () => {
		const { root, head } = await repo();
		const controls = createTaskControls({ root, targetPaths: [] });
		const view = await materializeRead({ root, oid: head }, controls);
		expect(view.projectedParentPaths).toContain("src/a.ts");
		expect(view.excludedParentPaths).toEqual(expect.arrayContaining([".env", ".orch/config.toml"]));
		expect(view.projectedParentPaths).toEqual(expect.arrayContaining(["evals/recipes.toml", ".gitignore"]));
		expect((await stat(join(view.viewPath, "evals", "recipes.toml"))).mode & 0o222).toBe(0);
		expect(await readFile(join(view.viewPath, "src", "a.ts"), "utf8")).toContain("base");
		expect((await stat(join(view.viewPath, "src", "a.ts"))).mode & 0o222).toBe(0);
		expect(await stat(join(view.viewPath, ".git")).then(() => true, () => false)).toBe(false);
		await expect(writeFile(join(view.viewPath, "src", "a.ts"), "mutate\n")).rejects.toThrow();
		const refs = await exec(["git", "for-each-ref", "--format=%(refname)", "refs/kit/read"], { cwd: root, timeoutMs: 10_000 });
		expect(refs.stdout).toContain("/tree");
		await discard(view);
	});

	it("rejects scope violations, reserved paths, symlinks, malformed patterns, and forged leases", async () => {
		const { root, head } = await repo();
		const lease = await openTask({ root, oid: head }, identity, "task-1");
		const controls = createTaskControls({ root, targetPaths: ["src/"] });
		await writeFile(join(lease.workspacePath, "outside.ts"), "not allowed\n");
		await expect(freeze(fenceWorkspace(lease, controls))).rejects.toThrow(/outside targetPaths/);
		await rm(join(lease.workspacePath, "outside.ts"));
		await mkdir(join(lease.workspacePath, "evals"), { recursive: true });
		await writeFile(join(lease.workspacePath, "evals", "recipe.toml"), "[bad]\n");
		await expect(freeze(fenceWorkspace(lease, createTaskControls({ root, targetPaths: [] })))).rejects.toThrow(/read-only task-tree path/);
		await rm(join(lease.workspacePath, "evals"), { recursive: true });
		await import("node:fs/promises").then(({ symlink }) => symlink(join(root, "outside.ts"), join(lease.workspacePath, "src", "link")));
		await expect(freeze(fenceWorkspace(lease, controls))).rejects.toThrow(/symlink/);
		await expect(discard({ ...lease })).rejects.toThrow(/live lease/);
		await discard(lease);
	});

	it("uses one literal/directory/glob matcher, with denies winning for an empty target set", () => {
		const controls = createTaskControls({ root: "/project", targetPaths: ["src/main.ts", "lib/", "**/*.test.ts"] });
		expect(isTargetPath("src/main.ts", controls)).toBe(true);
		expect(isTargetPath("src/other.ts", controls)).toBe(false);
		expect(isTargetPath("lib/deep/file.js", controls)).toBe(true);
		expect(isTargetPath("src/deep/file.test.ts", controls)).toBe(true);
		expect(matchesPath("src/file.ts", "src/*.ts")).toBe(true);
		expect(matchesPath("src/deep/file.ts", "src/*.ts")).toBe(false);
		expect(matchesPath("src/deep/file.ts", "src/**/*.ts")).toBe(true);
		const unrestricted = createTaskControls({ root: "/project", targetPaths: [] });
		expect(isTargetPath("src/ok.ts", unrestricted)).toBe(true);
		expect(isTargetPath(".orch/config.toml", unrestricted)).toBe(false);
		expect(isTargetPath(".orchive/readme.md", unrestricted)).toBe(true);
		expect(isTargetPath("evals/recipes.toml", unrestricted)).toBe(false);
		expect(isTargetPath(".GITIGNORE", unrestricted)).toBe(false);
		expect(() => createTaskControls({ root: "/project", targetPaths: ["../escape"] })).toThrow(/invalid/);
		expect(() => createTaskControls({ root: "/project", targetPaths: ["src/?/x"] })).toThrow(/only \*/);
	});

	it("tree diffs are immutable and exact", async () => {
		const { root, head } = await repo();
		const lease = await openTask({ root, oid: head }, identity, "task-1");
		await writeFile(join(lease.workspacePath, "src", "a.ts"), "tree two\n");
		const fencedWorkspace = fenceWorkspace(lease, createTaskControls({ root, targetPaths: [] }));
		const frozen = await freeze(fencedWorkspace);
		expect(await diffTaskTrees({ root, oid: head }, frozen.parentTree, frozen.tree)).toEqual(frozen.changes);
		await expect(freeze(fencedWorkspace)).rejects.toThrow(/not-yet-frozen/);
		await discard(lease);
	});

	it("rejects case-colliding parent paths and invalid parent object IDs", async () => {
		const { root } = await repo();
		await writeFile(join(root, "src", "Case.ts"), "one\n");
		await writeFile(join(root, "src", "case.ts"), "two\n");
		expect((await exec(["git", "add", "-A"], { cwd: root, timeoutMs: 10_000 })).code).toBe(0);
		expect((await exec(["git", "-c", "user.email=t@example.com", "-c", "user.name=test", "commit", "-m", "collision"], { cwd: root, timeoutMs: 10_000 })).code).toBe(0);
		const head = (await exec(["git", "rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 })).stdout.trim();
		await expect(openTask({ root, oid: head }, identity, "task-1")).rejects.toThrow(/case-colliding/);
		await expect(openTask({ root, oid: "not-an-oid" }, identity, "task-1")).rejects.toThrow(/object ID/);
	});
});

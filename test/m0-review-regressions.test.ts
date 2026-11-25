import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { priceUsage } from "../src/util/budget.ts";
import { controlsSha256, normalizeRelPath } from "../src/engine/plans.ts";
import { loadPrd } from "../src/engine/planner.ts";
import type { LoopAndLock } from "../src/engine/harness.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "m0-review-")); roots.push(dir); return dir; }

describe("reviewed input and valuation boundaries", () => {
  it("does not price missing input/output rates as free, but accepts explicit zero", () => {
    const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    expect(priceUsage(usage, { configRates: { costPerMillionInput: 2 } }).kind).toBe("unknown");
    expect(priceUsage(usage, { configRates: { costPerMillionInput: 0, costPerMillionOutput: 0 } })).toEqual({ kind: "priced", usd: 0 });
    expect(priceUsage({ ...usage, cacheRead: 1 }, { configRates: { costPerMillionInput: 0, costPerMillionOutput: 0 } }).kind).toBe("unknown");
  });

  it("rejects escaped and symlinked PRDs before a planning submission", async () => {
    const dir = await root();
    await mkdir(join(dir, "docs"));
    await symlink("/etc/hosts", join(dir, "docs", "prd.md"));
    const kit = { loop: { paths: { root: dir }, config: { paths: { prd: "docs/prd.md" } } } } as LoopAndLock;
    await expect(loadPrd(kit)).rejects.toThrow(/unsafe/);
    await expect(loadPrd(kit, "../outside")).rejects.toThrow(/unsafe/);
    expect(() => normalizeRelPath(dir, "../outside")).toThrow(/safe project-relative/);
  });

  it("refuses a symlinked ancestor, a non-regular leaf and a capped PRD without disclosing bytes", async () => {
    const dir = await root();
    const outside = await root();
    await writeFile(join(outside, "prd.md"), "HOST SECRET BYTES", "utf8");
    await symlink(outside, join(dir, "docs")); // directory alias: the ancestor walk must not follow it
    const kit = { loop: { paths: { root: dir }, config: { paths: { prd: "docs/prd.md" } } } } as LoopAndLock;
    const ancestor = await loadPrd(kit).catch((error: Error) => error);
    expect(ancestor).toBeInstanceOf(Error);
    expect((ancestor as Error).message).toMatch(/unsafe/);
    expect((ancestor as Error).message).not.toContain("HOST SECRET BYTES");

    const plain = await root();
    await mkdir(join(plain, "docs"));
    await mkdir(join(plain, "docs", "prd.md")); // a directory is not a PRD
    const plainKit = { loop: { paths: { root: plain }, config: { paths: { prd: "docs/prd.md" } } } } as LoopAndLock;
    await expect(loadPrd(plainKit)).rejects.toThrow(/unsafe/);

    const big = await root();
    await mkdir(join(big, "docs"));
    await writeFile(join(big, "docs", "prd.md"), "", "utf8");
    await truncate(join(big, "docs", "prd.md"), 32 * 1024 * 1024 + 1); // §2 per-file cap
    const bigKit = { loop: { paths: { root: big }, config: { paths: { prd: "docs/prd.md" } } } } as LoopAndLock;
    await expect(loadPrd(bigKit)).rejects.toThrow(/unsafe/);
  });

  it("distinguishes absent from invalid, symlinked, and unreadable review controls", async () => {
    const dir = await root();
    await mkdir(join(dir, ".orch"));
    expect(await controlsSha256(dir)).toBeUndefined();
    const file = join(dir, ".orch", "gate-remediations.json");
    await writeFile(file, "not json");
    await expect(controlsSha256(dir)).rejects.toThrow();
    await rm(file);
    await symlink("/etc/hosts", file);
    await expect(controlsSha256(dir)).rejects.toThrow(/regular file/);
  });

  it("refuses review controls reached through a symlinked ancestor directory", async () => {
    const dir = await root();
    const outside = await root();
    await writeFile(join(outside, "recipes.toml"), "[gate-x]\nargv = [\"true\"]\n", "utf8");
    await symlink(outside, join(dir, "evals"));
    await expect(controlsSha256(dir)).rejects.toThrow(/regular file/);
  });
});

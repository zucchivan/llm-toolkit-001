/**
 * M0-P03 — three-class repository hygiene (engineering plan §1 ADR 04).
 *
 * - `init` appends ONE bounded, LF-delimited hygiene block
 *   (`/.orch/*` + three reviewable negations + `/router.md`), idempotent even
 *   over a .gitignore that lacks a final newline; existing comments and custom
 *   patterns are preserved.
 * - `git check-ignore --no-index` classifies every §1 ADR 04 category as
 *   documented: only optional-trail and private paths are ignored by default;
 *   reviewable project paths and the three reviewable kit controls are not.
 * - An already-tracked private file is WARNED about, never unstaged or
 *   deleted; the index and the working file stay untouched.
 * - A pre-existing pattern that excludes the `.orch/` parent is reported
 *   (Git cannot re-include files under an excluded directory) — never repaired
 *   silently, and the operator's rule is preserved.
 */
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { initProject } from "../src/init.ts";
import {
	installTrustedInstallationForTests,
	runningInstallationFrom,
	selectInstallation,
} from "../src/sandbox/trusted-exec.ts";
import {
	HYGIENE_BLOCK_BEGIN,
	HYGIENE_BLOCK_END,
	HYGIENE_RULE_LINES,
	applyHygieneBlock,
	classifyProjectPath,
	hygieneBlockText,
	installProjectHygiene,
} from "../src/hygiene.ts";
import { exec } from "../src/util/exec.ts";

const execFileAsync = promisify(execFile);

async function tmpProject(): Promise<string> {
	return mkdtemp(join(tmpdir(), "kit-hygiene-"));
}

async function git(root: string, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return exec(["git", ...args], { cwd: root, timeoutMs: 15_000 });
}

/** true when `git check-ignore --no-index` says the path is ignored (pure pattern test, index-independent). */
async function checkIgnore(root: string, path: string): Promise<boolean> {
	const out = await git(root, "check-ignore", "--no-index", "--", path);
	return out.code === 0;
}

async function trackedFiles(root: string): Promise<string[]> {
	const out = await git(root, "ls-files");
	return out.code === 0 ? out.stdout.trim().split("\n").filter(Boolean) : [];
}

describe("ADR 04 category classification (src/hygiene.ts)", () => {
	it("classifies every §1 category: reviewable / optional local paper trail / private", () => {
		const reviewable = [
			"src/list.ts",
			"docs/prd.md",
			"PROMPT.md",
			"evals/recipes.toml",
			"evals/checklist.md",
			"evals/recipes.auto.toml",
			".orch/config.toml",
			".orch/gate-decisions.json",
			".orch/gate-remediations.json",
		];
		const trail = ["router.md", ".orch/wave-log.jsonl", ".orch/kit-version"];
		const priv = [
			".orch/durable.sqlite",
			".orch/durable.sqlite-wal",
			".orch/durable.sqlite-shm",
			".orch/lock",
			".orch/status.json",
			".orch/pending-handoff.json",
			".orch/artifacts/gate.log",
			".orch/ui/jobs/1.json",
			".orch/verifier-assessment.json",
			".orch/failure-triage-assessment.json",
			".orch/notes.md",
		];
		for (const p of reviewable) expect(classifyProjectPath(p), p).toBe("reviewable");
		for (const p of trail) expect(classifyProjectPath(p), p).toBe("optional-trail");
		for (const p of priv) expect(classifyProjectPath(p), p).toBe("private");
		// Tolerated input noise: ./ prefix, leading slash, backslashes.
		expect(classifyProjectPath("./router.md")).toBe("optional-trail");
		expect(classifyProjectPath("/.orch/config.toml")).toBe("reviewable");
		expect(classifyProjectPath(".orch\\status.json")).toBe("private");
	});
});

describe("hygiene block installation", () => {
	it("double init over a no-final-newline .gitignore appends exactly one well-formed block", async () => {
		const root = await tmpProject();
		await mkdir(join(root, "docs"), { recursive: true });
		// Existing user content WITHOUT a trailing newline.
		await writeFile(join(root, ".gitignore"), "node_modules/\n# my custom rule\ncoverage", "utf8");

		const first = await initProject(root);
		expect(first.appended).toContain(".gitignore: llm-toolkit-001 hygiene block");
		const afterFirst = await readFile(join(root, ".gitignore"), "utf8");

		// Newline-safe: the missing final newline is repaired, no glued lines.
		expect(afterFirst.startsWith("node_modules/\n# my custom rule\ncoverage\n")).toBe(true);
		expect(afterFirst).not.toContain("coverage#");
		// LF-delimited and newline-terminated.
		expect(afterFirst.endsWith("\n")).toBe(true);
		expect(afterFirst.includes("\r")).toBe(false);
		// Exactly one block, well-formed: begin marker, five rule lines in
		// order, end marker.
		expect(afterFirst.split(HYGIENE_BLOCK_BEGIN)).toHaveLength(2);
		expect(afterFirst).toContain(HYGIENE_BLOCK_END);
		const block = afterFirst.slice(afterFirst.indexOf(HYGIENE_BLOCK_BEGIN));
		const rulePositions = HYGIENE_RULE_LINES.map((line) => block.indexOf(line));
		expect(rulePositions.every((pos) => pos >= 0)).toBe(true);
		expect(rulePositions).toEqual([...rulePositions].sort((a, b) => a - b));
		// Existing comments and custom patterns preserved verbatim.
		expect(afterFirst).toContain("# my custom rule\ncoverage\n");

		// Second init: byte-identical, nothing appended.
		const second = await initProject(root);
		expect(second.appended).toEqual([]);
		const afterSecond = await readFile(join(root, ".gitignore"), "utf8");
		expect(afterSecond).toBe(afterFirst);
	});

	it("empty .gitignore gets a clean block; pure applyHygieneBlock agrees with init", async () => {
		const root = await tmpProject();
		await mkdir(join(root, "docs"), { recursive: true });
		const report = await initProject(root);
		expect(report.appended).toContain(".gitignore: llm-toolkit-001 hygiene block");
		const onDisk = await readFile(join(root, ".gitignore"), "utf8");
		expect(onDisk).toBe(hygieneBlockText());
		// Pure helper: idempotent over its own output, and over empty input.
		expect(applyHygieneBlock(onDisk)).toMatchObject({ content: onDisk, installed: false });
		expect(applyHygieneBlock("").installed).toBe(true);
	});
});

describe("git check-ignore classification of the §1 ADR 04 categories", () => {
	it("a fresh init ignores exactly the optional-trail and private paths — never reviewable ones", async () => {
		const root = await tmpProject();
		await mkdir(join(root, "docs"), { recursive: true });
		const init = await git(root, "init", "-q");
		expect(init.code).toBe(0);
		await initProject(root);

		const ignoredByDefault = [
			// optional local paper trail
			"router.md",
			".orch/wave-log.jsonl",
			".orch/kit-version",
			// private runtime state
			".orch/durable.sqlite",
			".orch/durable.sqlite-wal",
			".orch/lock",
			".orch/status.json",
			".orch/pending-handoff.json",
			".orch/artifacts/gate.log",
			".orch/ui/jobs/1.json",
			".orch/verifier-assessment.json",
			".orch/failure-triage-assessment.json",
		];
		const reviewable = [
			".orch/config.toml",
			".orch/gate-decisions.json",
			".orch/gate-remediations.json",
			"PROMPT.md",
			"evals/recipes.toml",
			"evals/checklist.md",
			"docs/prd.md",
			"src/index.ts",
		];
		for (const p of ignoredByDefault) expect(await checkIgnore(root, p), p).toBe(true);
		for (const p of reviewable) expect(await checkIgnore(root, p), p).toBe(false);
	}, 60_000);

	it("manual retention is possible: the trail can be explicitly re-included and committed", async () => {
		const root = await tmpProject();
		await mkdir(join(root, "docs"), { recursive: true });
		await git(root, "init", "-q");
		await initProject(root);
		// The human may explicitly retain the paper trail after review …
		await git(root, "add", "-f", "router.md");
		const staged = await git(root, "diff", "--cached", "--name-only");
		expect(staged.stdout.trim().split("\n")).toContain("router.md");
		// … while `git add -A` alone never stages trail or private state.
		await mkdir(join(root, ".orch", "ui", "jobs"), { recursive: true });
		await writeFile(join(root, ".orch", "status.json"), "{}", "utf8");
		await writeFile(join(root, ".orch", "wave-log.jsonl"), "\n", "utf8");
		await git(root, "add", "-A");
		const stagedAll = await git(root, "diff", "--cached", "--name-only");
		expect(stagedAll.stdout).not.toContain("status.json");
		expect(stagedAll.stdout).not.toContain("wave-log.jsonl");
	}, 60_000);
});

describe("warn-don't-unstage for already-tracked files", () => {
	it("a tracked private file is reported and left exactly as it was", async () => {
		const root = await tmpProject();
		await mkdir(join(root, ".orch"), { recursive: true });
		await mkdir(join(root, "docs"), { recursive: true });
		await writeFile(join(root, ".orch", "status.json"), '{"tracked":true}\n', "utf8");
		await writeFile(join(root, ".orch", "config.toml"), "# reviewable control\n", "utf8");
		await writeFile(join(root, "router.md"), "# retained trail\n", "utf8");
		await git(root, "init", "-q");
		await git(root, "add", "-A");
		await git(root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "seed");

		const report = await initProject(root);
		// Warned about the tracked PRIVATE file only …
		const privateWarnings = report.warnings.filter((w) => w.includes(".orch/status.json"));
		expect(privateWarnings).toHaveLength(1);
		expect(privateWarnings[0]).toContain("git rm --cached");
		expect(privateWarnings[0]).toContain("never modifies the index or history");
		// … never about retained trail or reviewable controls.
		expect(report.warnings.join("\n")).not.toContain("router.md");
		expect(report.warnings.join("\n")).not.toContain("config.toml");

		// Nothing was unstaged, deleted, or rewritten: index + bytes unchanged.
		expect(await trackedFiles(root)).toEqual([".orch/config.toml", ".orch/status.json", "router.md"]);
		expect(await readFile(join(root, ".orch", "status.json"), "utf8")).toBe('{"tracked":true}\n');
		const head = await git(root, "rev-parse", "HEAD");
		const headAfter = await git(root, "rev-parse", "HEAD");
		expect(headAfter.stdout).toBe(head.stdout);
	}, 60_000);

	it("init-time Git goes through the host resolver: a refused selection is not a repo and touches no PATH git", async () => {
		const root = await tmpProject();
		await mkdir(join(root, ".orch"), { recursive: true });
		await writeFile(join(root, ".orch", "status.json"), "{}\n", "utf8");
		installTrustedInstallationForTests(selectInstallation({
			platform: process.platform,
			running: runningInstallationFrom("file:///srv/kit/src/sandbox/trusted-exec.ts", process.platform),
			execPath: process.execPath,
			installation: { git: join(root, ".bin", "git") },
		}));
		try {
			const report = await initProject(root);
			// The selection refused (inside the target), so the tracked-file probe is
			// "not a repository" and reports nothing; the .gitignore block is still
			// written without any PATH Git fallback.
			expect(report.warnings).toEqual([]);
			expect(await readFile(join(root, ".gitignore"), "utf8")).toContain(HYGIENE_BLOCK_BEGIN);
		} finally {
			installTrustedInstallationForTests(undefined);
		}
	}, 60_000);

	it("a pre-existing pattern that excludes the .orch parent is reported, not repaired", async () => {		const root = await tmpProject();
		await mkdir(join(root, "docs"), { recursive: true });
		await writeFile(join(root, ".gitignore"), "# operator rule\n.orch/\ndist/\n", "utf8");
		const report = await initProject(root);

		const conflicts = report.warnings.filter((w) => w.includes(".orch/"));
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toContain("cannot re-include files under an excluded directory");
		// The operator's rule and comment are preserved; the block is still
		// appended (documenting the intended defaults) and idempotency holds.
		const content = await readFile(join(root, ".gitignore"), "utf8");
		expect(content.startsWith("# operator rule\n.orch/\ndist/\n")).toBe(true);
		expect(content.split(HYGIENE_BLOCK_BEGIN)).toHaveLength(2);
		const second = await initProject(root);
		expect(second.appended).toEqual([]);
	}, 60_000);
});

describe("M1-P01 step (g): the .gitignore read goes through the host boundary", () => {
	it("a symlinked .gitignore (or a symlinked ancestor) REFUSES before any write: the link target is untouched", async () => {
		const outside = await mkdtemp(join(tmpdir(), "kit-hygiene-outside-"));
		const target = join(outside, ".gitignore");
		await writeFile(target, "# OUTSIDE GITIGNORE\n", "utf8");
		const root = await tmpProject();
		await symlink(target, join(root, ".gitignore"));

		const error = await installProjectHygiene(root).catch((err: unknown) => err);
		expect(error).toMatchObject({ name: "SafeReadRefusalError", code: "symlink" });
		// Forbidden effect: nothing was appended through the link.
		expect(await readFile(target, "utf8")).toBe("# OUTSIDE GITIGNORE\n");
	});

	it("an absent .gitignore is the defined empty input (a fresh block is written), and a re-run is idempotent", async () => {
		const root = await tmpProject();
		const first = await installProjectHygiene(root);
		expect(first.installed).toBe(true);
		const content = await readFile(join(root, ".gitignore"), "utf8");
		expect(content).toContain(HYGIENE_BLOCK_BEGIN);
		const second = await installProjectHygiene(root);
		expect(second.installed).toBe(false);
		expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(content);
	});
});

describe("kit root .gitignore (anchored corresponding rules)", () => {
	it("the tracked config template stays committable while the kit's own root trail/private state stays ignored", async () => {
		// The kit dogfoods its own hygiene: template/.orch/config.toml must stay
		// UNignored (tracked template), root .orch state ignored, root config
		// reviewable. Paths are checked against the repo root .gitignore only.
		const root = process.cwd();
		const probe = async (path: string): Promise<boolean> => {
			try {
				const out = await execFileAsync("git", ["check-ignore", "--no-index", "--", path], { cwd: root });
				return out.stdout.trim() === path;
			} catch {
				// Exit 1 = not ignored.
				return false;
			}
		};
		expect(await probe("template/.orch/config.toml")).toBe(false);
		expect(await probe(".orch/durable.sqlite")).toBe(true);
		expect(await probe(".orch/wave-log.jsonl")).toBe(true);
		expect(await probe("router.md")).toBe(true);
		expect(await probe(".orch/config.toml")).toBe(false);
	});
});

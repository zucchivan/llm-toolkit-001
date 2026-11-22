/**
 * `init` scaffolds a target project (brief §5): config, PROMPT.md, evals
 * templates, router.md mirror placeholder, and one bounded ADR 04 hygiene
 * block in .gitignore. Idempotent per-version: existing non-empty files are
 * never clobbered (we print what we skipped) and .orch/kit-version records
 * provenance.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname as pd } from "node:path";
import { KIT_VERSION } from "./config.ts";
import { readInstalledPiDurableVersion } from "./engine/kit.ts";
import { installProjectHygiene } from "./hygiene.ts";

export interface InitOptions {
	withDemo?: boolean;
	projectName?: string;
}

export interface InitReport {
	written: string[];
	skipped: string[];
	appended: string[];
	/** Hygiene conflicts: reported, never repaired (no index/history changes). */
	warnings: string[];
}

export async function initProject(root: string, options: InitOptions = {}): Promise<InitReport> {
	const report: InitReport = { written: [], skipped: [], appended: [], warnings: [] };
	const templateDir = templateRoot();
	const projectName = options.projectName ?? (existsSync(join(root, "package.json"))
		? (JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: string }).name ?? basename(root)
		: basename(root));

	await mkdir(join(root, ".orch"), { recursive: true });
	await mkdir(join(root, "docs"), { recursive: true });
	await mkdir(join(root, "evals"), { recursive: true });

	for (const [relative, target] of templateTargets(projectName)) {
		if (process.env["KIT_DEBUG"]) console.error("init target:", relative, "template:", join(templateDir, target));
		const abs = join(root, relative);
		const source = await readFile(join(templateDir, target), "utf8").catch(() => undefined);
		if (source === undefined) continue; // engine-owned file without a template
		const exists = existsSync(abs) && (await stat(abs)).size > 0;
		if (exists) {
			report.skipped.push(relative);
		} else {
			await mkdir(dirnameOf(abs), { recursive: true });
			await writeFile(abs, source, "utf8");
			report.written.push(relative);
		}
	}

	// docs/prd.md is USER content: only placeholder if absent entirely.
	const prdPath = join(root, "docs", "prd.md");
	if (!existsSync(prdPath) && options.withDemo) {
		await mkdir(dirnameOf(prdPath), { recursive: true });
		await writeFile(prdPath, DEMO_PRD(projectName), "utf8");
		report.written.push("docs/prd.md");
	}

	// .gitignore: ONE bounded ADR 04 hygiene block (idempotent, LF-delimited,
	// newline-safe; existing comments/custom patterns preserved). Conflicts — a
	// pre-existing .orch parent exclusion or an already-tracked private file —
	// are reported, never repaired: init never touches the index or history.
	const hygiene = await installProjectHygiene(root);
	if (hygiene.installed) report.appended.push(".gitignore: llm-toolkit-001 hygiene block");
	report.warnings.push(...hygiene.conflicts);

	// Provenance marker: kit identity is the package version (config.ts reads
	// package.json); the pi-durable side comes from the pinned seam, which owns
	// every installed-version query.
	const kitVersionMarker = `kit=${KIT_VERSION} pi-durable=${readInstalledPiDurableVersion()}\n`;
	await writeFile(join(root, ".orch", "kit-version"), kitVersionMarker, "utf8");

	return report;
}

function templateTargets(projectName: string): Array<[string, string]> {
	return [
		["PROMPT.md", "PROMPT.md"],
		["evals/checklist.md", "evals/checklist.md"],
		["evals/recipes.toml", "evals/recipes.toml"],
		["router.md", "router.md"],
		[".orch/config.toml", ".orch/config.toml"],
	];
}

function templateRoot(): string {
	// templates ride in <package>/template: fileURLToPath is <pkg>/src/init.ts
	// (source via tsx) or <pkg>/dist/init.js (built CLI) — parent twice, + /template
	return join(pd(pd(fileURLToPath(import.meta.url))), "template");
}

function dirnameOf(abs: string): string {
	const p = pd(abs);
	return p ?? ".";
}

function basename(path: string): string {
	const parts = path.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? "project";
}

function DEMO_PRD(projectName: string): string {
	return `# PRD — demo queue (fixture)

One paragraph of “what” for ${projectName}: a tiny list utility with three Tasks that
exercise the loop (planner output → waves → gates → verifier). This placeholder
describes the examples/demo-prd fixture — init --with-demo writes guidance,
not a baked project: the fixture's replay, its ONE recipe file and the
reviewed gate script live in the kit repo and are copied by the demo builders.

## Tasks (guidance, the planner expands)
1. list.ts — parseList + renderList (parseList strips ONE leading dash per
   token and keeps it: '/a/-b' → ['a','b'])
2. query filter — queryList with case-insensitive matching (in examples/demo-prd
   the FIRST scripted wave ships a case-sensitive filter that the behavioral
   gate rejects; the wave-2 retry repairs it from the gate feedback — a retry
   proven by behavior, not by a BROKEN token)
3. CLI entry — bin that reads a text arg and prints the rendered list
   (node bin/render.js '/a/-b' prints exactly "a b")

## Acceptance
- Each above item: rendered as distinct RouterDoc tasks by the planner with targetPaths.
`;
}

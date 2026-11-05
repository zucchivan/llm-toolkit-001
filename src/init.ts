/**
 * `init` scaffolds a target project (brief §5): config, PROMPT.md, evals
 * templates, router.md mirror placeholder, .gitignore additions. Idempotent
 * per-version: existing non-empty files are never clobbered (we print what we
 * skipped) and .orch/kit-version records provenance.
 */
import { mkdir, readFile, stat, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname as pd } from "node:path";
import { KIT_VERSION } from "./config.ts";
import { createRequire } from "node:module";

export interface InitOptions {
	withDemo?: boolean;
	projectName?: string;
}

export interface InitReport {
	written: string[];
	skipped: string[];
	appended: string[];
}

export async function initProject(root: string, options: InitOptions = {}): Promise<InitReport> {
	const report: InitReport = { written: [], skipped: [], appended: [] };
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

	// .gitignore additions, appended only when missing.
	const ignoreLines = [
		".orch/durable.sqlite*",
		".orch/lock",
		".orch/status.json",
		".orch/pending-handoff.json",
		".orch/artifacts/",
	];
	const gitignore = join(root, ".gitignore");
	const current = existsSync(gitignore) ? await readFile(gitignore, "utf8") : "";
	for (const line of ignoreLines) {
		if (!current.includes(`\n${line}\n`) && !current.startsWith(`${line}\n`) && current !== `${line}\n`) {
			await appendFile(gitignore, `${line}\n`, "utf8");
			report.appended.push(`.gitignore: ${line}`);
		}
	}

	// Provenance marker.
	const require = createRequire(import.meta.url);
	const pkg = require("@earendil-works/pi-durable/package.json") as { version: string };
	const kitVersionMarker = `kit=${KIT_VERSION} pi-durable=${pkg.version}\n`;
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
	void projectName;
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
exercise the loop (planner output → waves → gates → verifier).

## Tasks (guidance, the planner expands)
1. list.ts — parseList + renderList with unit tests
2. search filter — queryList with case-insensitive matching (deliberate test-fail first run in examples/demo-prd)
3. CLI entry — bin that reads a file and prints the rendered list

## Acceptance
- Each above item: rendered as distinct RouterDoc tasks by the planner with targetPaths.
`;
}

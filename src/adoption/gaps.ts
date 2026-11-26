/** Evidence-based gate inventory and cross-cutting coverage analysis. */
import { createHash } from "node:crypto";
import { loadRecipeFileSafe, recipeCommandText, recipesEquivalent } from "../engine/gates.ts";
import { isSimpleCommand } from "../engine/recipe-runner.ts";
import type { Recipe } from "../engine/gates.ts";
import { SafeReadBudget, requireSafeReadRoot } from "../util/safe-read.ts";
import { discoverProject } from "./discovery.ts";
import type {
	DecisionStore, DiscoveredPackage, Evidence, GateCategory, GateFinding, GateInventory, GapReport,
	ProjectDiscovery, RecipeSource, Remediation,
} from "./types.ts";

const WHY: Record<GateCategory, string> = {
	"unit-test": "Unit tests catch behavior regressions before a wave is verified.",
	lint: "Lint checks enforce the project's existing static rules consistently.",
	typecheck: "Type checking catches contract errors that a scoped diff can hide.",
	build: "A build proves the distributable application or package still assembles.",
	e2e: "Browser journeys verify integration through the UI; they are useful only when the project has user journeys.",
	"api-integration": "API integration tests exercise routing, serialization, and service boundaries together.",
	"migration-validation": "Migration validation catches invalid or non-reproducible schema changes before deployment.",
	"package-smoke": "A dry-run package smoke check catches missing artifacts and broken publish/CLI contents without installing anything.",
	"ci-parity": "Keeping loop gates aligned with literal CI commands prevents local and CI results from drifting.",
	accessibility: "Accessibility checks catch keyboard, semantics, and contrast regressions in browser surfaces.",
};

const SCRIPT_NAMES: Record<GateCategory, string[]> = {
	"unit-test": ["test", "test:unit", "unit", "unit:test"],
	lint: ["lint", "lint:check", "eslint"],
	typecheck: ["typecheck", "type-check", "check:types", "tsc"],
	build: ["build"],
	e2e: ["test:e2e", "e2e", "e2e:test", "test:browser", "playwright", "cypress"],
	"api-integration": ["test:integration", "integration", "integration:test", "test:api", "api:test"],
	"migration-validation": ["migrate:validate", "migration:validate", "db:validate", "validate:migrations", "migrate:check"],
	"package-smoke": ["test:package", "package:check", "pack:check", "smoke", "smoke:cli", "test:cli"],
	"ci-parity": [],
	accessibility: ["test:a11y", "a11y", "accessibility", "test:accessibility", "axe"],
};

/**
 * Read both recipe files without changing them; human duplicates win in effective.
 *
 * M1-P01 step (g): recipes are read through the canonical-root + no-follow,
 * capped boundary (`loadRecipeFileSafe`, the same loader the gate step uses)
 * under one shared budget. There is no production synchronous recipe read:
 * a symlinked/escaping/oversized recipe file refuses with the gate loader's
 * own message instead of being parsed.
 */
export async function inventoryGates(root: string): Promise<GateInventory> {
	const canonical = await requireSafeReadRoot(root);
	const budget = new SafeReadBudget();
	const make = async (source: "human" | "generated", file: string): Promise<RecipeSource[]> =>
		(await loadRecipeFileSafe(canonical, file, budget)).map((recipe) => ({ ...recipe, source, file: `evals/${file}`, category: categoryForRecipe(recipe) }));
	const generated = await make("generated", "recipes.auto.toml");
	const human = await make("human", "recipes.toml");
	const effective = new Map<string, RecipeSource>();
	for (const recipe of [...generated, ...human]) effective.set(recipe.name, recipe);
	return { human, generated, effective: [...effective.values()] };
}

/** Analyze a project without executing scripts or reading CI as executable YAML. */
export async function analyzeGaps(root: string, discovery?: ProjectDiscovery, decisions?: DecisionStore): Promise<GapReport> {
	const found = discovery ?? await discoverProject(root);
	const inventory = await inventoryGates(root);
	const findings: GateFinding[] = [];
	const rootPkg = found.rootPackage;
	const packages = [rootPkg, ...found.workspaces].filter((pkg): pkg is DiscoveredPackage => Boolean(pkg));

	for (const pkg of packages) {
		for (const category of ["unit-test", "lint", "typecheck", "build"] as const) {
			const script = findScript(pkg, category);
			if (script) addScriptFinding(findings, inventory, found, pkg, category, script);
		}
	}
	if (rootPkg && !findScript(rootPkg, "unit-test")) addUnresolvedUnitFinding(findings, found);

	for (const pkg of packages) {
		for (const category of ["e2e", "api-integration", "migration-validation", "package-smoke", "accessibility"] as const) {
			if (category === "package-smoke") {
				if (isPackageSurface(found, pkg)) addPackageFinding(findings, inventory, found, pkg);
				continue;
			}
			const script = findScript(pkg, category);
			if (script) addScriptFinding(findings, inventory, found, pkg, category, script);
			else if (surfaceApplies(found, pkg, category)) addSurfaceGap(findings, found, pkg, category);
		}
	}
	addNotApplicable(findings, found, "e2e", !found.surfaces.some((s) => s.kind === "web" || s.kind === "e2e"));
	addNotApplicable(findings, found, "api-integration", !found.surfaces.some((s) => s.kind === "api") && !found.apiFiles.length);
	addNotApplicable(findings, found, "migration-validation", !found.migrationFiles.length);
	addNotApplicable(findings, found, "package-smoke", !found.surfaces.some((s) => s.kind === "cli" || s.kind === "publishable-package"));
	addNotApplicable(findings, found, "accessibility", !found.surfaces.some((s) => s.kind === "web" || s.kind === "accessibility"));
	addCiFindings(findings, inventory, found);
	// An accepted script can disappear completely (so no ordinary surface
	// finding remains). Keep a stale generated recipe reviewable/removable.
	for (const previous of Object.values(decisions?.decisions ?? {})) {
		if (previous.decision !== "accepted" || !previous.recipe || findings.some((finding) => finding.id === previous.findingId)) continue;
		findings.push({
			id: previous.findingId, category: categoryForRecipe(previous.recipe) ?? "build", cwd: previous.recipe.cwd ?? ".",
			title: `Previously accepted gate: ${previous.recipe.name}`, why: "The evidence that justified this generated gate is no longer present.",
			status: "unknown", evidence: [{ path: "evals/recipes.auto.toml", detail: `previously accepted command ${previous.recipe.cmd} has no current supporting finding` }],
			recommended: false, reopened: true,
		});
	}

	for (const finding of findings) {
		const previous = decisions?.decisions[finding.id];
		if (!previous) continue;
		const generatedDrift = previous.decision === "accepted" && previous.recipe !== undefined
			&& !inventory.generated.some((recipe) => recipesEquivalent(recipe, previous.recipe!));
		if (previous.fingerprint === findingFingerprint(finding) && !generatedDrift) continue;
		// Newly covered findings close quietly. Disappearance to N/A only needs
		// review when a previously accepted generated recipe may now be stale.
		if (finding.status !== "covered" && (finding.status !== "not-applicable" || previous.recipe)) finding.reopened = true;
	}
	return { inventory, findings: findings.sort((a, b) => a.id.localeCompare(b.id)) };
}

function addScriptFinding(findings: GateFinding[], inventory: GateInventory, discovery: ProjectDiscovery, pkg: DiscoveredPackage, category: GateCategory, script: string): void {
	const cwd = pkg.cwd;
	const id = categoryId(category, cwd);
	if (findings.some((finding) => finding.id === id)) return;
	const expectedCmd = scriptCommand(discovery.packageManager, script);
	const covered = inventory.effective.some((recipe) => recipe.category === category && sameCwd(recipe.cwd, cwd)
		&& (recipe.source === "human" || recipeCommandText(recipe) === expectedCmd));
	const rootCovered = cwd !== "." && inventory.effective.some((recipe) => recipe.category === category && sameCwd(recipe.cwd, "."));
	const recommendation = covered ? undefined : { name: recipeName(category, cwd), cmd: expectedCmd, ...(cwd === "." ? {} : { cwd }) };
	findings.push({
		id, category, cwd, title: `${categoryLabel(category)} (${cwd})`, why: WHY[category],
		status: covered ? "covered" : rootCovered ? "partial" : "present-but-unwired",
		evidence: [{ path: manifestPath(cwd), detail: `script "${script}" = ${JSON.stringify(pkg.scripts[script])}` }],
		recommendation, recommended: category !== "e2e" && category !== "accessibility",
	});
}

function addUnresolvedUnitFinding(findings: GateFinding[], discovery: ProjectDiscovery): void {
	const evidence = [
		...discovery.configFiles.filter((path) => /vitest|jest/.test(path) && !path.includes("/")).map((path) => ({ path, detail: "test runner configuration exists" })),
		...discovery.testFiles.filter((path) => !foundInWorkspace(path, discovery)).slice(0, 8).map((path) => ({ path, detail: "test file exists" })),
	];
	const status = evidence.length ? "unknown" : "missing";
	findings.push({
		id: "unit-test", category: "unit-test", cwd: ".", title: "Unit tests (.)", why: WHY["unit-test"], status, evidence,
		recommended: true,
		remediation: remediation("Resolve and add a unit-test gate", "Choose the project's unit-test command and add or wire tests. Do not assume a runner from configuration alone.", ["The project has a repeatable unit-test command.", "The command is represented by an approved gate recipe."], ["test/", "tests/", "package.json"]),
	});
}

function addSurfaceGap(findings: GateFinding[], discovery: ProjectDiscovery, pkg: DiscoveredPackage, category: GateCategory): void {
	const cwd = pkg.cwd;
	const evidence = surfaceEvidence(discovery, pkg, category);
	const hasRunnerEvidence = category === "e2e" && (discovery.e2eFiles.length > 0 || discovery.configFiles.some((f) => /playwright|cypress/.test(f)));
	findings.push({
		id: categoryId(category, cwd), category, cwd, title: `${categoryLabel(category)} (${cwd})`, why: WHY[category],
		status: hasRunnerEvidence ? "unknown" : "missing", evidence, recommended: category !== "e2e" && category !== "accessibility",
		remediation: surfaceRemediation(category, cwd),
	});
}

function addPackageFinding(findings: GateFinding[], inventory: GateInventory, discovery: ProjectDiscovery, pkg: DiscoveredPackage): void {
	const script = findScript(pkg, "package-smoke");
	if (script) {
		addScriptFinding(findings, inventory, discovery, pkg, "package-smoke", script);
		return;
	}
	const covered = inventory.effective.some((recipe) => recipe.category === "package-smoke" && sameCwd(recipe.cwd, pkg.cwd));
	const canDryRun = discovery.packageManager === "npm";
	const recommendation = covered || !canDryRun ? undefined : {
		name: recipeName("package-smoke", pkg.cwd), cmd: "npm pack --dry-run --ignore-scripts",
		...(pkg.cwd === "." ? {} : { cwd: pkg.cwd }),
	};
	findings.push({
		id: categoryId("package-smoke", pkg.cwd), category: "package-smoke", cwd: pkg.cwd,
		title: `Package/CLI smoke (${pkg.cwd})`, why: WHY["package-smoke"], status: covered ? "covered" : canDryRun ? "missing" : "unknown",
		evidence: [{ path: manifestPath(pkg.cwd), detail: `${pkg.bin ? "package exposes a CLI bin" : "package is publishable (private is not true)"}; package manager is ${discovery.packageManager}` }],
		recommendation, recommended: canDryRun,
		...(!covered && !canDryRun ? { remediation: remediation("Resolve package/CLI smoke validation", "Choose a non-mutating package dry-run or smoke command appropriate for the detected package manager.", ["A repeatable package or CLI smoke command exists.", "The command is explicitly approved as a gate."], [manifestPath(pkg.cwd)]) } : {}),
	});
}

function addCiFindings(findings: GateFinding[], inventory: GateInventory, discovery: ProjectDiscovery): void {
	for (const ci of discovery.ci) {
		for (const command of ci.commands) {
			if (!safeCiCommand(command)) continue;
			const script = ciScriptName(command);
			const id = `ci-parity:${slug(script)}`;
			if (findings.some((finding) => finding.id === id)) continue;
			const covered = inventory.effective.some((recipe) => sameCwd(recipe.cwd, ".") && recipeCommandText(recipe) === command);
			findings.push({
				id, category: "ci-parity", cwd: ".", title: `CI parity: ${command}`, why: WHY["ci-parity"],
				status: covered ? "covered" : "present-but-unwired", evidence: [{ path: ci.path, detail: `literal CI run command: ${command}` }],
				recommendation: covered ? undefined : { name: `ci-${slug(script)}`, cmd: command }, recommended: true,
			});
		}
	}
}

function addNotApplicable(findings: GateFinding[], discovery: ProjectDiscovery, category: GateCategory, applies: boolean): void {
	void discovery;
	if (!applies || findings.some((finding) => finding.category === category)) return;
	findings.push({ id: category, category, cwd: ".", title: categoryLabel(category), why: WHY[category], status: "not-applicable", evidence: [], recommended: false });
}

function surfaceApplies(discovery: ProjectDiscovery, pkg: DiscoveredPackage, category: GateCategory): boolean {
	const at = (kind: string): boolean => discovery.surfaces.some((s) => s.kind === kind && (s.cwd ?? ".") === pkg.cwd);
	switch (category) {
		case "e2e": return at("web") || (pkg.cwd === "." && at("e2e"));
		case "api-integration": return at("api") || (pkg.cwd === "." && discovery.apiFiles.length > 0);
		case "migration-validation": return pkg.cwd === "." && discovery.migrationFiles.length > 0;
		case "accessibility": return at("web") || (pkg.cwd === "." && at("accessibility"));
		default: return false;
	}
}

function surfaceEvidence(discovery: ProjectDiscovery, pkg: DiscoveredPackage, category: GateCategory): Evidence[] {
	const surfaces = discovery.surfaces.filter((surface) => (surface.cwd ?? ".") === pkg.cwd && (
		category === "e2e" ? surface.kind === "web" || surface.kind === "e2e" :
		category === "api-integration" ? surface.kind === "api" :
		category === "migration-validation" ? surface.kind === "migrations" :
		surface.kind === "web" || surface.kind === "accessibility"
	));
	const paths = category === "e2e" ? discovery.e2eFiles : category === "api-integration" ? discovery.apiFiles : category === "migration-validation" ? discovery.migrationFiles : discovery.accessibilityFiles;
	return [...surfaces.map(({ path, detail }) => ({ path, detail })), ...paths.slice(0, 8).map((path) => ({ path, detail: `${categoryLabel(category)} evidence` }))];
}

function surfaceRemediation(category: GateCategory, cwd: string): Remediation {
	const prefix = cwd === "." ? "" : `${cwd}/`;
	switch (category) {
		case "e2e": return remediation("Add or wire critical browser journeys", "Review the web surface, choose only critical user journeys, and add a repeatable E2E command. Existing E2E files with no command need command resolution, not replacement tests.", ["Critical browser journeys have a repeatable command.", "The E2E gate is explicitly selected and its runtime is documented."], [`${prefix}e2e/`, `${prefix}package.json`]);
		case "api-integration": return remediation("Add API integration coverage", "Exercise the detected API routes through their external contracts and expose a repeatable integration-test command.", ["Detected API routes have integration coverage.", "An approved recipe invokes the integration suite."], [`${prefix}test/`, `${prefix}tests/`, `${prefix}package.json`]);
		case "migration-validation": return remediation("Add migration validation", "Validate the detected migrations using the project's existing database/tooling conventions and expose a deterministic validation command.", ["Migration syntax and ordering are validated.", "An approved recipe invokes migration validation."], ["migrations/", "prisma/migrations/", "package.json"]);
		case "accessibility": return remediation("Add accessibility checks", "Add focused accessibility checks for the detected browser journeys; do not infer that E2E alone covers accessibility.", ["The web surface has repeatable accessibility checks.", "An approved recipe invokes those checks."], [`${prefix}e2e/`, `${prefix}tests/`, `${prefix}package.json`]);
		default: return remediation(`Resolve ${categoryLabel(category)}`, `Resolve the detected ${category} gap and expose a deterministic command.`, ["The gap has an approved deterministic check."], [manifestPath(cwd)]);
	}
}

function remediation(title: string, spec: string, acceptance: string[], targetPaths: string[]): Remediation {
	return { title, spec, acceptance, targetPaths };
}

export function findScript(pkg: DiscoveredPackage, category: GateCategory): string | undefined {
	const conventional = SCRIPT_NAMES[category].find((name) => typeof pkg.scripts[name] === "string"
		&& !(category === "unit-test" && name === "test" && /playwright|cypress|test\/api|(?:^|\s)(?:e2e|integration)(?:\s|$)/.test(pkg.scripts[name]!)));
	if (conventional) return conventional;
	const generic = pkg.scripts["test"];
	if (!generic) return undefined;
	if (category === "e2e" && /playwright|cypress|(?:^|\s)e2e(?:\s|$)/.test(generic)) return "test";
	if (category === "api-integration" && /(?:^|\s)integration(?:\s|$)|test\/api/.test(generic)) return "test";
	if (category === "accessibility" && /axe|pa11y|a11y/.test(generic)) return "test";
	return undefined;
}

function scriptCommand(manager: ProjectDiscovery["packageManager"], script: string): string {
	if (script === "test") return manager === "npm" ? "npm test" : manager === "bun" ? "bun test" : `${manager} test`;
	return manager === "npm" || manager === "bun" ? `${manager} run ${script}` : `${manager} ${script}`;
}

export function categoryForRecipe(recipe: Recipe): GateCategory | undefined {
	const value = `${recipe.name} ${recipeCommandText(recipe)}`.toLowerCase();
	if (/a11y|accessibility|axe|pa11y/.test(value)) return "accessibility";
	if (/e2e|playwright|cypress/.test(value)) return "e2e";
	if (/integration|test:api|api:test/.test(value)) return "api-integration";
	if (/migrat|db:validate/.test(value)) return "migration-validation";
	if (/pack|package-smoke|smoke:cli|test:cli/.test(value)) return "package-smoke";
	if (/typecheck|type-check|check:types|\btsc\b/.test(value)) return "typecheck";
	if (/lint|eslint/.test(value)) return "lint";
	if (/build/.test(value)) return "build";
	if (/(?:^|\s)(?:unit-test|test:unit)|npm test|pnpm test|yarn test|bun test|node --test|vitest|jest/.test(value)) return "unit-test";
	return undefined;
}


function sameCwd(a: string | undefined, b: string): boolean {
	return (a ?? ".") === b;
}

function isPackageSurface(discovery: ProjectDiscovery, pkg: DiscoveredPackage): boolean {
	return discovery.surfaces.some((s) => (s.cwd ?? ".") === pkg.cwd && (s.kind === "cli" || s.kind === "publishable-package"));
}

function manifestPath(cwd: string): string {
	return cwd === "." ? "package.json" : `${cwd}/package.json`;
}

function categoryId(category: GateCategory, cwd: string): string {
	return cwd === "." ? category : `${category}:${cwd}`;
}

function recipeName(category: GateCategory, cwd: string): string {
	return cwd === "." ? category : `${category}-${slug(cwd)}`;
}

function categoryLabel(category: GateCategory): string {
	return ({
		"unit-test": "Unit tests", lint: "Lint", typecheck: "Typecheck", build: "Build", e2e: "E2E browser journeys",
		"api-integration": "API integration", "migration-validation": "Migration validation", "package-smoke": "Package/CLI smoke",
		"ci-parity": "CI parity", accessibility: "Accessibility",
	})[category];
}

function safeCiCommand(command: string): boolean {
	// M0-P07: only commands that can load as a legacy cmd-form recipe (no shell
	// quoting/pipes/expansions) are recommended for generation; non-simple CI
	// evidence stays a reportable finding, not an unloadable generated recipe.
	return /^(?:npm (?:test|run [a-zA-Z0-9:_-]+)|pnpm (?:test|run [a-zA-Z0-9:_-]+)|yarn (?:test|run [a-zA-Z0-9:_-]+|[a-zA-Z0-9:_-]+)|bun (?:test|run [a-zA-Z0-9:_-]+))(?:\s+--\s+.*)?$/.test(command)
		&& !/(?:^|\s)(?:ci|install|add|remove|exec|dlx)(?:\s|$)/.test(command)
		&& isSimpleCommand(command);
}

function ciScriptName(command: string): string {
	const tokens = command.split(/\s+/);
	if (tokens[1] === "run") return tokens[2] ?? "check";
	return tokens[1] ?? "check";
}

function foundInWorkspace(path: string, discovery: ProjectDiscovery): boolean {
	return discovery.workspaces.some((workspace) => path.startsWith(`${workspace.cwd}/`));
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "check";
}

export function findingFingerprint(finding: GateFinding): string {
	const material = JSON.stringify({
		id: finding.id, evidence: finding.evidence, recommendation: finding.recommendation ?? null,
		remediation: finding.remediation ?? null,
	});
	return createHash("sha256").update(material).digest("hex");
}

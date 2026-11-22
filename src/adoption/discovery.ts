/** Deterministic, read-only project discovery. No discovered command is executed. */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
	CiEvidence,
	DiscoveredPackage,
	PackageManager,
	ProjectDiscovery,
	SurfaceKind,
	WorkspaceDiscovery,
} from "./types.ts";

const IGNORED = new Set([".git", ".orch", "node_modules", "dist", "build", "coverage", ".next", ".turbo"]);
const CONFIG_FILES = new Set([
	"vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vitest.config.mjs",
	"jest.config.ts", "jest.config.js", "jest.config.cjs", "jest.config.mjs",
	"playwright.config.ts", "playwright.config.js", "cypress.config.ts", "cypress.config.js",
	"eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".eslintrc", ".eslintrc.json",
	"tsconfig.json", "jsconfig.json", "next.config.js", "next.config.mjs", "next.config.ts",
	"nuxt.config.ts", "astro.config.mjs", "svelte.config.js", "vite.config.ts", "vite.config.js",
	"axe.config.js", ".pa11yci", ".pa11yci.json",
]);
const LOCKFILES: Array<[string, PackageManager]> = [
	["package-lock.json", "npm"], ["npm-shrinkwrap.json", "npm"], ["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"],
];
const CI_COMMAND = /^\s*(?:-\s*)?run:\s*["']?((?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[a-zA-Z0-9:_-]+(?:\s+--\s+[^"'#]+)?)\s*["']?\s*(?:#.*)?$/;

interface PackageJson {
	name?: string;
	private?: boolean;
	scripts?: Record<string, unknown>;
	dependencies?: Record<string, unknown>;
	devDependencies?: Record<string, unknown>;
	bin?: string | Record<string, unknown>;
	workspaces?: string[] | { packages?: string[] };
}

/** Discover package and CI facts only. The returned arrays are sorted by path. */
export async function discoverProject(root: string): Promise<ProjectDiscovery> {
	root = resolve(root);
	const files = await walk(root);
	const fileSet = new Set(files);
	const lockfiles = LOCKFILES.map(([file]) => file).filter((file) => fileSet.has(file));
	const packageManager = LOCKFILES.find(([file]) => fileSet.has(file))?.[1] ?? "npm";
	const warnings: string[] = [];
	const rootJson = await readPackage(root, "package.json", fileSet, warnings);
	const rootPackage = rootJson ? normalizePackage(rootJson, ".") : undefined;
	const patterns = workspacePatterns(rootJson);
	const workspaces: WorkspaceDiscovery[] = [];
	for (const path of files.filter((f) => f.endsWith("/package.json") && f !== "package.json")) {
		const cwd = path.slice(0, -"/package.json".length);
		if (!patterns.some((pattern) => matchesWorkspace(cwd, pattern))) continue;
		const json = await readPackage(root, path, fileSet, warnings);
		if (!json) continue;
		workspaces.push({ ...normalizePackage(json, cwd), manifest: path });
	}
	workspaces.sort((a, b) => a.cwd.localeCompare(b.cwd));

	const configFiles = files.filter((file) => CONFIG_FILES.has(baseName(file)));
	const testFiles = files.filter((file) => isTest(file) && !isE2E(file));
	const e2eFiles = files.filter(isE2E);
	const migrationFiles = files.filter(isMigration);
	const apiFiles = files.filter(isApiRoute);
	const accessibilityFiles = files.filter((file) => /(?:^|\/)(?:axe|pa11y|a11y)[./_-]/i.test(file) || /accessibility/i.test(file));
	const ci = readCiEvidence(files.map((path) => ({ path, root })));
	const ciEvidence: CiEvidence[] = [];
	for (const item of ci) {
		const raw = await readFile(join(root, item), "utf8");
		const commands = raw.split(/\r?\n/).map((line) => line.match(CI_COMMAND)?.[1]?.trim()).filter((cmd): cmd is string => Boolean(cmd));
		if (commands.length) ciEvidence.push({ path: item, commands: [...new Set(commands)] });
	}

	const surfaces: ProjectDiscovery["surfaces"] = [];
	for (const pkg of [rootPackage, ...workspaces].filter((pkg): pkg is DiscoveredPackage => Boolean(pkg))) {
		addPackageSurfaces(surfaces, pkg);
	}
	if (migrationFiles.length) surfaces.push({ kind: "migrations", path: migrationFiles[0]!, detail: `${migrationFiles.length} migration file(s)` });
	if (e2eFiles.length || configFiles.some((f) => /playwright|cypress/.test(f))) {
		surfaces.push({ kind: "e2e", path: e2eFiles[0] ?? configFiles.find((f) => /playwright|cypress/.test(f))!, detail: "browser-test files or configuration" });
	}
	if (accessibilityFiles.length || configFiles.some((f) => /axe|pa11y/.test(f)) || hasDep(rootPackage, /^(?:@axe-core\/|pa11y)/)) {
		surfaces.push({ kind: "accessibility", path: accessibilityFiles[0] ?? "package.json", detail: "accessibility tooling or tests" });
	}

	return {
		root, packageManager, lockfiles, rootPackage, workspaces,
		configFiles: configFiles.sort(), testFiles: testFiles.sort(), e2eFiles: e2eFiles.sort(),
		migrationFiles: migrationFiles.sort(), apiFiles: apiFiles.sort(), accessibilityFiles: accessibilityFiles.sort(),
		ci: ciEvidence.sort((a, b) => a.path.localeCompare(b.path)),
		surfaces: dedupeSurfaces(surfaces), warnings: warnings.sort(),
	};
}

async function walk(root: string): Promise<string[]> {
	const out: string[] = [];
	async function visit(dir: string): Promise<void> {
		const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (IGNORED.has(entry.name)) continue;
			const path = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) out.push(path);
		}
	}
	await visit("");
	return out.sort();
}

async function readPackage(root: string, path: string, files: Set<string>, warnings: string[]): Promise<PackageJson | undefined> {
	if (!files.has(path)) return undefined;
	try {
		return JSON.parse(await readFile(join(root, path), "utf8")) as PackageJson;
	} catch (err) {
		warnings.push(`${path}: unreadable package.json (${(err as Error).message})`);
		return undefined;
	}
}

function normalizePackage(json: PackageJson, cwd: string): DiscoveredPackage {
	const bin = typeof json.bin === "string"
		? { [json.name ?? "package"]: json.bin }
		: json.bin && typeof json.bin === "object" ? stringRecord(json.bin) : undefined;
	return {
		name: json.name ?? (cwd === "." ? baseName(cwd) : cwd), cwd, private: json.private === true,
		scripts: stringRecord(json.scripts), dependencies: stringRecord(json.dependencies),
		devDependencies: stringRecord(json.devDependencies), bin,
	};
}

function stringRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function workspacePatterns(json: PackageJson | undefined): string[] {
	if (!json) return [];
	if (Array.isArray(json.workspaces)) return json.workspaces.filter((x): x is string => typeof x === "string");
	return json.workspaces?.packages?.filter((x): x is string => typeof x === "string") ?? [];
}

function matchesWorkspace(path: string, pattern: string): boolean {
	const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
	if (!normalized.includes("*")) return path === normalized;
	const expression = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replaceAll("\u0000", ".*");
	return new RegExp(`^${expression}$`).test(path);
}

function addPackageSurfaces(out: ProjectDiscovery["surfaces"], pkg: DiscoveredPackage): void {
	const scripts = Object.values(pkg.scripts).join("\n");
	const manifest = pkg.cwd === "." ? "package.json" : `${pkg.cwd}/package.json`;
	const add = (kind: SurfaceKind, detail: string): void => { out.push({ kind, path: manifest, cwd: pkg.cwd, detail }); };
	// A dependency alone does not make a library a browser application. Require
	// an app-style dev/start script (or a root app config) before suggesting E2E.
	if (/(?:^|\s)(?:vite|next|nuxt|astro|react-scripts|vue-cli-service|ng serve|svelte-kit)(?:\s|$)/m.test(scripts)
		&& Object.entries(pkg.scripts).some(([name]) => name === "dev" || name === "start")) add("web", "app-style dev/start script");
	if (/(?:express|fastify|koa|hono|nestjs|next\/server)/.test(`${Object.keys(pkg.dependencies).join(" ")}\n${scripts}`)) add("api", "server framework or API script");
	if (pkg.bin && Object.keys(pkg.bin).length) add("cli", `bin entries: ${Object.keys(pkg.bin).join(", ")}`);
	if (!pkg.private || (pkg.bin && Object.keys(pkg.bin).length)) add("publishable-package", pkg.private ? "CLI package" : "package.json is not private");
}

function hasDep(pkg: DiscoveredPackage | undefined, pattern: RegExp): boolean {
	return Boolean(pkg && Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((name) => pattern.test(name)));
}

function dedupeSurfaces(surfaces: ProjectDiscovery["surfaces"]): ProjectDiscovery["surfaces"] {
	const seen = new Set<string>();
	return surfaces.filter((surface) => {
		const key = `${surface.kind}:${surface.cwd ?? ""}:${surface.path}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	}).sort((a, b) => `${a.kind}:${a.path}`.localeCompare(`${b.kind}:${b.path}`));
}

function readCiEvidence(files: Array<{ path: string; root: string }>): string[] {
	void files;
	return files.map((f) => f.path).filter((path) => /^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/.test(path) || /^\.gitlab-ci\.ya?ml$/.test(path));
}

function baseName(path: string): string {
	const parts = path.split(/[\\/]/);
	return parts[parts.length - 1] ?? path;
}

function isTest(path: string): boolean {
	return /(?:^|\/)(?:tests?|__tests__|spec)\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function isE2E(path: string): boolean {
	return /(?:^|\/)(?:e2e|playwright|cypress)(?:\/|\.)/i.test(path) || /(?:e2e|playwright|cypress)\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path);
}

function isMigration(path: string): boolean {
	return /(?:^|\/)(?:migrations?|db\/migrations|prisma\/migrations)\//i.test(path) && /\.(?:sql|[cm]?[jt]s)$/i.test(path);
}

function isApiRoute(path: string): boolean {
	return /(?:^|\/)(?:app|pages|src)\/api\//i.test(path) || /(?:^|\/)routes?\//i.test(path) && /\.[cm]?[jt]s$/i.test(path);
}

/** Resolve a recipe cwd without permitting an absolute or parent escape.
 *
 * M0-P07: the ONE canonical validator lives with the shared runner
 * (`engine/recipe-runner.ts`) and additionally rejects real-path escapes —
 * a symlink inside the project pointing outside it refuses before any spawn.
 * Re-exported here for the adoption modules. */
export { safeRecipeCwdReal as safeRecipeCwd } from "../engine/recipe-runner.ts";

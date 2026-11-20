import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeGaps, inventoryGates } from "../src/adoption/gaps.ts";

async function project(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "kit-gaps-"));
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), content, "utf8");
	}
	return root;
}
const manifest = (value: unknown) => JSON.stringify(value);

describe("cross-cutting gate gaps", () => {
	it("does not recommend browser journeys for a library", async () => {
		const root = await project({ "package.json": manifest({ name: "library", scripts: { test: "node --test" }, dependencies: { react: "1.0.0" } }) });
		const report = await analyzeGaps(root);
		const e2e = report.findings.find((f) => f.id === "e2e");
		expect(e2e).toMatchObject({ status: "not-applicable" });
		expect(e2e).not.toHaveProperty("recommendation");
		expect(e2e).not.toHaveProperty("remediation");
	});

	it("reports an existing E2E script without requiring separate web or config evidence", async () => {
		const root = await project({ "package.json": manifest({ name: "app", private: true, scripts: { "test:e2e": "playwright test" } }) });
		const report = await analyzeGaps(root);
		expect(report.findings.find((f) => f.id === "e2e")).toMatchObject({
			status: "present-but-unwired",
			recommendation: { cmd: "npm run test:e2e" },
		});
	});

	it("distinguishes missing E2E, unwired E2E, and uncovered workspaces", async () => {
		const missingRoot = await project({ "package.json": manifest({ name: "app", private: true, scripts: { dev: "vite", test: "vitest run" } }) });
		const missing = await analyzeGaps(missingRoot);
		expect(missing.findings.find((f) => f.id === "e2e")).toMatchObject({ status: "missing" });
		expect(missing.findings.find((f) => f.id === "e2e")).not.toHaveProperty("recommendation");
		expect(missing.findings.find((f) => f.id === "e2e")?.remediation?.title).toMatch(/browser/i);

		const wiredRoot = await project({
			"package.json": manifest({ name: "app", private: true, workspaces: ["packages/*"], scripts: { dev: "vite", "test:e2e": "playwright test", test: "vitest run" } }),
			"packages/web/package.json": manifest({ name: "web", private: true, scripts: { test: "vitest run" } }),
			"evals/recipes.toml": '[unit-test]\ncmd = "npm test"\n',
		});
		const wired = await analyzeGaps(wiredRoot);
		expect(wired.findings.find((f) => f.id === "e2e")).toMatchObject({ status: "present-but-unwired", recommendation: { cmd: "npm run test:e2e" }, recommended: false });
		expect(wired.findings.find((f) => f.id === "unit-test:packages/web")).toMatchObject({ status: "partial", recommendation: { cmd: "npm test", cwd: "packages/web" } });
	});

	it("reports API, migration, package, CI, accessibility, and unresolved-test evidence", async () => {
		const root = await project({
			"package.json": manifest({
				name: "service", scripts: { dev: "vite", "test:integration": "node --test test/api", "migrate:validate": "node validate-migrations.js", "test:a11y": "axe" },
				bin: { service: "dist/cli.js" }, dependencies: { express: "1.0.0" },
			}),
			"migrations/001.sql": "select 1;",
			"vitest.config.ts": "export default {}",
			".github/workflows/ci.yml": "- run: npm run build\n",
			"evals/recipes.toml": "",
		});
		const report = await analyzeGaps(root);
		expect(report.findings.find((f) => f.id === "api-integration")).toMatchObject({ status: "present-but-unwired", recommendation: { cmd: "npm run test:integration" } });
		expect(report.findings.find((f) => f.id === "migration-validation")).toMatchObject({ status: "present-but-unwired" });
		expect(report.findings.find((f) => f.id === "package-smoke")).toMatchObject({ status: "missing", recommendation: { cmd: "npm pack --dry-run --ignore-scripts" } });
		expect(report.findings.find((f) => f.id === "accessibility")).toMatchObject({ status: "present-but-unwired" });
		expect(report.findings.find((f) => f.id === "unit-test")).toMatchObject({ status: "unknown" });
		expect(report.findings.find((f) => f.id === "unit-test")).not.toHaveProperty("recommendation");
		expect(report.findings.find((f) => f.id === "ci-parity:build")).toMatchObject({ status: "present-but-unwired", recommendation: { cmd: "npm run build" } });
	});

	it("inventories factual human and generated gates", async () => {
		const root = await project({
			"evals/recipes.toml": '[human]\ncmd = "npm run human"\n',
			"evals/recipes.auto.toml": '[generated]\ncmd = "npm run generated"\n',
		});
		const inventory = inventoryGates(root);
		expect(inventory.human.map((r) => r.name)).toEqual(["human"]);
		expect(inventory.generated.map((r) => r.name)).toEqual(["generated"]);
	});
});

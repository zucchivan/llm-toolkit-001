import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverProject } from "../src/adoption/discovery.ts";

async function project(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "kit-adopt-"));
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), content, "utf8");
	}
	return root;
}

describe("project discovery", () => {
	it("reads scripts, lockfiles, workspaces, tool configuration, and conservative CI evidence without executing them", async () => {
		const root = await project({
			"package.json": JSON.stringify({
				name: "web-root",
				private: true,
				workspaces: ["packages/*"],
				scripts: { test: "vitest run", build: "tsc", dev: "vite" },
				devDependencies: { vite: "1.0.0", vitest: "1.0.0" },
			}),
			"package-lock.json": "{}",
			"vitest.config.ts": "export default {}",
			"packages/web/package.json": JSON.stringify({ name: "@x/web", scripts: { test: "vitest run", dev: "vite" } }),
			".github/workflows/ci.yml": "steps:\n  - run: npm test\n  - run: npm run build\n",
		});

		const result = await discoverProject(root);
		expect(result.packageManager).toBe("npm");
		expect(result.lockfiles).toEqual(["package-lock.json"]);
		expect(result.rootPackage?.scripts).toMatchObject({ test: "vitest run", build: "tsc" });
		expect(result.workspaces.map((w) => w.cwd)).toEqual(["packages/web"]);
		expect(result.configFiles).toContain("vitest.config.ts");
		expect(result.ci).toEqual([
			expect.objectContaining({ path: ".github/workflows/ci.yml", commands: ["npm test", "npm run build"] }),
		]);
		expect(result.surfaces).toContainEqual(expect.objectContaining({ kind: "web" }));
	});
});

/**
 * M0-P02 — the pinned SDK seam is mechanical, not conventional.
 *
 *  1. No src/test/ui file outside src/engine/kit.ts may reference
 *     `@earendil-works/pi-durable` or `@earendil-works/pi-ai` — not as a
 *     static import, not as a type-only import, not as a re-export, not as a
 *     literal `require("…")`, and not as a dynamic `import("…")`. The scan
 *     uses the TypeScript AST (typescript is a devDependency), so comments,
 *     string contents, and formatting cannot fake or break the check the way
 *     a grep could.
 *  2. docs/api-map.md's kit.ts section names ACTUAL kit.ts exports: every
 *     export listed there must be exported by kit.ts (an AST export
 *     inventory — this is what catches imaginary exports such as the old
 *     `wrapTool` / `SystemEntry` claims).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url))); // test/ → repo root
const SEAM = join("src", "engine", "kit.ts");
const SDK_PACKAGES = ["@earendil-works/pi-durable", "@earendil-works/pi-ai"] as const;
const SCAN_ROOTS = ["src", "test", join("ui", "src"), join("ui", "server"), join("ui", "test")];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".js"]);

const sdkPackageOf = (specifier: string): string | undefined =>
	SDK_PACKAGES.find((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));

function collectSourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry.startsWith(".")) continue;
		const abs = join(dir, entry);
		if (statSync(abs).isDirectory()) collectSourceFiles(abs, out);
		else if (SCAN_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) out.push(abs);
	}
	return out;
}

/** Every pi-durable/pi-ai module reference in one file, as `specifier` strings. */
function findSdkReferences(file: string): string[] {
	const kind = file.endsWith(".mjs") || file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, /* setParentNodes */ true, kind);
	const hits: string[] = [];
	const record = (node: ts.Expression | undefined): void => {
		if (node !== undefined && ts.isStringLiteral(node)) {
			const pkg = sdkPackageOf(node.text);
			if (pkg !== undefined) hits.push(node.text);
		}
	};
	const visit = (node: ts.Node): void => {
		// import … from "…"  |  export … from "…"  (covers `import type …`)
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			record(node.moduleSpecifier);
		} else if (ts.isImportEqualsDeclaration(node)) {
			// import x = require("…")
			if (ts.isExternalModuleReference(node.moduleReference)) record(node.moduleReference.expression);
		} else if (ts.isCallExpression(node)) {
			// literal require("…") and dynamic import("…")
			const callee = node.expression;
			if ((ts.isIdentifier(callee) && callee.text === "require") || callee.kind === ts.SyntaxKind.ImportKeyword) {
				record(node.arguments[0]);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return hits;
}

/** Exported names of a module, values and types alike (AST inventory). */
function collectExportedNames(file: string): Set<string> {
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
	const names = new Set<string>();
	const isExported = (node: ts.Node): boolean =>
		ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
	const visit = (node: ts.Node): void => {
		if (ts.isExportDeclaration(node)) {
			// export { a, b } / export type { a, b } (from any module, incl. local)
			if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
				for (const el of node.exportClause.elements) names.add(el.name.text);
			}
		} else if (ts.isVariableStatement(node) && isExported(node)) {
			for (const decl of node.declarationList.declarations) {
				if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
			}
		} else if (
			(ts.isFunctionDeclaration(node) ||
				ts.isClassDeclaration(node) ||
				ts.isTypeAliasDeclaration(node) ||
				ts.isInterfaceDeclaration(node) ||
				ts.isEnumDeclaration(node)) &&
			isExported(node) &&
			node.name !== undefined
		) {
			names.add(node.name.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return names;
}

describe("pinned SDK import seam (M0-P02)", () => {
	it("rejects any pi-durable/pi-ai reference outside src/engine/kit.ts (AST, incl. require/dynamic import)", () => {
		const violations: string[] = [];
		for (const root of SCAN_ROOTS) {
			for (const file of collectSourceFiles(join(repoRoot, root))) {
				if (relative(repoRoot, file) === SEAM) continue;
				for (const specifier of findSdkReferences(file)) {
					violations.push(`${relative(repoRoot, file)}: \`${specifier}\``);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	it("keeps the seam real: kit.ts is the file that imports the pinned SDK", () => {
		const hits = findSdkReferences(join(repoRoot, SEAM));
		for (const pkg of SDK_PACKAGES) {
			expect(hits.some((h) => h === pkg || h.startsWith(`${pkg}/`))).toBe(true);
		}
	});

	it("every SDK export listed in docs/api-map.md's kit.ts section resolves from kit.ts", () => {
		const apiMap = readFileSync(join(repoRoot, "docs", "api-map.md"), "utf8");
		const section = apiMap.split("## src/engine/kit.ts")[1]?.split(/^## /m)[0];
		expect(section).toBeDefined();
		// Inline-code tokens in the kit.ts section are export names by contract;
		// the check below fails if the doc drifts from the actual seam surface
		// (including imaginary exports like the former wrapTool/SystemEntry).
		const listed = new Set<string>();
		for (const m of section!.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g)) listed.add(m[1]!);
		expect(listed.size).toBeGreaterThan(0);
		const exported = collectExportedNames(join(repoRoot, SEAM));
		const unresolved = [...listed].filter((name) => !exported.has(name));
		expect(unresolved).toEqual([]);
	});

	it("documents the pinned ExecutionEnv surface and P02 transport disposition", () => {
		const apiMap = readFileSync(join(repoRoot, "docs", "api-map.md"), "utf8");
		const kitSection = apiMap.split("## src/engine/kit.ts")[1]?.split(/^## /m)[0] ?? "";
		const guestSection = apiMap.split("## src/sandbox/{protocol,guest-env,guest-helper,types}.ts — M1-P02")[1] ?? "";
		for (const name of [
			"ExecutionEnv", "FileSystem", "Shell", "Result", "FileError", "ExecutionError", "BinaryReader",
			"TextLineReader", "DirReader", "LineScan", "ShellExecOptions", "ShellOutputInfo", "WatchTarget",
		]) expect(kitSection).toContain(`\`${name}\``);
		for (const contract of ["1 MiB", "64 KiB", "listFiles", "watch", "cancel", "not_supported", "NodeExecutionEnv"])
			expect(guestSection).toContain(contract);
	});
});

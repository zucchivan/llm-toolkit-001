/** helpers2: gate fixture writer (evals/recipes.toml + eval-gate.cjs). */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const GATE = `const fs = require("node:fs");
const files = [];
(function walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === ".git" || e.name === ".orch" || e.name.startsWith(".baseline")) continue;
		const p = dir + "/" + e.name;
		if (e.isDirectory()) walk(p);
		else if (e.name.endsWith(".ts")) files.push(p);
	}
})(".");
if (files.map((p) => fs.readFileSync(p, "utf8")).some((t) => t.includes("BROKEN"))) {
	console.error("src contains the BROKEN token");
	process.exit(1);
}
`;

/** Write the BROKEN-token gate into the project + a recipes.toml wiring it. */
export async function writeGateFile(root: string): Promise<void> {
	await mkdir(join(root, "evals"), { recursive: true });
	await writeFile(join(root, "eval-gate.cjs"), GATE, "utf8");
	await writeFile(join(root, "evals", "recipes.toml"), `[broken-gate]\ncmd = "node eval-gate.cjs"\n`, "utf8");
}

import { mkdir } from "node:fs/promises";

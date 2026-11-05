// gate: fail when any src file contains BROKEN
const fs = require("node:fs");
const files = [];
(function walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === ".git" || e.name === ".orch" || e.name.startsWith(".baseline")) continue;
		const p = dir + "/" + e.name;
		if (e.isDirectory()) walk(p);
		else if (e.name.endsWith(".ts")) files.push(p);
	}
})(".");
if (files.map(p => fs.readFileSync(p, "utf8")).some(t => t.includes("BROKEN"))) { console.error("src contains BROKEN"); process.exit(1); }

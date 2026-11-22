#!/usr/bin/env node
/**
 * smoke-gate.cjs — the demo's behavioral gate (M0-P08: the demo is falsifiable
 * at runtime).
 *
 * These are the REVIEWED bytes: every demo builder copies this file to
 * `evals/smoke-gate.cjs` at demo setup and the fixture's `evals/recipes.toml`
 * (the ONE recipe file) invokes it with one literal argv subcommand per gate:
 *
 *   gate-list   always runs. Executes the parser + renderer:
 *               parseList('/a/-b') must be ['a','b'] (ONE leading dash is
 *               stripped, the token is kept — not dropped),
 *               parseList('/foo/bar baz,-qux') must be
 *               ['foo','bar baz','qux'], renderList(['a','b']) must be 'a b'.
 *   gate-query  runs on src/query.ts or bin/. Requires an ACTUAL
 *               case-insensitive result — a case-sensitive implementation
 *               fails both probes.
 *   gate-cli    runs on bin/. Spawns `node bin/render.js /a/-b` (literal argv,
 *               no shell) and requires exit 0 AND stdout exactly `a b\n`;
 *               the bytes are forwarded, so the recipe's `match` proves them
 *               again through the runner.
 *
 * The assertions EXECUTE the product's modules and CLI; they never grep file
 * contents. A missing module, a missing export or a wrong result prints one
 * compact reason to stderr and exits 1. `evals/` is a protected review
 * control: a task cannot rewrite the checks that judge it.
 *
 * Requires Node >= 23.6: the demo product's src/*.ts modules are imported
 * directly, relying on Node's default TypeScript type-stripping.
 */
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

// The script lives in <project>/evals/; the product under test is the project.
const root = path.resolve(__dirname, "..");

function fail(message) {
	console.error(`smoke-gate: ${message}`);
	process.exit(1);
}

function firstLine(text) {
	return (text || "").trim().split("\n")[0] ?? "";
}

function deepEqual(actual, want, what) {
	if (JSON.stringify(actual) !== JSON.stringify(want)) {
		fail(`${what} got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`);
	}
}

async function importProductModule(relative) {
	try {
		return await import(pathToFileURL(path.join(root, relative)).href);
	} catch (err) {
		if (err && err.code === "ERR_UNKNOWN_FILE_EXTENSION") {
			fail(`${relative} could not be imported (${err.message}) — the demo needs Node >= 23.6 for TypeScript type-stripping`);
		}
		fail(`${relative} could not be imported: ${err && err.message ? err.message : err}`);
	}
}

/** gate-list: parser + renderer, executed. */
async function checkList() {
	const list = await importProductModule("src/list.ts");
	if (typeof list.parseList !== "function") fail("src/list.ts does not export parseList");
	deepEqual(list.parseList("/a/-b"), ["a", "b"], "parseList('/a/-b') must strip one leading dash and keep the token");
	deepEqual(list.parseList("/foo/bar baz,-qux"), ["foo", "bar baz", "qux"], "parseList('/foo/bar baz,-qux')");
	if (typeof list.renderList !== "function") fail("src/list.ts does not export renderList");
	const rendered = list.renderList(["a", "b"]);
	if (rendered !== "a b") fail(`renderList(['a','b']) got ${JSON.stringify(rendered)}, want "a b"`);
}

/** gate-query: an actual case-insensitive filter, executed. */
async function checkQuery() {
	const query = await importProductModule("src/query.ts");
	if (typeof query.queryList !== "function") fail("src/query.ts does not export queryList");
	const lowered = query.queryList(["alpha"], "A");
	if (!Array.isArray(lowered) || !lowered.includes("alpha")) {
		fail(`queryList(['alpha'], 'A') must match case-insensitively (got ${JSON.stringify(lowered)})`);
	}
	const mixed = query.queryList(["Alpha", "beta"], "AL");
	if (!Array.isArray(mixed) || !mixed.includes("Alpha")) {
		fail(`queryList(['Alpha','beta'], 'AL') must match case-insensitively (got ${JSON.stringify(mixed)})`);
	}
	deepEqual(query.queryList(["alpha", "beta"], "zz"), [], "queryList must not match everything");
}

/** gate-cli: the independent child invocation — status 0 AND stdout exactly
 * `a b\n`; the bytes are forwarded so the recipe's ALL-match proves them again
 * through the runner. */
function checkCli() {
	const res = spawnSync(process.execPath, ["bin/render.js", "/a/-b"], {
		cwd: root,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
	});
	if (res.error) fail(`node bin/render.js /a/-b could not start: ${res.error.message}`);
	if (res.status !== 0) {
		fail(`node bin/render.js /a/-b exited ${res.status === null ? "?" : res.status}: ${firstLine(res.stderr)}`);
	}
	if (res.stdout !== "a b\n") {
		fail(`node bin/render.js /a/-b must print exactly "a b" (got ${JSON.stringify(res.stdout)})`);
	}
	process.stdout.write(res.stdout); // forward: the recipe's match re-proves it
}

const checks = { list: checkList, query: checkQuery, cli: checkCli };
const check = checks[process.argv[2]];
if (typeof check !== "function") {
	fail(`unknown subcommand ${JSON.stringify(process.argv[2] ?? "")} — expected list|query|cli`);
}
Promise.resolve()
	.then(check)
	.catch((err) => fail(err && err.message ? err.message : String(err)));

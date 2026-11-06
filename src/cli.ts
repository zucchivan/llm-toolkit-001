#!/usr/bin/env node
/**
 * llm-toolkit-001 — durable agent implementation loop CLI.
 * Commands: init · plan · run · status · verify · export · handoff.
 * Arg parsing: node:util parseArgs — no heavy framework.
 * Process exit codes: 0 done/complete · 1 error (incl. lock busy) ·
 * 42 "sleeping until provider reset" (rerun `run` to resume).
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { cwd as procCwd } from "node:process";
import { createRequire } from "node:module";
const pjson = createRequire(import.meta.url)("../package.json") as { name?: string; version: string };
import { initProject } from "./init.ts";
import { KIT_VERSION, ConfigError } from "./config.ts";
import { openProjectHarness, projectPaths, flushStated, LockBusyError } from "./engine/harness.ts";
import { readout, INSPECT_SECTIONS } from "./engine/inspector.ts";
import { readSessionState } from "./engine/state.ts";
import { loadPrd, runPlan, PlanParseError } from "./engine/planner.ts";
import { runWaves } from "./engine/waves.ts";
import type { ProgressEvent } from "./engine/driver-events.ts";
import { renderInspectPanel } from "./views/inspect.ts";
import { renderStatusPanel } from "./views/status.ts";
import { writeExports } from "./views/export.ts";
import { runVerify } from "./engine/verifier.ts";
import { readJson, atomicWriteJson } from "./util/fsx.ts";

const CLI_NAME = pjson.name ?? "llm-toolkit-001";
const we = console;
const RESET = "\x1b[0m";
const c = process.env["NO_COLOR"]
	? { red: "", yellow: "", cyan: "", green: "" }
	: { red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", green: "\x1b[32m" };

function main(): void {
	const argv = process.argv.slice(2);
	const command = argv[0];
	const rest = argv.slice(1);
	if (!command || command === "--help" || command === "-h") {
		we.log(HELP());
		process.exitCode = 0;
		return;
	}
	switch (command) {
		case "init":
			void cmdInit(rest);
			break;
		case "plan":
			void cmdPlan(rest);
			break;
		case "run":
			void cmdRun(rest);
			break;
		case "status":
			void cmdStatus(rest);
			break;
		case "inspect":
			void cmdInspect(rest);
			break;
		case "verify":
			void cmdVerify(rest);
			break;
		case "export":
			void cmdExport();
			break;
		case "handoff":
			void cmdHandoff(rest);
			break;
		default:
			we.error(`unknown command: ${command}\n\n${HELP()}`);
			process.exitCode = 1;
	}
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function cmdInit(argv: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { "with-demo": { type: "boolean", default: false } },
		strict: false,
	});
	try {
		const root = resolve(positionals[0] ?? procCwd());
		const report = await initProject(root, { withDemo: values["with-demo"] === true });
		we.log(`${c.green}init ok${RESET} in ${root}`);
		we.log(`  written: ${report.written.length ? report.written.join(", ") : "(nothing missing)"}`);
		if (report.skipped.length) we.log(`  ${c.yellow}kept existing (not clobbered):${RESET} ${report.skipped.join(", ")}`);
		if (report.appended.length) we.log(`  gitignore: ${report.appended.length} lines appended`);
		we.log(`\nnext: write ${c.cyan}docs/prd.md${RESET}, then ${c.cyan}${CLI_NAME} plan${RESET}`);
	} catch (err) {
		fail(err, "init");
	}
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

async function cmdPlan(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: { prd: { type: "string" } },
		strict: false,
	});
	let kit: Awaited<ReturnType<typeof openProjectHarness>> | undefined;
	try {
		const root = resolve(procCwd());
		kit = await openProjectHarness(root, "plan");
		const prdPath = (values["prd"] as string | undefined) ?? kit.loop.config.paths.prd;
		const prdText = await loadPrd(kit, prdPath);
		const outcome = await runPlan(kit, prdPath, prdText);
		we.log(`${c.green}PLANNED${RESET} — ${outcome.tasks.length} task(s) written to router.md`);
		for (const t of outcome.tasks) we.log(`  [${t.id}] ${t.title}`);
		we.log(`\nreview the graph (edit router.md if you wish), then: ${c.cyan}${CLI_NAME} run --approve${RESET}`);
		await kit.loop.close();
		kit.lock.release();
	} catch (err) {
		kit?.lock.release();
		fail(err, "plan");
	}
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function cmdRun(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			approve: { type: "boolean", default: false },
			deliver: { type: "boolean", default: false },
			tasks: { type: "string", multiple: true },
		},
		strict: false,
	});
	let kit: Awaited<ReturnType<typeof openProjectHarness>> | undefined;
	try {
		const root = resolve(procCwd());
		kit = await openProjectHarness(root, "run");
		// SIGINT = user abort: clean close (durable state stays; waves resume on the next run).
		const onInterrupt = () => {
			void kit!.loop
				.close()
				.catch(() => {})
				.finally(() => {
					kit!.lock.release();
					we.error(`\n${c.yellow}interrupted${RESET} — durable state closed cleanly; rerun to resume`);
					process.exit(130);
				});
		};
		process.on("SIGINT", onInterrupt);
		const summary = await runWaves(
			kit,
			{
				approve: values["approve"] === true,
				deliverExplicit: values["deliver"] === true,
				tasksFilter: (values["tasks"] as unknown as string[] | undefined) ?? [],
			},
			printProgress,
		);
		process.off("SIGINT", onInterrupt);
		await kit.loop.close();
		kit.lock.release();
		if (summary.exit === "sleeping") {
			we.log(`\n${c.yellow}⏾ sleeping${RESET} until the provider reset — rerun ${c.cyan}${CLI_NAME} run${RESET} to resume`);
			process.exitCode = 42;
			return;
		}
		we.log(
			summary.complete
				? `\n${c.green}STATUS: COMPLETE${RESET} — task queue drained. Paper trail: router.md · .orch/wave-log.jsonl`
				: `\n${c.yellow}run stopped: ${summary.exit}${RESET} — rerun to resume`,
		);
	} catch (err) {
		kit?.lock.release();
		fail(err, "run");
	}
}

function printProgress(event: ProgressEvent): void {
	switch (event.kind) {
		case "wave-start":
			we.log(`${c.cyan}▶ ${event.message}${RESET}`);
			break;
		case "gate-result":
			we.log(event.passed ? `${c.green}✔ ${event.message}${RESET}` : `${c.red}✘ ${event.message}${RESET}`);
			break;
		case "verifier-verdict":
			we.log(event.verdict === "approve" ? `${c.green}✔ verifier: ${event.verdict}${RESET}` : `${c.yellow}✎ verifier: ${event.verdict} — ${event.message}${RESET}`);
			break;
		case "task-done":
			we.log(`${c.green}■ ${event.message}${RESET}`);
			break;
		case "sleeping":
			we.log(`${c.yellow}⏾ ${event.message}${RESET}`);
			break;
		case "budget-stop":
			we.log(`${c.yellow}$ ${event.message}${RESET}`);
			break;
		case "blocked":
			we.log(`${c.red}║ ${event.message}${RESET}`);
			break;
		case "complete":
			we.log(`${c.green}✦ ${event.message}${RESET}`);
			break;
		default:
			we.log(`· ${("message" in event && event.message) || event.kind}`);
	}
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function cmdStatus(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: { follow: { type: "boolean", default: false } },
	});
	const root = resolve(procCwd());
	const paths = projectPaths(root);
	const follow = values["follow"] === true;

	// When another process holds the lock, .orch/status.json is the window into
	// the live run (single-store-owner rule, §3.1).
	const payload = await readJson(paths.status);
	if (payload) {
		we.log(renderStatusPanel(payload as never));
		if (!follow) return;
		await followLoop(paths, (p) => we.log(renderStatusPanel(p as never)));
		return;
	}

	let kit: Awaited<ReturnType<typeof openProjectHarness>> | undefined;
	try {
		kit = await openProjectHarness(root, "status");
		const state = await readSessionState(kit.loop.harness);
		const usage = await kit.loop.sessionUsage();
		const view = {
			kit: state.runStatus.kitVersion || KIT_VERSION,
			piDurable: kit.loop.config.engine.piDurable,
			ts: Date.now(),
			root,
			lockedByPid: process.pid,
			phase: "idle" as const,
			budget: {
				spentUsd: usage.totalUsd,
				sessionCeilingUsd: kit.loop.config.budgets.sessionUsd,
				waveWarnUsd: kit.loop.config.budgets.waveUsdWarn,
			},
			tasks: state.router.tasks.map((t) => ({ id: t.id, status: t.status, waveCount: t.waveCount, title: t.title })),
			alert: state.runStatus.activeAlert,
			usageNote: usage.totalUsd,
		};
		we.log(renderStatusPanel(view as never));
		await flushStated(paths, view);
		await kit.loop.close();
		kit.lock.release();
	} catch (err) {
		kit?.lock.release();
		fail(err, "status");
	}
}

// ---------------------------------------------------------------------------
// inspect — the full visibility snapshot (storage under the lock, side-cars when busy)
// ---------------------------------------------------------------------------

const INSPECT_SECTION_NAMES = new Set<string>(INSPECT_SECTIONS);

async function cmdInspect(argv: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { json: { type: "boolean", default: false }, health: { type: "boolean", default: false } },
		strict: false,
	});
	const unknown = positionals.filter((s) => !INSPECT_SECTION_NAMES.has(s));
	for (const name of unknown) we.error(`${c.yellow}unknown section${RESET} ${name} — known: ${[...INSPECT_SECTIONS].join(", ")}`);
	const sections = positionals.filter((s) => INSPECT_SECTION_NAMES.has(s));
	const json = values["json"] === true;
	const healthOnly = values["health"] === true;
	const root = resolve(procCwd());
	const paths = projectPaths(root);

	// Storage mode when the lock is free; degraded side-car mode when a live run
	// owns it (never touching storage, per the single-store-owner rule).
	let kit: Awaited<ReturnType<typeof openProjectHarness>> | undefined;
	try {
		kit = await openProjectHarness(root, "inspect");
		const read = await readout(paths, { loop: kit });
		await showReadout(read, { json, healthOnly, sections });
		await kit.loop.close();
		kit.lock.release();
	} catch (err) {
		if (err instanceof LockBusyError) {
			const read = await readout(paths);
			await showReadout(read, { json, healthOnly, sections });
			return;
		}
		kit?.lock.release();
		fail(err, "inspect");
	}
}

async function showReadout(read: Awaited<ReturnType<typeof readout>>, opts: { json: boolean; healthOnly: boolean; sections: string[] }): Promise<void> {
	if (opts.json) {
		we.log(JSON.stringify(read, null, 2));
		return;
	}
	we.log(renderInspectPanel(read, { sections: opts.sections, healthOnly: opts.healthOnly }));
}

async function followLoop(paths: { status: string }, render: (payload: unknown) => void): Promise<void> {
	for (;;) {
		await new Promise((r) => setTimeout(r, 700));
		const payload = await readJson(paths.status);
		if (payload) render(payload);
	}
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

async function cmdVerify(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: { task: { type: "string" } },
		strict: false,
	});
	const taskId = values["task"] as string | undefined;
	if (!taskId) {
		we.error(`verify needs --task <id> — see router.md for task ids`);
		process.exitCode = 1;
		return;
	}
	let kit: Awaited<ReturnType<typeof openProjectHarness>> | undefined;
	try {
		const root = resolve(procCwd());
		kit = await openProjectHarness(root, "verify");
		const state = await readSessionState(kit.loop.harness);
		const task = state.router.tasks.find((t) => t.id === taskId);
		if (!task) {
			we.error(`task "${taskId}" is not in the router doc — see router.md`);
			process.exitCode = 1;
			return;
		}
		if (!task.baselineTreeSha) {
			we.error(`task "${taskId}" has no baseline tree (it never ran a wave); the verifier compares against the tree captured before its first wave`);
			process.exitCode = 1;
			return;
		}
		const result = await runVerify(kit, {
			id: task.id,
			title: task.title,
			spec: task.spec,
			acceptance: task.acceptance,
			baselineTreeSha: task.baselineTreeSha,
			targetPaths: task.targetPaths,
		}, "(one-off verify: no gate summary available)");
		we.log(JSON.stringify(result, null, 2));
		if (result.verdict !== "approve") process.exitCode = 1;
		await kit.loop.close();
		kit.lock.release();
	} catch (err) {
		kit?.lock.release();
		fail(err, "verify");
	}
}

// ---------------------------------------------------------------------------
// export + handoff
// ---------------------------------------------------------------------------

async function cmdExport(): Promise<void> {
	let kit: Awaited<ReturnType<typeof openProjectHarness>> | undefined;
	try {
		const root = resolve(procCwd());
		kit = await openProjectHarness(root, "export");
		const read = await readout(kit.loop.paths, { loop: kit });
		const out = await writeExports(kit.loop.paths, { readout: read });
		we.log(`exported: ${out.jsonFile}\n          ${out.htmlFile}`);
		await kit.loop.close();
		kit.lock.release();
	} catch (err) {
		kit?.lock.release();
		fail(err, "export");
	}
}

async function cmdHandoff(argv: string[]): Promise<void> {
	const note = argv.filter((a) => !a.startsWith("-")).join(" ");
	if (!note) {
		we.error(`handoff needs a note: ${CLI_NAME} handoff "…context for the next wave"`);
		process.exitCode = 1;
		return;
	}
	try {
		const paths = projectPaths(resolve(procCwd()));
		// Safe while another process runs: atomic local side-car (§3.1).
		const existing = await readJson<{ notes: string[] }>(paths.pendingHandoff) ?? { notes: [] };
		existing.notes.push(note);
		await atomicWriteJson(paths.pendingHandoff, { notes: existing.notes, ts: Date.now() });
		we.log(`handoff note queued for the next wave: ${note}`);
	} catch (err) {
		fail(err, "handoff");
	}
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

function fail(err: unknown, command: string): void {
	const message = (err as Error).message ?? String(err);
	const busy = (err as { name?: string }).name === "LockBusyError" || /owns .*lock/.test(message);
	we.error(`${c.red}${command} failed${RESET}: ${message}`);
	if (err instanceof ConfigError) we.error("hint: run `init` in the project root first");
	if (err instanceof PlanParseError) we.error("hint: check the PRD path/content, or rerun plan to let the planner retry");
	if (busy) we.error("hint: wait for the running process to exit (or for a stale .orch/lock to clear)");
	process.exitCode = 1;
}

function HELP(): string {
	return `usage:
  ${CLI_NAME} init . [--with-demo]        # scaffold a project (never clobbers your edits)
  ${CLI_NAME} plan [--prd path]           # PRD → RouterDoc + router.md; stops for human approval
  ${CLI_NAME} run [--approve] [--tasks id] [--deliver]
                                          # the cycle; exit 0 done · 42 sleeping · 1 error/busy
  ${CLI_NAME} status [--follow]           # task graph + budgets from side-cars or storage
  ${CLI_NAME} inspect [--json] [--health] [section…]
                                          # full visibility: tasks, usage, conversations,
                                          # timeline, artifacts, health (degrades to side-cars)
  ${CLI_NAME} verify --task id            # one-off read-only verification (works after manual edits)
  ${CLI_NAME} export                      # HTML/JSON report into .orch/artifacts/
  ${CLI_NAME} handoff "note"              # queue a note the next wave ingests

kit ${RUN_VERSION_HEADER()} · run inside the target project (its .orch/config.toml)`;
}

const RUN_VERSION_HEADER = (): string => `${CLI_NAME} ${pjson.version} · kit ${KIT_VERSION}`;

main();

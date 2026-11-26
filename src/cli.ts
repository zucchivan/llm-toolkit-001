#!/usr/bin/env node
/**
 * llm-toolkit-001 — durable agent implementation loop CLI.
 * Commands: init · gates · plan · run · status · verify · resolve · export · handoff.
 * Arg parsing: node:util parseArgs (strict) — no heavy framework.
 * Process exit codes (run): 0 fulfilled (whole plan or granted subset) ·
 * 2 policy stop (quarantine/budget/recovery-required) · 42 sleeping until provider reset ·
 * 1 error (incl. lock busy / invalid grant) · 130 SIGINT.
 */
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { cwd as procCwd } from "node:process";
import { createRequire } from "node:module";
const pjson = createRequire(import.meta.url)("../package.json") as { name?: string; version: string };
import { initProject } from "./init.ts";
import { KIT_VERSION, ConfigError, loadConfig } from "./config.ts";
import { openProjectHarness, projectPaths, flushStated, LockBusyError, StoreAbsentError } from "./engine/harness.ts";
import { readout, INSPECT_SECTIONS } from "./engine/inspector.ts";
import { readSessionState } from "./engine/state.ts";
import { ReceiptsDoc } from "./engine/receipts.ts";
import { BACKGROUND_CONTEXT } from "./engine/kit.ts";
import { createTaskControls } from "./engine/controls.ts";
import { createTaskReadContext, discard as discardWorkspace, materializeRead } from "./engine/workspace.ts";
import type { ReadWorkspace } from "./engine/workspace.ts";
import { recipeBundleFromTree } from "./engine/gates.ts";
import { resolveTree } from "./util/git-objects.ts";
import { loadPrd, runPlan, PlanParseError } from "./engine/planner.ts";
import { reviewBindingRefusal } from "./engine/plans.ts";
import { runWaves } from "./engine/waves.ts";
import type { ProgressEvent } from "./engine/driver-events.ts";
import { renderInspectPanel } from "./views/inspect.ts";
import { renderStatusPanel } from "./views/status.ts";
import { writeExports } from "./views/export.ts";
import { runVerify } from "./engine/verifier.ts";
import { BudgetAdmissionError } from "./engine/model-admission.ts";
import { runResolution, loadResolutionEvidence, validateResolutionReason, ResolutionRefusal } from "./engine/resolution.ts";
import { readJson } from "./util/fsx.ts";
import { publishHandoffNote, HandoffNoteTooLongError } from "./engine/handoffs.ts";
import { runGatesCli } from "./adoption/cli.ts";
import {
	TrustedInstallationError,
	loadTrustedInstallation,
	requireLaunchPrefix,
	type TrustedLaunchPrefix,
} from "./sandbox/trusted-exec.ts";

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
		case "gates":
			void cmdGates(rest);
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
		case "resolve":
			void cmdResolve(rest);
			break;
		case "export":
			void cmdExport();
			break;
		case "handoff":
			void cmdHandoff(rest);
			break;
		case "ui":
			void cmdUi(rest);
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
		if (report.appended.length) we.log(`  gitignore: ${report.appended.length} entries appended (${report.appended.join(", ")})`);
		for (const warning of report.warnings) we.log(`  ${c.yellow}warning:${RESET} ${warning}`);
		we.log(`\nnext (existing projects): ${c.cyan}${CLI_NAME} gates list${RESET}, then optionally ${c.cyan}${CLI_NAME} gates refresh${RESET}`);
		we.log(`then: write ${c.cyan}docs/prd.md${RESET}, then ${c.cyan}${CLI_NAME} plan${RESET}`);
	} catch (err) {
		fail(err, "init");
	}
}

// ---------------------------------------------------------------------------
// gates — read-only discovery, approved adoption, separately consented probe
// ---------------------------------------------------------------------------

async function cmdGates(argv: string[]): Promise<void> {
	process.exitCode = await runGatesCli(resolve(procCwd()), argv);
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
		// The durable review identity (M0-P04): fresh per plan, echoed here and
		// mirrored in router.md. A replan names the replaced plan.
		we.log(`  ${c.cyan}plan revision:${RESET} ${outcome.planRevision}`);
		if (outcome.replacedRevision) we.log(`  replaced: ${outcome.replacedRevision} (archived; prior approval invalidated)`);
		for (const t of outcome.tasks) we.log(`  [${t.id}] ${t.title}`);
		we.log(`\nreview router.md (a generated mirror, not editable plan input). To change the plan, revise the PRD and rerun ${c.cyan}${CLI_NAME} plan${RESET}, then: ${c.cyan}${CLI_NAME} run --approve --revision ${outcome.planRevision}${RESET} (--tasks <id> once per task for a subset)`);
		await kit.loop.close();
		kit.lock.release();
	} catch (err) {
		kit?.lock.release();
		if (err instanceof BudgetAdmissionError) {
			// M0-P16: planning is a paid submission; its budget pause is exit 2.
			we.error(`${c.yellow}plan stopped: budget${RESET} — ${err.reason}`);
			process.exitCode = 2;
			return;
		}
		fail(err, "plan");
	}
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function cmdRun(argv: string[]): Promise<void> {
	// Strict parse (M0-P05): no swallowed positionals, no unknown flags — an
	// unrecognized argument is a refusal (exit 1), never silent scope.
	let values: {
		approve?: boolean;
		deliver?: boolean;
		revision?: string;
		tasks?: string[];
	};
	try {
		({ values } = parseArgs({
			args: argv,
			options: {
				approve: { type: "boolean", default: false },
				deliver: { type: "boolean", default: false },
				revision: { type: "string" },
				tasks: { type: "string", multiple: true },
			},
			strict: true,
			allowPositionals: false,
		}));
	} catch (err) {
		we.error(`${c.red}run refused${RESET}: ${(err as Error).message}\n${RUN_USAGE()}`);
		process.exitCode = 1;
		return;
	}
	if (values["approve"] === true && !values["revision"]) {
		we.error(`${c.red}run refused${RESET}: --approve needs --revision <uuid> — the plan revision \`plan\` printed and router.md shows; there is no hidden default revision\n${RUN_USAGE()}`);
		process.exitCode = 1;
		return;
	}
	let kit: Awaited<ReturnType<typeof openProjectHarness>> | undefined;
	try {
		const root = resolve(procCwd());
		kit = await openProjectHarness(root, "run");
		// Grant admission (M0-P05) happens inside the driver, BEFORE any wave or
		// model dispatch: legacy plans, stamps that do not name the current plan
		// revision, revision/subset/dependency/mirror violations refuse there.
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
				approve: values["approve"] === true ? { planRevision: values["revision"]! } : undefined,
				deliverExplicit: values["deliver"] === true,
				tasksFilter: values["tasks"] ?? [],
			},
			printProgress,
		);
		process.off("SIGINT", onInterrupt);
		await kit.loop.close();
		kit.lock.release();
		const paperTrail = " Paper trail: router.md · .orch/wave-log.jsonl";
		const revision = summary.grant.planRevision;
		const resultLocation = kit.loop.config.delivery.mode === "none"
			? ` Result checkout (operator worktree unchanged): git worktree add --detach /path/to/result refs/kit/${revision}/accepted.`
			: kit.loop.config.delivery.mode === "commit"
				? ` Local result branch (not checked out): refs/heads/kit/${revision}/result.`
				: " PR heads and stack bases are recorded in publication receipts; PRs are not merged.";
		if (summary.exit === "sleeping") {
			we.log(`\n${c.yellow}⏾ sleeping${RESET} until the provider reset — rerun ${c.cyan}${CLI_NAME} run${RESET} to resume`);
			process.exitCode = 42;
			return;
		}
		if (summary.exit === "plan-complete") {
			we.log(`\n${c.green}STATUS: COMPLETE${RESET} — every task in the plan is done; whole plan fulfilled.${resultLocation}${paperTrail}`);
			process.exitCode = 0;
			return;
		}
		if (summary.exit === "selection-complete") {
			we.log(
				`\n${c.green}selection complete${RESET} — the granted task(s) are fulfilled (${summary.grant.selected.join(", ")}); ` +
					`${summary.remainingPlanIds.length} plan task(s) remain outside the grant: ${summary.remainingPlanIds.join(", ") || "(none)"}. ` +
					`Approve a wider set to continue (${c.cyan}${CLI_NAME} run --approve --revision <uuid>${RESET}).${resultLocation}${paperTrail}`,
			);
			process.exitCode = 0;
			return;
		}
		if (summary.exit === "blocked") {
			// Policy stop (exit 2), never a plain success: the ids carry the truth.
			we.log(
				`\n${c.yellow}run stopped short${RESET} — quarantined: ${summary.quarantined.join(", ") || "(none)"}` +
					(summary.blockedIds.length ? `; stopped on: ${summary.blockedIds.join(", ")}` : "") +
					`.${paperTrail}`,
			);
			process.exitCode = 2;
			return;
		}
		if (summary.exit === "recovery-required") {
			we.log(`\n${c.yellow}recovery required${RESET} — unresolved candidate effect for: ${summary.blockedIds.join(", ") || "(unknown task)"}; inspect receipts before retrying.${paperTrail}`);
			process.exitCode = 2;
			return;
		}
		if (summary.exit === "budget") {
			// M0-P16: a budget pause is a policy stop (exit 2), never a reject —
			// the pending stage/candidate survives and editing the ceiling resumes.
			we.log(
				`\n${c.yellow}run stopped: budget${RESET} — ${summary.alert ?? "session spend reached the configured ceiling"}. ` +
					`Recorded spend is an estimate, not a provider bill cap (one admitted in-flight request can overrun). ` +
					`Raise ${c.cyan}budgets.sessionUsd${RESET} in .orch/config.toml and rerun ${c.cyan}${CLI_NAME} run${RESET} to resume the same pending stage.${paperTrail}`,
			);
			process.exitCode = 2;
			return;
		}
		we.log(`\n${c.yellow}run stopped: ${summary.exit}${RESET} — rerun to resume.${paperTrail}`);
		process.exitCode = 2;
	} catch (err) {
		kit?.lock.release();
		fail(err, "run");
	}
}

function RUN_USAGE(): string {
	return `  ${CLI_NAME} run --approve --revision <uuid> [--tasks id]… [--deliver]   # new grant
  ${CLI_NAME} run [--tasks id]…                                          # resume the stored grant`;
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
		case "recovery-required":
			we.log(`${c.yellow}⚠ ${event.message}${RESET}`);
			break;
		case "quarantine-stop":
			we.log(`${c.yellow}◇ ${event.message}${RESET}`);
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
		kit = await openProjectHarness(root, "status", { readView: true });
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
		if (err instanceof StoreAbsentError) {
			// A never-run project has no storage to read — and none is created
			// just to inspect. Render the empty/absent truth straight from config
			// (M1-P01 step (g): awaited through the canonical-root read boundary).
			const config = await loadConfig(root);
			we.log(
				renderStatusPanel({
					kit: KIT_VERSION,
					piDurable: config.engine.piDurable,
					ts: Date.now(),
					root,
					lockedByPid: process.pid,
					phase: "empty",
					budget: { spentUsd: 0, sessionCeilingUsd: config.budgets.sessionUsd, waveWarnUsd: config.budgets.waveUsdWarn },
					tasks: [],
				} as never),
			);
			return;
		}
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
	// owns it (never touching storage, per the single-store-owner rule). readView:
	// visibility never sends model requests, so unknown role providers stay inert.
	let kit: Awaited<ReturnType<typeof openProjectHarness>> | undefined;
	try {
		kit = await openProjectHarness(root, "inspect", { readView: true });
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
		if (err instanceof StoreAbsentError) {
			// Never-run project: refuse to create storage; show empty/absent
			// evidence from the side-cars instead (nothing has run — nothing to show).
			const read = await readout(paths, { sidecarReason: "no durable storage — this project has never run (empty evidence)" });
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
	let frozenView: ReadWorkspace | undefined;
	try {
		const root = resolve(procCwd());
		kit = await openProjectHarness(root, "verify");
		const state = await readSessionState(kit.loop.harness);
		const task = state.router.tasks.find((t) => t.id === taskId);
		if (!task) throw new Error(`task "${taskId}" is not in the router doc — see router.md`);
		const identity = state.router.identity;
		const revision = identity?.planRevision;
		if (!identity || !revision) throw new Error(`task "${taskId}" has no reviewed plan revision; replan before verification`);
		// M1-P01 step (d): a one-off verify is a paid submission under the CURRENT
		// verifier policy. The reviewed identity must still bind HEAD, the actual
		// PRD and every reviewed control byte/effective setting BEFORE the
		// submission is admitted or any model call starts; otherwise a changed
		// eval byte or verification policy would be executed under an old review.
		const bindingRefusal = await reviewBindingRefusal(root, identity, kit.loop.config);
		if (bindingRefusal) throw new Error(`${bindingRefusal} — verify would dispatch a paid submission`);
		const receipts = await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		const checkpoint = receipts?.events.filter((event) => event.kind === "checkpoint"
			&& event.value.planRevision === revision && event.value.taskId === taskId
			&& event.value.candidate !== undefined).at(-1);
		if (!checkpoint || checkpoint.kind !== "checkpoint" || !checkpoint.value.candidate) {
			throw new Error(`task "${taskId}" has no retained frozen candidate checkpoint for revision ${revision}; verify does not read the operator checkout`);
		}
		const startTree = await resolveTree(root, checkpoint.value.startTree);
		const candidateTree = await resolveTree(root, checkpoint.value.candidate);
		const controls = createTaskControls({ root, targetPaths: task.targetPaths, prdPath: identity.prdPath });
		frozenView = await materializeRead({ root, oid: candidateTree }, controls);
		const executionContext = await createTaskReadContext({
			controlPaths: kit.loop.paths,
			taskId,
			startOid: startTree,
			candidateOid: candidateTree,
			frozenReadView: frozenView,
			recipeBundle: await recipeBundleFromTree(root, startTree),
		});
		const result = await runVerify(kit, {
			id: task.id,
			title: task.title,
			spec: task.spec,
			acceptance: task.acceptance,
			baselineTreeSha: startTree,
			targetPaths: task.targetPaths,
		}, "(one-off verify: no gate summary available)", { executionContext });
		we.log(JSON.stringify(result, null, 2));
		if (result.verdict !== "approve") process.exitCode = 1;
	} catch (err) {
		if (err instanceof BudgetAdmissionError) {
			// M0-P16: a one-off verify is a paid submission; a budget pause is a
			// policy stop (exit 2), not an error or a verdict.
			we.error(`${c.yellow}verify stopped: budget${RESET} — ${err.reason}`);
			process.exitCode = 2;
			return;
		}
		fail(err, "verify");
	} finally {
		if (frozenView) await discardWorkspace(frozenView).catch(() => {});
		if (kit) {
			await kit.loop.close().catch(() => {});
			kit.lock.release();
		}
	}
}

// ---------------------------------------------------------------------------
// resolve — the binding HUMAN path for a blocked task (M0-P18, §3 Human path)
// ---------------------------------------------------------------------------

/**
 * `resolve` is the only command that turns a quarantined task back into work.
 * It is a HUMAN decision, so it takes an attributed local reason, a matching
 * revision and the current grant, and it never dispatches a model:
 *
 *   resolve --revision R --task T --retry --reason TEXT
 *     one fresh retry cycle from the current accepted head (clears the task's
 *     sleep counter and duplicate-failure hash, keeps wave history); no work
 *     runs until an authorized `run`.
 *
 *   resolve --revision R --task T --accept-tree OID --evidence FILE --reason TEXT
 *     only for an inconclusive `needs_human` quarantine with the SAME retained
 *     candidate, unchanged lineage/controls and all deterministic gates rerun
 *     passing on it. Evidence is `{"criteria":[…]}`, ≤64 KiB. Records human
 *     authority and drives LOCAL integration; publication stays with `run`.
 *
 * Both forms are idempotent (deterministic operation id). Lock and workspace
 * close/release always happen in `finally`, including every early return.
 */
async function cmdResolve(argv: string[]): Promise<void> {
	let values: { revision?: string; task?: string; retry?: boolean; "accept-tree"?: string; evidence?: string; reason?: string };
	try {
		({ values } = parseArgs({
			args: argv,
			options: {
				revision: { type: "string" },
				task: { type: "string" },
				retry: { type: "boolean", default: false },
				"accept-tree": { type: "string" },
				evidence: { type: "string" },
				reason: { type: "string" },
			},
			strict: true,
			allowPositionals: false,
		}));
	} catch (err) {
		we.error(`${c.red}resolve refused${RESET}: ${(err as Error).message}\n${RESOLVE_USAGE()}`);
		process.exitCode = 1;
		return;
	}
	const retry = values.retry === true;
	const acceptTree = values["accept-tree"];
	// Strict EXCLUSIVE flags: exactly one action, and evidence belongs only to accept-tree.
	if (retry === (acceptTree !== undefined)) {
		we.error(`${c.red}resolve refused${RESET}: pass exactly one of --retry or --accept-tree <oid>\n${RESOLVE_USAGE()}`);
		process.exitCode = 1;
		return;
	}
	if (retry && values.evidence !== undefined) {
		we.error(`${c.red}resolve refused${RESET}: --evidence belongs to --accept-tree; a retry discards, it never accepts a tree`);
		process.exitCode = 1;
		return;
	}
	if (!retry && values.evidence === undefined) {
		we.error(`${c.red}resolve refused${RESET}: --accept-tree needs --evidence FILE ({"criteria":[…]} proving every reviewed criterion) and --reason TEXT\n${RESOLVE_USAGE()}`);
		process.exitCode = 1;
		return;
	}
	if (values.revision === undefined || values.task === undefined || values.reason === undefined) {
		we.error(`${c.red}resolve refused${RESET}: --revision, --task and --reason are all required\n${RESOLVE_USAGE()}`);
		process.exitCode = 1;
		return;
	}

	let kit: Awaited<ReturnType<typeof openProjectHarness>> | undefined;
	try {
		const reason = validateResolutionReason(values.reason);
		const evidence = !retry && values.evidence !== undefined ? await loadResolutionEvidence(values.evidence) : undefined;
		kit = await openProjectHarness(resolve(procCwd()), "resolve");
		const outcome = await runResolution(kit, {
			planRevision: values.revision,
			taskId: values.task,
			action: retry ? "retry" : "accept-tree",
			reason,
			...(acceptTree !== undefined ? { tree: acceptTree } : {}),
			...(evidence !== undefined ? { evidence } : {}),
		});
		if (outcome.idempotent) {
			we.log(`${c.cyan}already resolved${RESET} — operation ${outcome.operationId.slice(0, 12)}… is recorded for ${outcome.taskId} wave ${outcome.wave}; nothing changed.`);
		} else if (outcome.action === "retry") {
			we.log(`${c.green}RESOLVED (human retry)${RESET} — ${outcome.taskId} wave ${outcome.wave} requeued from the accepted head with fresh attempt quota.`);
			we.log(`  operation: ${outcome.operationId}`);
		} else {
			we.log(`${c.green}RESOLVED (human accept-tree)${RESET} — ${outcome.taskId} wave ${outcome.wave} accepted at ${outcome.commit} (human authority, not model approval).`);
			we.log(`  operation: ${outcome.operationId}`);
			if (outcome.acceptanceId) we.log(`  acceptance receipt: ${outcome.acceptanceId}`);
			we.log(`  integrated locally; no publication happened (remote delivery needs an authorized run).`);
		}
		for (const step of outcome.nextSteps) we.log(`  next: ${c.cyan}${step}${RESET}`);
	} catch (err) {
		if (err instanceof ResolutionRefusal) {
			// A blocked human path prints the remedy; it never guesses a next state.
			we.error(`${c.red}resolve refused${RESET}: ${err.message}`);
			process.exitCode = 1;
			return;
		}
		fail(err, "resolve");
	} finally {
		// ALL early returns above and refusals below pass through here exactly once.
		if (kit) {
			await kit.loop.close().catch(() => {});
			kit.lock.release();
		}
	}
}

function RESOLVE_USAGE(): string {
	return `  ${CLI_NAME} resolve --revision <uuid> --task <id> --retry --reason TEXT
  ${CLI_NAME} resolve --revision <uuid> --task <id> --accept-tree <oid> --evidence FILE --reason TEXT`;
}

// ---------------------------------------------------------------------------
// export + handoff
// ---------------------------------------------------------------------------

async function cmdExport(): Promise<void> {
	let kit: Awaited<ReturnType<typeof openProjectHarness>> | undefined;
	const root = resolve(procCwd());
	try {
		kit = await openProjectHarness(root, "export", { readView: true });
		const read = await readout(kit.loop.paths, { loop: kit });
		const out = await writeExports(kit.loop.paths, { readout: read });
		we.log(`exported: ${out.jsonFile}\n          ${out.htmlFile}`);
		await kit.loop.close();
		kit.lock.release();
	} catch (err) {
		if (err instanceof StoreAbsentError) {
			// Never-run project: export the empty/absent side-car evidence instead
			// of creating a database to read.
			const paths = projectPaths(root);
			const read = await readout(paths, { sidecarReason: "no durable storage — this project has never run (empty evidence)" });
			const out = await writeExports(paths, { readout: read });
			we.log(`exported: ${out.jsonFile}\n          ${out.htmlFile}`);
			return;
		}
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
		// Safe while another process runs (even the driver): ONE atomically
		// published note file per invocation — no shared queue, no read-modify-
		// write race (M0-P17). The driver claims the oldest notes at each wave
		// boundary; notes arriving after a wave's claim wait for the next wave.
		await publishHandoffNote(paths, note);
		we.log(`handoff note queued for the next wave: ${note}`);
	} catch (err) {
		if (err instanceof HandoffNoteTooLongError) {
			we.error(err.message);
			process.exitCode = 1;
			return;
		}
		fail(err, "handoff");
	}
}

// ---------------------------------------------------------------------------
// ui — the web UI sub-product: a process boundary, never an import (ui/PRD.md
// Appendix A.4). The UI package owns the real entry point so the sub-product
// can move or be published independently without a cycle.
// ---------------------------------------------------------------------------

async function cmdUi(argv: string[]): Promise<void> {
	// M1-P01 step (f): ONE host-owned launch identity. The descriptor is built
	// here (operator host profile + fixed defaults; never the target, cwd, PATH
	// or a KIT_* value) and the UI entry is started as one fixed literal argv.
	let launch: TrustedLaunchPrefix;
	try {
		const installation = await loadTrustedInstallation();
		launch = await requireLaunchPrefix(installation, "ui", { targetRoot: resolve(procCwd()) });
	} catch (err) {
		const error = err as TrustedInstallationError;
		if (error.code === "not-configured") {
			we.error(`the web UI lives in its own package (${join("ui", "package.json")}) — install it once in the kit repo:`);
			we.error(`  ${c.cyan}npm --prefix ui install${RESET}`);
			we.error(`then rerun: ${CLI_NAME} ui`);
		} else {
			we.error(`the trusted web UI entry is refused: ${error.message}`);
			we.error(`hint: build/install the kit (npm install && npm --prefix ui install) or name installation.ui in the operator host policy`);
		}
		if (process.env["KIT_DEBUG"]) we.error(`[kit-debug] ui launch refusal: ${error.code ?? "?"} ${error.message}`);
		process.exitCode = 1;
		return;
	}
	const { spawn } = await import("node:child_process");
	const child = spawn(launch.argv[0]!, launch.argv.slice(1).concat(argv), { stdio: "inherit", env: process.env, cwd: procCwd() });
	// Kill the signal contract: `kill <this pid>` (or a service manager) must take
	// the spawned UI server with it, not orphan it holding the port. Ctrl-C still
	// reaches both processes naturally (same process group).
	const forward = (signal: NodeJS.Signals): void => {
		if (process.env["KIT_DEBUG"]) we.error(`[kit-debug] ${CLI_NAME} ui got ${signal} → forwarding to child ${child.pid}`);
		if (child.pid !== undefined) child.kill(signal);
	};
	process.on("SIGINT", forward);
	process.on("SIGTERM", forward);
	child.on("error", (err) => {
		we.error(`failed to start ${launch.entry}: ${(err as Error).message}`);
		process.exitCode = 1;
	});
	const code: number | null = await new Promise((done) => {
		child.on("close", (exitCode) => done(exitCode));
		child.on("error", () => done(null));
	});
	if (code !== null && code !== 0) process.exitCode = code;
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
  ${CLI_NAME} gates list [--json]          # deterministic, offline inventory + gap evidence
  ${CLI_NAME} gates evaluate [--json]      # opt-in Jev shadow assessment; no execution/adoption
  ${CLI_NAME} gates refresh [--accept recommended | --skip-gates]
                                          # approve generated gates; no execution
  ${CLI_NAME} gates probe [--yes]           # separately consented baseline probe
                                          # recipes: one command form each — legacy
                                          # "cmd" (whitespace-split, no shell syntax)
                                          # or literal "argv" tokens; ALL "match"
                                          # regexes must match stdout; probe shares
                                          # the [gates] timeoutSec deadline with waves
  ${CLI_NAME} plan [--prd path]           # PRD → RouterDoc + router.md; stops for human approval
  ${CLI_NAME} run --approve --revision <uuid> [--tasks id]… [--deliver]
                                          # NEW grant: approve exactly that plan revision
                                          # (plan prints it; repeat --tasks per subset id,
                                          # omit it for every task — the full list is explicit)
  ${CLI_NAME} run [--tasks id]…            # resume the stored grant bare (no re-approval);
                                          # an explicit set must equal the grant
                                          # exit 0 fulfilled · 2 stopped short · 42 sleeping · 1 error/busy · 130 SIGINT
  ${CLI_NAME} status [--follow]           # task graph + budgets from side-cars or storage
  ${CLI_NAME} inspect [--json] [--health] [section…]
                                          # full visibility: tasks, usage, conversations,
                                          # timeline, artifacts, health (degrades to side-cars)
  ${CLI_NAME} verify --task id            # one-off read-only verification (never changes task status)
  ${CLI_NAME} resolve --revision <uuid> --task <id> --retry --reason TEXT
                                          # HUMAN retry: requeue a blocked task from the accepted
                                          # head, fresh attempt quota + sleep counter, no dispatch
  ${CLI_NAME} resolve --revision <uuid> --task <id> --accept-tree <oid> --evidence FILE --reason TEXT
                                          # HUMAN acceptance of a needs_human candidate: same tree,
                                          # unchanged controls, gates rerun, evidence {"criteria":[…]};
                                          # integrates locally, never publishes
  ${CLI_NAME} export                      # HTML/JSON report into .orch/artifacts/
  ${CLI_NAME} handoff "note"              # queue a note the next wave ingests
  ${CLI_NAME} ui [--port n] [--no-open]    # the web UI (sub-product, ui/PRD.md); spawns llm-toolkit-ui

kit ${RUN_VERSION_HEADER()} · run inside the target project (its .orch/config.toml)`;
}

// Kit identity IS the package version (config.ts reads package.json): one
// source, so the CLI header, init markers, and readouts always agree.
const RUN_VERSION_HEADER = (): string => `${CLI_NAME} ${KIT_VERSION}`;

main();

/** Thin CLI adapter for the adoption modules; all policy lives behind their seams. */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { loadConfig, DEFAULT_CONFIG } from "../config.ts";
import { analyzeGaps } from "./gaps.ts";
import { discoverProject } from "./discovery.ts";
import { refreshGates } from "./workflow.ts";
import { probeGates } from "./probe.ts";
import type { JudgmentClient } from "../judgment/types.ts";
import type { GateAssessment } from "./types.ts";

export interface GatesCliIo {
	interactive: boolean;
	log(message: string): void;
	error(message: string): void;
	ask?(question: string): Promise<string>;
}

export interface GatesCliDependencies {
	judgmentClient?: JudgmentClient;
	env?: NodeJS.ProcessEnv;
	persistAssessment?: (root: string, assessment: GateAssessment) => Promise<void>;
}

export async function runGatesCommand(root: string, argv: string[], io: GatesCliIo, dependencies: GatesCliDependencies = {}): Promise<number> {
	const subcommand = argv[0] ?? "list";
	const rest = argv.slice(1);
	try {
		if (subcommand === "list") {
			const { values } = parseArgs({ args: rest, options: { json: { type: "boolean", default: false } }, strict: true });
			const report = await analyzeGaps(root, await discoverProject(root));
			if (values.json) io.log(JSON.stringify(report, null, 2));
			else {
				const { formatGapReport, formatEvidence } = await import("./workflow.ts");
				io.log(formatGapReport(report));
				for (const finding of report.findings.filter((item) => item.status !== "covered" && item.status !== "not-applicable")) io.log(`\n${formatEvidence(finding)}`);
			}
			return 0;
		}
		if (subcommand === "evaluate") {
			const { values } = parseArgs({ args: rest, options: { json: { type: "boolean", default: false } }, strict: true });
			const { evaluateGates, formatGateAssessment, persistGateAssessment } = await import("./evaluate.ts");
			const result = await evaluateGates(root, {
				enabled: true,
				client: dependencies.judgmentClient,
				apiKey: (dependencies.env ?? process.env)["TYPESAFE_API_KEY"],
			});
			if (result.assessment.status === "assessed") {
				await (dependencies.persistAssessment ?? persistGateAssessment)(root, result.assessment);
			}
			if (values.json) io.log(JSON.stringify(result, null, 2));
			else {
				const { formatGapReport } = await import("./workflow.ts");
				io.log(formatGapReport(result.report));
				io.log(`\n${formatGateAssessment(result.assessment)}`);
			}
			return 0;
		}
		if (subcommand === "refresh") {
			const { values } = parseArgs({
				args: rest,
				options: { accept: { type: "string" }, "skip-gates": { type: "boolean", default: false } }, strict: true,
			});
			if (values.accept !== undefined && values.accept !== "recommended") throw new Error("--accept supports only the explicit value: recommended");
			if (values.accept && values["skip-gates"]) throw new Error("choose either --accept recommended or --skip-gates, not both");
			const result = await refreshGates(root, {
				interactive: io.interactive, prompt: io.ask ? { ask: io.ask } : undefined,
				output: { log: io.log }, acceptRecommended: values.accept === "recommended", skipGates: values["skip-gates"] === true,
			});
			void result;
			return 0;
		}
		if (subcommand === "probe") {
			const { values } = parseArgs({ args: rest, options: { yes: { type: "boolean", default: false } }, strict: true });
			const result = await probeGates(root, {
				interactive: io.interactive, prompt: io.ask ? { ask: io.ask } : undefined,
				confirmed: values.yes === true, output: { log: io.log },
				// M0-P07: the probe shares the wave gates' configured deadline.
				timeoutMs: configuredProbeTimeoutMs(root),
			});
			return result.errors?.length || (result.consented && !result.allPassed) ? 1 : 0;
		}
		io.error(gatesHelp());
		return 1;
	} catch (err) {
		io.error(`gates ${subcommand} failed: ${(err as Error).message}`);
		return 1;
	}
}

/** Same configured timeout as wave gates: `[gates] timeoutSec` from the project
 * config; projects without a config (probe on a bare checkout) use the default. */
function configuredProbeTimeoutMs(root: string): number {
	try {
		return loadConfig(root).gates.timeoutSec * 1000;
	} catch {
		return DEFAULT_CONFIG.gates.timeoutSec * 1000;
	}
}

/** Real TTY adapter. Tests use runGatesCommand with a scripted io.ask instead. */
export async function runGatesCli(root: string, argv: string[]): Promise<number> {
	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	if (!interactive) return runGatesCommand(root, argv, { interactive, log: console.log, error: console.error });
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await runGatesCommand(root, argv, {
			interactive, log: console.log, error: console.error,
			ask: async (question) => await rl.question(question),
		});
	} finally {
		rl.close();
	}
}

export function gatesHelp(): string {
	return `usage:
  gates list [--json]                    # deterministic, offline inventory + gap report
  gates evaluate [--json]                # opt-in Jev shadow assessment; no execution/adoption
  gates refresh [--accept recommended]   # interactive choices; explicit non-interactive adoption
  gates refresh --skip-gates             # explicitly defer open findings; generate no recipes
  gates probe [--yes]                    # separately consented baseline execution`;
}

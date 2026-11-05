/**
 * Faux replay overlay (tutorial/smoke mode): KIT_FAUX=1 registers a faux
 * provider so the CLI quickstart runs without provider credentials.
 *
 *   KIT_FAUX=1                    — faux provider with the kit-planner /
 *                                   kit-impl / kit-verifier model ids
 *   KIT_FAUX_SCRIPT=<file>        — replay file with PER-ROLE sections:
 *
 *                                     [planner]
 *                                     --- separated chunks…
 *                                     [implementer]
 *                                     …
 *                                     [verifier]
 *                                     …
 *
 *   A chunk is one model request's answer: plain text (·the assistant turn) or
 *   a JSON object. `{"tool":"write","path":…,"content":…}` plays a tool call
 *   (then the NEXT chunk is the same run's final text). Planner chunks are
 *   the tasks JSON; verifier chunks are the verdict JSON.
 *
 *   Per-run process: each role's queue starts at its first chunk (restarts
 *   replay deterministically; restarts mid-wave consume the next chunk).
 *   Missing script: every request answers a fixed stub (paper-trail run).
 */
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Models } from "@earendil-works/pi-ai";
import { readFileSync, existsSync } from "node:fs";

export const FAUX_MODELS = ["kit-planner", "kit-impl", "kit-verifier"] as const;

export interface FauxOverlay {
	models: Models;
	/** true when provider ids like "faux" are valid in this session (KIT_FAUX=1). */
	active: true;
}

export function maybeFauxModels(): FauxOverlay | undefined {
	if (process.env["KIT_FAUX"] !== "1") return undefined;
	const chunks = readScript();
	const faux = fauxProvider({
		models: [
			{ id: FAUX_MODELS[0], name: "Kit Planner (faux smoke)" },
			{ id: FAUX_MODELS[1], name: "Kit Impl (faux smoke)" },
			{ id: FAUX_MODELS[2], name: "Kit Verifier (faux smoke)" },
		],
	});
	faux.setResponses(buildStepResponses(chunks));
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, active: true };
}

function readScript(): string[] {
	const file = process.env["KIT_FAUX_SCRIPT"];
	if (!file || !existsSync(file)) {
		return [];
	}
	const raw = readFileSync(file, "utf8");
	return parseRoleSections(raw);
}

/**
 * Accepts either flat `---` chunks (legacy, all-roles) or the `[planner] /
 * [implementer] / [verifier]` section layout. Flat files map planner→0,
 * implementer→1..n-1 (unchanged, in order), verifier→last.
 */
function parseRoleSections(raw: string): string[] {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("[planner]")) {
		return trimmed
			.split(/^\s*---\s*$/m)
			.map((c) => c.trim())
			.filter(Boolean);
	}
	const byRole: Record<string, string[]> = {};
	let role = "planner";
	for (const line of trimmed.split("\n")) {
		const header = line.trim().match(/^\[(planner|implementer|verifier)\]$/);
		if (header) {
			role = header[1]!;
			continue;
		}
		byRole[role] = (byRole[role] ?? []).concat(line);
	}
	const joinChunks = (lines: string[]): string[] => {
		const text = lines.join("\n");
		return text
			.split(/^\s*---\s*$/m)
			.map((c) => c.trim())
			.filter(Boolean);
	};
	return [
		...joinChunks(byRole["planner"] ?? []).map((c) => `/P/${c}`),
		...joinChunks(byRole["implementer"] ?? []).map((c) => `/I/${c}`),
		...joinChunks(byRole["verifier"] ?? []).map((c) => `/V/${c}`),
	];
}

/** Wrap joins with model id prefixes via closure state; the step fn picks. */
function buildStepResponses(chunks: string[]): FauxResponseStep[] {
	if (process.env["KIT_DEBUG_FAUX"]) {
		const byRole = { "kit-planner": 0, "kit-impl": 0, "kit-verifier": 0 } as Record<string, number>;
		let cursor = "kit-planner";
		for (const chunk of chunks) {
			if (chunk.startsWith("/P/")) cursor = "kit-planner";
			else if (chunk.startsWith("/I/")) cursor = "kit-impl";
			else if (chunk.startsWith("/V/")) cursor = "kit-verifier";
			byRole[cursor] = (byRole[cursor] ?? 0) + 1;
		}
		console.error(`[faux] queues:`, JSON.stringify(byRole));
	}
	const queues = new Map<string, string[]>();
	for (const m of FAUX_MODELS) {
		queues.set(m, []);
	}
	// Chunk prefixes: /P/ /I/ /V/ route into per-model queues.
	let cursor: string = "kit-planner";
	for (const chunk of chunks) {
		if (chunk.startsWith("/P/")) cursor = "kit-planner";
		else if (chunk.startsWith("/I/")) cursor = "kit-impl";
		else if (chunk.startsWith("/V/")) cursor = "kit-verifier";
		const bare = chunk.replace(/^\/[PIV]\//, "");
		queues.set(cursor, [...(queues.get(cursor) ?? []), bare]);
	}
	const stub: AssistantMessage = fauxAssistantMessage(STUB_TEXT, { stopReason: "stop" });
	const stepFn = ((_context: unknown, _stream: unknown, _state: unknown, model: { id: string }) => {
		const queue = queues.get(model.id) ?? [];
		const next = queue.shift();
		if (process.env["KIT_DEBUG_FAUX"]) console.error(`[faux-serve] ${model.id} → ${String(next ?? "<stub>").replace(/\s+/g, " ").slice(0, 90)}`);
		if (next === undefined) return stub;
		if (next.trimStart().startsWith("{")) {
			try {
				const parsed = JSON.parse(next) as ReplayToolCall;
				if (typeof parsed.tool === "string") {
					const args: Record<string, string> = {};
					if (parsed.path !== undefined) args.path = parsed.path;
					if (parsed.content !== undefined) args.content = parsed.content;
					if (parsed.command !== undefined) args.command = parsed.command;
					return fauxAssistantMessage([fauxToolCall(parsed.tool, args)], { stopReason: "toolUse" });
				}
			} catch {
				/* plain text */
			}
		}
		return fauxAssistantMessage(next, { stopReason: "stop" });
	});
	return new Array(64).fill(stepFn);
}

interface ReplayToolCall {
	tool?: "write" | "edit" | "bash" | "read";
	path?: string;
	content?: string;
	command?: string;
}

const STUB_TEXT = "KIT_FAUX smoke stub: no real model involved. STATUS: COMPLETE (scripted stub; inspect router.md).";

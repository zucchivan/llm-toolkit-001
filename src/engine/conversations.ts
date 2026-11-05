/**
 * Conversation operations shared by planner, wave driver, and verifier.
 * One durable ownerless conversation per role unit (planner session, task
 * implementer, task verifier) with role-configured `pi.agent` (model,
 * thinking level, exact tool selection, instructions, cwd, maxTurns) and the
 * `loop.guard` doc enforcing file boundaries in beforeTool hooks.
 */
import type { Conversation, ToolRegistration } from "./kit.ts";
import { BACKGROUND_CONTEXT, AssistantEntry, LiveDoc, UsageDoc, convId, entryId, idOfConversation } from "./kit.ts";
import { LoopGuardDoc, estimateUsageUsd } from "./harness.ts";
import type { LoopAndLock } from "./harness.ts";
import type { RoleName } from "../config.ts";
import type { CostRates } from "../util/budget.ts";

export interface WaveOutcome {
	status: "done" | "unanswered";
	/** Final assistant text when the run answered. */
	answer?: string;
	/** runFailure reason + detail when unanswered (model_error, turn_limit, …). */
	reason?: string;
	detail?: unknown;
	/** Estimated spend + tokens of this conversation up to read time. */
	usage: { usd: number; totalTokens: number };
}

export interface RoleSetup {
	/** Read by humans in router/status views. */
	instructions: string;
	/** guard doc content: boundary enforcement for this unit. */
	guard: { role: RoleName; targetPaths: string[] };
	/** Agent tools: "coding" → read+write+edit+bash; "read" → read only. */
	tools: "coding" | "read";
	/** Set the model+thinking per role from config; absent: host default. */
	model: { provider: string; modelId: string; thinkingLevel?: string };
	maxTurns: number;
}

export class ConversationKit {
	constructor(
		private readonly kit: LoopAndLock,
		private readonly tools: { read: ToolRegistration; write: ToolRegistration; edit: ToolRegistration; bash: ToolRegistration },
	) {}

	/**
	 * Create the durable conversation for one role unit and configure it in the
	 * creating commit (agent + guard doc). Use `find()` instead when it exists.
	 */
	async createUnit(setup: RoleSetup): Promise<Conversation> {
		const harness = this.kit.loop.harness;
		const conv = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: { provider: setup.model.provider, modelId: setup.model.modelId },
					thinkingLevel: (setup.model.thinkingLevel as "off" | "low" | "medium" | "high" | undefined) ?? undefined,
					tools: setup.tools === "coding" ? [this.tools.read, this.tools.write, this.tools.edit, this.tools.bash] : [this.tools.read],
					instructions: setup.instructions,
					cwd: this.kit.loop.paths.root,
					maxTurns: setup.maxTurns,
				},
				init: async (tx, conversationId) => {
					const doc = await tx.doc(LoopGuardDoc, conversationId);
					doc.role = setup.guard.role;
					doc.targetPaths = setup.guard.targetPaths;
				},
			},
			BACKGROUND_CONTEXT,
		);
		return conv;
	}

	/** Reacquire a previous unit's conversation by id (durably stored). */
	find(conversationId: number): Promise<Conversation | undefined> {
		return this.kit.loop.harness.conversation(convId(conversationId), BACKGROUND_CONTEXT);
	}

	/**
	 * One-shot durable input. `requestId` makes resubmission idempotent:
	 * a rerun after a crash finds the same submission instead of doubling the wave.
	 */
	async submitAndAwait(conv: Conversation, requestId: string, content: string): Promise<WaveOutcome> {
		const harness = this.kit.loop.harness;
		const submission = await conv.submit({ type: "input", content, requestId }, BACKGROUND_CONTEXT);
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		if (settled.type !== "input") {
			// continues/writes never reach this call path
			return { status: "unanswered", reason: "not_input", usage: await this.conversationUsage(conv.id) };
		}
		if (settled.status === "done") {
			return { status: "done", answer: await this.readAnswerText(settled.answer), usage: await this.conversationUsage(conv.id) };
		}
		const live = await harness.snapshot(LiveDoc, conv.id, BACKGROUND_CONTEXT);
		return {
			status: "unanswered",
			reason: live?.runFailure?.reason,
			detail: live?.runFailure && "detail" in live.runFailure ? live.runFailure.detail : undefined,
			usage: await this.conversationUsage(conv.id),
		};
	}

	/** Read the run's final answer entry text through the quick-start commit read. */
	private async readAnswerText(answerEntryId: number): Promise<string> {
		const entry = await this.kit.loop.harness.commit((tx) => tx.entry(AssistantEntry, entryId(answerEntryId)), BACKGROUND_CONTEXT);
		const message = entry?.model?.[0] as { content?: Array<{ type: string; text?: string }> } | undefined;
		return (message?.content ?? [])
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("");
	}

	/** Conversation usage (pi.usage doc): estimated USD + total tokens. */
	async conversationUsage(conversationId: number): Promise<{ usd: number; totalTokens: number }> {
		const usage = await this.kit.loop.harness.snapshot(UsageDoc, convId(conversationId), BACKGROUND_CONTEXT);
		if (!usage) return { usd: 0, totalTokens: 0 };
		let usd = 0;
		let totalTokens = 0;
		const rates: Record<string, CostRates> = {};
		for (const role of Object.values(this.kit.loop.config.roles)) {
			rates[`${role.provider}/${role.modelId}`] = {
				costPerMillionInput: role.costPerMillionInput,
				costPerMillionOutput: role.costPerMillionOutput,
			};
		}
		for (const [key, record] of Object.entries(usage.models)) {
			totalTokens += Number(record.totalTokens ?? 0);
			usd += estimateUsageUsd(record, rates[key]);
		}
		for (const record of Object.values(usage.tools)) {
			totalTokens += Number(record.totalTokens ?? 0);
		}
		return { usd, totalTokens };
	}
}

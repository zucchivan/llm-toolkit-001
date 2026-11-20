import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import type {
	ChoiceJudgmentAnswer, JudgmentClient, JudgmentQuestion, JudgmentRequest, JudgmentResponse,
	NoulJudgmentAnswer,
} from "./types.ts";

export interface TypeSafeJudgmentClientOptions {
	/** Credentials come only from TYPESAFE_API_KEY or explicit injection, never project config. */
	apiKey: string;
	model?: string;
	timeoutMs?: number;
}

/** Thin TypeSafe adapter; it does not interpret confidence or make decisions. */
export class TypeSafeJudgmentClient implements JudgmentClient {
	private readonly client: TypeSafeClient;
	private readonly model: string;

	constructor(options: TypeSafeJudgmentClientOptions) {
		this.model = options.model ?? "jev-latest";
		this.client = new TypeSafeClient({
			apiKey: options.apiKey,
			defaultModel: this.model,
			...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
		});
	}

	async judge(request: JudgmentRequest): Promise<JudgmentResponse> {
		const questions: Questions = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [
			id,
			question.type === "noul"
				? noul(question.instructions)
				: choice(question.instructions, question.criteria),
		]));
		const response = await this.client.systemOne({ state: request.state, questions, model: request.model });
		const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
			const answer = response.answers[id];
			if (!answer) throw new Error(`TypeSafe response omitted answer ${id}`);
			return [id, question.type === "noul" ? readNoul(answer) : readChoice(answer, question)];
		}));
		return {
			model: response.model,
			answers,
			usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
		};
	}
}

function readNoul(value: unknown): NoulJudgmentAnswer {
	const answer = object(value);
	if (answer["type"] !== "noul") throw new Error("TypeSafe returned a non-Noul answer for a Noul question");
	return { type: "noul", probability: probability(answer["noul"], "Noul probability") };
}

function readChoice(value: unknown, question: Extract<JudgmentQuestion, { type: "choice" }>): ChoiceJudgmentAnswer {
	const answer = object(value);
	if (answer["type"] !== "choice") throw new Error("TypeSafe returned a non-Choice answer for a Choice question");
	const selected = answer["choice"];
	if (typeof selected !== "string" || !(selected in question.criteria)) throw new Error("TypeSafe returned an unknown Choice label");
	const rawProbabilities = object(answer["probabilities"]);
	const probabilities = Object.fromEntries(Object.keys(question.criteria).map((label) => [
		label, probability(rawProbabilities[label], `Choice probability ${label}`),
	]));
	return {
		type: "choice", choice: selected, probabilities,
		confidence: probability(answer["confidence"], "Choice confidence"),
	};
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("TypeSafe returned a malformed answer");
	return value as Record<string, unknown>;
}

function probability(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`${label} must be a finite number between 0 and 1`);
	}
	return value;
}

import type {
	JudgmentAnswer, JudgmentClient, JudgmentRequest, JudgmentResponse, JudgmentTokenUsage,
} from "./types.ts";

export type FakeJudgmentHandler = (request: JudgmentRequest) => JudgmentResponse | Promise<JudgmentResponse>;

/** Injectable test adapter. The default response is deliberately uncertain. */
export class FakeJudgmentClient implements JudgmentClient {
	readonly requests: JudgmentRequest[] = [];
	private readonly handler: FakeJudgmentHandler;

	constructor(handler?: FakeJudgmentHandler) {
		this.handler = handler ?? uncertainResponse;
	}

	async judge(request: JudgmentRequest): Promise<JudgmentResponse> {
		this.requests.push(structuredClone(request));
		return await this.handler(request);
	}
}

export function fakeJudgmentResponse(
	request: JudgmentRequest,
	answers: Record<string, JudgmentAnswer>,
	usage: JudgmentTokenUsage = { inputTokens: 100, outputTokens: 20 },
): JudgmentResponse {
	return { model: request.model, answers, usage };
}

function uncertainResponse(request: JudgmentRequest): JudgmentResponse {
	const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
		if (question.type === "noul") return [id, { type: "noul", probability: 0.5 } satisfies JudgmentAnswer];
		const labels = Object.keys(question.criteria);
		const probability = 1 / labels.length;
		return [id, {
			type: "choice", choice: labels[0]!, confidence: 0,
			probabilities: Object.fromEntries(labels.map((label) => [label, probability])),
		} satisfies JudgmentAnswer];
	}));
	return fakeJudgmentResponse(request, answers);
}

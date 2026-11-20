/** Minimal, provider-neutral System One seam. Code owns all policy and effects. */
export type JudgmentJson = string | number | boolean | null | JudgmentJson[] | { [key: string]: JudgmentJson };
export type JudgmentState = { [key: string]: JudgmentJson };

export interface NoulJudgmentQuestion {
	type: "noul";
	instructions: string;
}

export interface ChoiceJudgmentQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

export type JudgmentQuestion = NoulJudgmentQuestion | ChoiceJudgmentQuestion;

export interface NoulJudgmentAnswer {
	type: "noul";
	/** Probability that the statement is true. No threshold is applied by the adapter. */
	probability: number;
}

export interface ChoiceJudgmentAnswer {
	type: "choice";
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}

export type JudgmentAnswer = NoulJudgmentAnswer | ChoiceJudgmentAnswer;

export interface JudgmentRequest {
	state: JudgmentState;
	questions: Record<string, JudgmentQuestion>;
	model: string;
}

export interface JudgmentTokenUsage {
	inputTokens: number | null;
	outputTokens: number | null;
}

export interface JudgmentResponse {
	model: string;
	answers: Record<string, JudgmentAnswer>;
	usage: JudgmentTokenUsage;
}

export interface JudgmentClient {
	judge(request: JudgmentRequest): Promise<JudgmentResponse>;
}

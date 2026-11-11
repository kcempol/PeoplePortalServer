import type { ClubScoringConfig } from "./ATSEvaluationConfig";
import { EvaluationError, prepareResumeEvidence, SCORING_INSTRUCTIONS, validateProviderResult, type ScoringInput, type ScoringProvider, type ProviderResult } from "./ATSEvaluationEngine";

export interface SpendLedger { reserve(usd: number, ceiling: number): Promise<boolean> }
export type AITransport = (key: string, body: object) => Promise<unknown>;
export const responsesTransport: AITransport = async (key, body) => {
    const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error("Provider request failed");
    return response.json();
};
const string = { type: "string" };
const schema = {
    type: "object", additionalProperties: false, required: ["inferredJobFocus", "explanation", "categories"],
    properties: { inferredJobFocus: string, explanation: string, categories: { type: "array", items: {
        type: "object", additionalProperties: false, required: ["key", "score", "explanation", "evidence"],
        properties: { key: { type: "string", enum: ["skills", "projects", "experience", "outcomes"] }, score: { type: "number", minimum: 0, maximum: 100 }, explanation: string, evidence: { type: "array", items: string } },
    } } },
};

export class OpenAIScoringProvider implements ScoringProvider {
    readonly modelVersion: string;
    constructor(private readonly config: ClubScoringConfig, private readonly ledger: SpendLedger, private readonly transport: AITransport = responsesTransport) {
        this.modelVersion = config.model;
    }
    async score(input: ScoringInput): Promise<ProviderResult> {
        input = { ...input, resumeText: prepareResumeEvidence(input.resumeText) };
        // Reserve a conservative byte-based token upper bound, including schema overhead.
        // Reservations are never refunded, including on failures/unknown billing outcomes.
        const inputTokens = Buffer.byteLength(JSON.stringify(input) + SCORING_INSTRUCTIONS + JSON.stringify(schema), "utf8") + 1024;
        const cost = (inputTokens * this.config.inputUsdPerMillion + this.config.maxOutputTokens * this.config.outputUsdPerMillion) / 1_000_000;
        if (cost > this.config.maxCostUsdPerEvaluation || !(await this.ledger.reserve(cost, this.config.totalBudgetUsd)))
            throw new EvaluationError("BUDGET_EXCEEDED", "The scoring budget is exhausted or this evaluation exceeds its limit.");
        try {
            const raw = await this.transport(this.config.apiKey, {
                model: this.config.model, store: false, instructions: SCORING_INSTRUCTIONS,
                input: JSON.stringify(input), max_output_tokens: this.config.maxOutputTokens,
                text: { format: { type: "json_schema", name: "resume_evaluation", strict: true, schema } },
            }) as { status?: string; output?: { type: string; content?: { type: string; text?: string }[] }[] };
            if (raw.status !== "completed") throw new Error("Incomplete response");
            const parts = raw.output?.filter(item => item.type === "message").flatMap(item => item.content || []);
            if (!parts?.length || parts.some(part => part.type !== "output_text")) throw new Error("Refusal or malformed output");
            const result = JSON.parse(parts.map(part => part.text || "").join("")) as ProviderResult;
            validateProviderResult(result, input.resumeText);
            return result;
        } catch { throw new EvaluationError("PROVIDER_FAILED", "The scoring response could not be completed or validated."); }
    }
}

import { PROVIDER_TIMEOUT_MS, CATEGORY_KEYS } from "./ATSEvaluationTypes";
import type { ClubScoringConfig } from "./ATSEvaluationSetup";
import { EvaluationError, SCORING_INSTRUCTIONS, validateProviderResult, type SanitizedScoringInput, type ScoringProvider, type ProviderResult } from "./ATSEvaluationEngine";

export interface SpendLedger { reserve(usd: number, ceiling: number): Promise<boolean> }
export type AITransport = (key: string, body: object) => Promise<unknown>;
export const responsesTransport: AITransport = async (key, body) => {
    const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("Provider request failed");
    return response.json();
};
const STRING_SCHEMA = { type: "string" };
export const OPENAI_RESPONSE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["inferredJobFocus", "explanation", "categories"],
    properties: {
        inferredJobFocus: STRING_SCHEMA,
        explanation: STRING_SCHEMA,
        categories: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["key", "score", "explanation", "evidence"],
                properties: {
                    key: { type: "string", enum: CATEGORY_KEYS },
                    score: { type: "number", minimum: 0, maximum: 100 },
                    explanation: STRING_SCHEMA,
                    evidence: { type: "array", items: STRING_SCHEMA },
                },
            },
        },
    },
};

export class OpenAIScoringProvider implements ScoringProvider {
    readonly modelVersion: string;
    constructor(private readonly config: ClubScoringConfig, private readonly ledger: SpendLedger, private readonly transport: AITransport = responsesTransport) {
        this.modelVersion = config.model;
    }
    async score(input: SanitizedScoringInput): Promise<ProviderResult> {
        const cost = estimateEvaluationCost(input, this.config);
        if (cost > this.config.maxCostUsdPerEvaluation || !(await this.ledger.reserve(cost, this.config.totalBudgetUsd)))
            throw new EvaluationError("BUDGET_EXCEEDED", "The scoring budget is exhausted or this evaluation exceeds its limit.");
        try {
            const raw = await this.transport(this.config.apiKey, buildScoringRequest(input, this.config));
            const result = parseScoringResponse(raw);
            validateProviderResult(result, input.resumeText);
            return result;
        } catch { throw new EvaluationError("PROVIDER_FAILED", "The scoring response could not be completed or validated."); }
    }
}

/** Pessimistic reservations are retained even when billing outcome is unknown. */
export function estimateEvaluationCost(input: SanitizedScoringInput, config: ClubScoringConfig): number {
    const inputTokens = Buffer.byteLength(JSON.stringify(input) + SCORING_INSTRUCTIONS + JSON.stringify(OPENAI_RESPONSE_SCHEMA), "utf8") + 1024;
    return (inputTokens * config.inputUsdPerMillion + config.maxOutputTokens * config.outputUsdPerMillion) / 1_000_000;
}

export function buildScoringRequest(input: SanitizedScoringInput, config: ClubScoringConfig) {
    return {
        model: config.model, store: false, instructions: SCORING_INSTRUCTIONS,
        input: JSON.stringify(input), max_output_tokens: config.maxOutputTokens,
        text: { format: { type: "json_schema", name: "resume_evaluation", strict: true, schema: OPENAI_RESPONSE_SCHEMA } },
    };
}

interface ProviderResponse {
    status?: string;
    output?: { type: string; content?: { type: string; text?: string }[] }[];
}
export function parseScoringResponse(response: unknown): ProviderResult {
    const raw = response as ProviderResponse;
    if (raw.status !== "completed") throw new Error("Incomplete response");
    const parts = raw.output?.filter(item => item.type === "message").flatMap(item => item.content || []);
    if (!parts?.length || parts.some(part => part.type !== "output_text")) throw new Error("Refusal or malformed output");
    const result = JSON.parse(parts.map(part => part.text || "").join("")) as ProviderResult;
    return result;
}

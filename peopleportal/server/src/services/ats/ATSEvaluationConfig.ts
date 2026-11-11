/** Server-only configuration contract for a future club-owned provider. */
export interface ClubScoringConfig {
    apiKey: string;
    model: string;
    maxOutputTokens: number;
    maxCostUsdPerEvaluation: number;
    totalBudgetUsd: number;
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
}

export function readClubScoringConfig(env: NodeJS.ProcessEnv = process.env): ClubScoringConfig | null {
    if (env.ATS_AI_SCORING_ENABLED !== "true" || !env.OPENAI_API_KEY || !env.ATS_AI_MODEL) return null;
    const maxOutputTokens = Number(env.ATS_AI_MAX_OUTPUT_TOKENS);
    const maxCostUsdPerEvaluation = Number(env.ATS_AI_MAX_COST_USD_PER_EVALUATION);
    const totalBudgetUsd = Number(env.ATS_AI_TOTAL_BUDGET_USD);
    const inputUsdPerMillion = Number(env.ATS_AI_INPUT_USD_PER_MILLION);
    const outputUsdPerMillion = Number(env.ATS_AI_OUTPUT_USD_PER_MILLION);
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 4096 ||
        [maxCostUsdPerEvaluation, totalBudgetUsd, inputUsdPerMillion, outputUsdPerMillion].some(v => !Number.isFinite(v) || v <= 0)) return null;
    return { apiKey: env.OPENAI_API_KEY, model: env.ATS_AI_MODEL, maxOutputTokens, maxCostUsdPerEvaluation, totalBudgetUsd, inputUsdPerMillion, outputUsdPerMillion };
}

import { PRIVACY_POLICY_VERSION } from "./ATSEvaluationTypes";
/** Server-only configuration contract. Privacy approval must match the deployed preparation policy. */
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
    if (env.ATS_AI_SCORING_ENABLED !== "true" || !env.OPENAI_API_KEY?.trim() || !env.ATS_AI_MODEL?.trim()) return null;
    const maxOutputTokens = Number(env.ATS_AI_MAX_OUTPUT_TOKENS);
    const maxCostUsdPerEvaluation = Number(env.ATS_AI_MAX_COST_USD_PER_EVALUATION);
    const totalBudgetUsd = Number(env.ATS_AI_TOTAL_BUDGET_USD);
    const inputUsdPerMillion = Number(env.ATS_AI_INPUT_USD_PER_MILLION);
    const outputUsdPerMillion = Number(env.ATS_AI_OUTPUT_USD_PER_MILLION);
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 4096 ||
        [maxCostUsdPerEvaluation, totalBudgetUsd, inputUsdPerMillion, outputUsdPerMillion].some(v => !Number.isFinite(v) || v <= 0)) return null;
    return { apiKey: env.OPENAI_API_KEY, model: env.ATS_AI_MODEL, maxOutputTokens, maxCostUsdPerEvaluation, totalBudgetUsd, inputUsdPerMillion, outputUsdPerMillion };
}
import { OpenAIScoringProvider } from "./OpenAIScoringProvider";
import { mongoSpendLedger } from "../../models/ScoringBudget";
import { createResumeExtractor } from "./ResumeExtractor";
import { Applicant } from "../../models/Applicant";
import { Application } from "../../models/Application";
import { ATSEvaluationWorker } from "./ATSEvaluationWorker";
import { EvaluationReconciliationWorker } from "./EvaluationReconciliationWorker";
import type { EvaluationDependencies } from "./ATSEvaluationService";

// Never construct live clients during tests or development. Deployment requires
// an explicit club confirmation as well as complete provider configuration.
export function productionEvaluationDependencies(): EvaluationDependencies {
    if (process.env.NODE_ENV !== "production" || process.env.ATS_AI_CLUB_CONFIRMED !== "true" ||
        process.env.ATS_AI_PRIVACY_REVIEWED_VERSION !== PRIVACY_POLICY_VERSION || !process.env.S3_BUCKET_NAME?.trim() ||
        !process.env.AWS_ACCESS_KEY_ID?.trim() || !process.env.AWS_SECRET_ACCESS_KEY?.trim()) return {};
    const config = readClubScoringConfig();
    if (!config) return {};
    return {
        enabled: true, provider: new OpenAIScoringProvider(config, mongoSpendLedger),
        extractResumeText: createResumeExtractor(async id => {
            const app = await Application.findById(id).exec();
            if (!app?.resumeKey || !app.resumeHash) return null; // Legacy applications require manual review.
            const applicant = await Applicant.findById(app.applicantId).exec();
            return applicant ? { id: String(app._id), applicantId: String(app.applicantId), key: app.resumeKey,
                hash: app.resumeHash, fullName: app.profileSnapshot?.get("submittedFullName") || "" } : null;
        }, async key => {
            const { GetObjectCommand } = await import("@aws-sdk/client-s3");
            const { s3Client, BUCKET_NAME } = await import("../../clients/AWSClient/S3Client");
            const object = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }), { abortSignal: AbortSignal.timeout(15_000) });
            if (!object.Body) throw new Error("Missing object");
            return { contentType: object.ContentType || "", size: object.ContentLength || 0, body: object.Body as AsyncIterable<Uint8Array> };
        }),
    };
}
export function startProductionEvaluationWorker(): () => Promise<void> {
    const deps = productionEvaluationDependencies();
    return deps.enabled ? new ATSEvaluationWorker(deps).start() : async () => {};
}

export function startProductionEvaluationReconciler(): () => Promise<void> {
    const deps = productionEvaluationDependencies();
    return deps.enabled ? new EvaluationReconciliationWorker(deps).start() : async () => {};
}

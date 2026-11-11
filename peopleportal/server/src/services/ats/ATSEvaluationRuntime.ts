import { readClubScoringConfig } from "./ATSEvaluationConfig";
import { OpenAIScoringProvider } from "./OpenAIScoringProvider";
import { mongoSpendLedger } from "../../models/ScoringBudget";
import { createResumeExtractor } from "./ResumeExtractor";
import { Applicant } from "../../models/Applicant";
import { ATSEvaluationWorker } from "./ATSEvaluationWorker";
import type { EvaluationDependencies } from "./ATSEvaluationService";

// Never construct live clients during tests or development. Deployment requires
// an explicit club confirmation as well as complete provider configuration.
export function productionEvaluationDependencies(): EvaluationDependencies {
    if (process.env.NODE_ENV !== "production" || process.env.ATS_AI_CLUB_CONFIRMED !== "true" || !process.env.S3_BUCKET_NAME) return {};
    const config = readClubScoringConfig();
    if (!config) return {};
    return {
        enabled: true, provider: new OpenAIScoringProvider(config, mongoSpendLedger),
        extractResumeText: createResumeExtractor(async id => {
            const applicant = await Applicant.findById(id).exec();
            return applicant ? { id: String(applicant._id), key: applicant.profile.get("resumeUrl") || "", fullName: applicant.fullName } : null;
        }, async key => {
            const { GetObjectCommand } = await import("@aws-sdk/client-s3");
            const { s3Client, BUCKET_NAME } = await import("../../clients/AWSClient/S3Client");
            const object = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }), { abortSignal: AbortSignal.timeout(15_000) });
            if (!object.Body) throw new Error("Missing object");
            return { contentType: object.ContentType || "", size: object.ContentLength || 0, body: object.Body as AsyncIterable<Uint8Array> };
        }),
    };
}
export function startProductionEvaluationWorker(): () => void {
    const deps = productionEvaluationDependencies();
    return deps.enabled ? new ATSEvaluationWorker(deps).start() : () => {};
}

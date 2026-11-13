import { AutomatedEvaluation, type IAutomatedEvaluation } from "../../models/AutomatedEvaluation";
import { contentHash, EvaluationError, PROMPT_VERSION, RUBRIC_VERSION, scoreExtractedResume, validateResumeText } from "./ATSEvaluationEngine";
import { isEvaluationEnabled, NOT_CONFIGURED, type EvaluationDependencies } from "./ATSEvaluationTypes";

/** Runs one evaluation; lease-fenced writes prevent interrupted workers saving late results. */
export class ATSEvaluationProcessor {
    constructor(private readonly deps: EvaluationDependencies) { }

    async process(record: IAutomatedEvaluation, leaseToken?: string) {
        if (!isEvaluationEnabled(this.deps)) throw new EvaluationError("NOT_CONFIGURED", NOT_CONFIGURED.message);
        if (record.status !== "queued" && !(leaseToken && record.status === "processing")) return;
        const save = async () => {
            if (!leaseToken) { await record.save(); return; }
            const { _id, __v, ...data } = record.toObject();
            const saved = await AutomatedEvaluation.findOneAndUpdate(
                { _id: record._id, leaseToken, leaseUntil: { $gt: new Date() } },
                { $set: data }, { new: true },
            ).exec();
            if (!saved) throw new EvaluationError("LEASE_LOST", "The processing lease expired.");
        };
        record.status = "processing";
        record.startedAt = new Date();
        await save();
        try {
            const resumeText = await this.deps.extractResumeText(String(record.applicationId));
            // Content hash prevents duplicate scoring of unchanged input for this application/job.
            const hash = contentHash(validateResumeText(resumeText));
            if (record.resumeContentHash === hash && record.overallScore !== undefined &&
                record.rubricVersion === RUBRIC_VERSION && record.modelVersion === this.deps.provider.modelVersion &&
                record.promptVersion === PROMPT_VERSION) {
                record.status = "scored";
                await save();
                return;
            }
            const scored = await scoreExtractedResume({ resumeText, jobTitle: record.jobTitle, importantRequirements: record.importantRequirements || "" }, this.deps.provider);
            record.inferredJobFocus = scored.inferredJobFocus;
            record.overallScore = scored.overallScore;
            record.categories = scored.categories;
            record.explanation = scored.explanation;
            record.resumeContentHash = scored.resumeContentHash;
            record.scoredAt = new Date();
            record.status = "scored";
        } catch (error) {
            record.status = "failed";
            record.failedAt = new Date();
            record.failureCode = error instanceof EvaluationError ? error.code : "SCORING_FAILED";
            record.failureMessage = error instanceof EvaluationError ? error.safeMessage : "The evaluation could not be completed.";
        }
        await save();
    }

}

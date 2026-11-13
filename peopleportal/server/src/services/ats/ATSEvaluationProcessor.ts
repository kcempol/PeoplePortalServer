import { Application } from "../../models/Application";
import { SubteamConfig } from "../../models/SubteamConfig";
import { AutomatedEvaluation, type IAutomatedEvaluation } from "../../models/AutomatedEvaluation";
import { EvaluationError, scoreExtractedResume, scoringContext } from "./ATSEvaluationEngine";
import { isEvaluationEnabled, scoringEvent, type EvaluationDependencies } from "./ATSEvaluationTypes";

/** Reload current context at both ends of a request, independently of best-effort invalidation. */
export async function loadScoringContext(record: IAutomatedEvaluation, modelVersion: string) {
    const app = await Application.findOne({ _id: record.applicationId, teamPk: record.teamPk }).exec();
    if (!app || String(app.applicantId) !== String(record.applicantId) || !app.resumeHash || !app.resumeKey ||
        !app.rolePreferences.some(p => p.subteamPk === record.subteamPk && p.role === record.jobTitle)) {
        throw new EvaluationError("SNAPSHOT_REQUIRED", "A submitted résumé snapshot is required for automatic scoring.");
    }
    if (app.resumeKey !== `resumes/${app.applicantId}/${app._id}.pdf`) {
        throw new EvaluationError("SNAPSHOT_INVALID", "The submitted résumé snapshot could not be verified.");
    }
    const config = await SubteamConfig.findOne({ subteamPk: record.subteamPk }).exec();
    if (!config?.roles.includes(record.jobTitle)) throw new EvaluationError("OPENING_CHANGED", "The selected opening is no longer available.");
    return scoringContext(record.jobTitle, config.importantRequirementsByRole?.find(r => r.role === record.jobTitle)?.text || "", app.resumeHash, modelVersion);
}

/** Every production write requires an active lease. Never publish a late or obsolete response. */
export class ATSEvaluationProcessor {
    constructor(private readonly deps: EvaluationDependencies) {}

    async process(record: IAutomatedEvaluation, leaseToken: string) {
        if (!isEvaluationEnabled(this.deps)) return;
        const owned = () => ({ _id: record._id, status: "processing", leaseToken, leaseUntil: { $gt: new Date() } });
        let context: Awaited<ReturnType<typeof loadScoringContext>> | undefined;
        try {
            context = await loadScoringContext(record, this.deps.provider.modelVersion);
            const changedContext = record.contextKey ? record.contextKey !== context.contextKey :
                record.modelVersion !== context.modelVersion || record.rubricVersion !== context.rubricVersion ||
                record.promptVersion !== context.promptVersion || (record.importantRequirements || "").trim() !== context.importantRequirements;
            const started = await AutomatedEvaluation.findOneAndUpdate(owned(), {
                $set: { ...context, startedAt: new Date(), ...(changedContext ? { attempts: 1 } : {}) }, $inc: { revision: 1 },
            }, { new: true }).exec();
            if (!started) { scoringEvent("lease_lost"); return; }
            const resumeText = await this.deps.extractResumeText(String(record.applicationId));
            const result = await scoreExtractedResume({ resumeText, jobTitle: context.jobTitle,
                importantRequirements: context.importantRequirements }, this.deps.provider);
            const current = await loadScoringContext(record, this.deps.provider.modelVersion);
            if (current.contextKey !== context.contextKey) {
                await AutomatedEvaluation.updateOne({ ...owned(), contextKey: context.contextKey }, {
                    $set: { status: "stale", staleAt: new Date() }, $unset: { leaseToken: 1, leaseUntil: 1 }, $inc: { revision: 1 },
                }).exec();
                return;
            }
            const saved = await AutomatedEvaluation.findOneAndUpdate({ ...owned(), contextKey: context.contextKey }, {
                $set: { ...result, ...context, status: "scored", scoredAt: new Date() },
                $unset: { leaseToken: 1, leaseUntil: 1, failureCode: 1, failureMessage: 1 }, $inc: { revision: 1 },
            }, { new: true, runValidators: true }).exec();
            if (!saved) scoringEvent("lease_lost");
        } catch (error) {
            scoringEvent("worker_failed");
            await AutomatedEvaluation.updateOne({ ...owned(), ...(context ? { contextKey: context.contextKey } : {}) }, {
                $set: { status: "failed", failedAt: new Date(), failureCode: error instanceof EvaluationError ? error.code : "SCORING_FAILED",
                    failureMessage: error instanceof EvaluationError ? error.safeMessage : "The evaluation could not be completed." },
                $unset: { leaseToken: 1, leaseUntil: 1 }, $inc: { revision: 1 },
            }).exec();
        }
    }
}

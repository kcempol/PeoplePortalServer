import { Application } from "../../models/Application";
import { AutomatedEvaluation, EVALUATION_LABEL, type IAutomatedEvaluation } from "../../models/AutomatedEvaluation";
import { loadScoringContext } from "./ATSEvaluationProcessor";
import { isEvaluationEnabled, NOT_CONFIGURED, MAX_ATTEMPTS, type EvaluationDependencies } from "./ATSEvaluationTypes";
import type { ATSResponse } from "./ATSHelpers";
export type { EvaluationDependencies } from "./ATSEvaluationTypes";
export interface EvaluationRequest { subteamPk: string; jobTitle: string }

/** HTTP adapter. State changes compare the revision/status read before the operation. */
export class ATSEvaluationService {
    constructor(private readonly response: ATSResponse, private readonly deps: EvaluationDependencies = {}) {}

    private filter(applicationId: string, request: EvaluationRequest) {
        return { applicationId, subteamPk: request.subteamPk, jobTitle: request.jobTitle };
    }

    private async application(teamPk: string, applicationId: string, request: EvaluationRequest) {
        const app = await Application.findOne({ _id: applicationId, teamPk }).exec();
        if (!app || !app.rolePreferences.some(p => p.role === request.jobTitle && p.subteamPk === request.subteamPk)) {
            this.response.setStatus(app ? 400 : 404);
            return null;
        }
        return app;
    }

    private observed(record: IAutomatedEvaluation) {
        return { _id: record._id, status: record.status,
            ...(record.revision === undefined || record.revision === 0
                ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
                : { revision: record.revision }) };
    }

    async get(teamPk: string, applicationId: string, request: EvaluationRequest) {
        if (!await this.application(teamPk, applicationId, request)) return { error: "InvalidApplicationRole", message: "Application or opening not found." };
        let record = await AutomatedEvaluation.findOne(this.filter(applicationId, request)).exec();
        if (record?.status === "scored") {
            let current = false;
            let expectedKey: string | undefined;
            try {
                if (isEvaluationEnabled(this.deps)) expectedKey = (await loadScoringContext(record, this.deps.provider.modelVersion)).contextKey;
                current = expectedKey !== undefined && expectedKey === record.contextKey;
            } catch { /* An unverifiable score must not be presented as current. */ }
            if (!current) {
                await AutomatedEvaluation.updateOne(this.observed(record), {
                    $set: { status: "stale", staleAt: new Date() }, $inc: { revision: 1 },
                }).exec();
                record = await AutomatedEvaluation.findOne(this.filter(applicationId, request)).exec();
                if (record?.status === "scored" && (!expectedKey || expectedKey !== record.contextKey)) record.status = "stale";
            }
        }
        return this.publicResult(record);
    }

    async queue(teamPk: string, applicationId: string, request: EvaluationRequest, retry = false) {
        if (!isEvaluationEnabled(this.deps)) { this.response.setStatus(503); return NOT_CONFIGURED; }
        const app = await this.application(teamPk, applicationId, request);
        if (!app) return { error: "InvalidApplicationRole", message: "Application or opening not found." };
        const filter = this.filter(applicationId, request);
        let record = await AutomatedEvaluation.findOne(filter).exec();
        const identity = record || new AutomatedEvaluation({ ...filter, teamPk, applicantId: app.applicantId });
        let context;
        try { context = await loadScoringContext(identity, this.deps.provider.modelVersion); }
        catch { this.response.setStatus(409); return { error: "SnapshotOrOpeningUnavailable", message: "A valid submitted résumé snapshot and opening are required." }; }

        if (!record) {
            if (retry) { this.response.setStatus(409); return { error: "NotRetryable", message: "Only failed evaluations can be retried." }; }
            try {
                record = await AutomatedEvaluation.findOneAndUpdate(filter, { $setOnInsert: {
                    ...filter, teamPk, applicantId: app.applicantId, ...context,
                    status: "queued", attempts: 0, revision: 0, queuedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
                } }, { upsert: true, new: true, runValidators: true, timestamps: false }).exec();
            } catch (error) {
                if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
                record = await AutomatedEvaluation.findOne(filter).exec();
            }
            this.response.setStatus(202);
            return this.publicResult(record);
        }
        if (record.status === "queued" || record.status === "processing") return this.publicResult(record);
        const changed = record.contextKey !== context.contextKey;
        if (record.status === "scored" && !changed && !retry) return this.publicResult(record);
        if (retry && record.status !== "failed") {
            this.response.setStatus(409); return { error: "NotRetryable", message: "Only failed evaluations can be retried." };
        }
        if (!changed && record.attempts >= MAX_ATTEMPTS) {
            this.response.setStatus(409); return { error: "RetryLimit", message: "The evaluation reached its retry limit." };
        }
        const updated = await AutomatedEvaluation.findOneAndUpdate(this.observed(record), {
            $set: { ...context, status: "queued", attempts: changed ? 0 : record.attempts, queuedAt: new Date() },
            $unset: { failureCode: 1, failureMessage: 1, leaseToken: 1, leaseUntil: 1, overallScore: 1,
                categories: 1, explanation: 1, inferredJobFocus: 1, resumeContentHash: 1 }, $inc: { revision: 1 },
        }, { new: true, runValidators: true }).exec();
        this.response.setStatus(updated ? 202 : 409);
        return updated ? this.publicResult(updated) : { error: "EvaluationChanged", message: "The evaluation changed; refresh before retrying." };
    }

    async queueAll(teamPk: string, applicationId: string) {
        if (!isEvaluationEnabled(this.deps)) { this.response.setStatus(503); return NOT_CONFIGURED; }
        const app = await Application.findOne({ _id: applicationId, teamPk }).exec();
        if (!app) { this.response.setStatus(404); return { error: "NotFound", message: "Application not found." }; }
        const results = [];
        for (const preference of app.rolePreferences) {
            let result;
            try { result = await this.queue(teamPk, applicationId, { subteamPk: preference.subteamPk, jobTitle: preference.role }); }
            catch { result = { error: "QueueFailed", message: "The evaluation could not be queued." }; }
            results.push({ jobTitle: preference.role, subteamPk: preference.subteamPk, result });
        }
        this.response.setStatus(202);
        return { configured: true, results };
    }

    private publicResult(record: IAutomatedEvaluation | null) {
        const showScore = record?.status === "scored" || record?.status === "stale";
        return { configured: isEvaluationEnabled(this.deps), label: EVALUATION_LABEL, evaluation: record ? {
            status: record.status, jobTitle: record.jobTitle, subteamPk: record.subteamPk,
            overallScore: showScore ? record.overallScore : undefined, categories: showScore ? record.categories : undefined,
            explanation: showScore ? record.explanation : undefined, failureCode: record.failureCode, failureMessage: record.failureMessage,
        } : null };
    }
}

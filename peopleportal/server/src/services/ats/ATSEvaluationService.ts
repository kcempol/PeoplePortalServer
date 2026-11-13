import { ATSEvaluationProcessor } from "./ATSEvaluationProcessor";
import { isEvaluationEnabled, NOT_CONFIGURED, type EvaluationDependencies, MAX_ATTEMPTS } from "./ATSEvaluationTypes";
export type { EvaluationDependencies } from "./ATSEvaluationTypes";
import { Application } from "../../models/Application";
import { AutomatedEvaluation, EVALUATION_LABEL, type IAutomatedEvaluation } from "../../models/AutomatedEvaluation";
import { SubteamConfig } from "../../models/SubteamConfig";
import { contentHash, isEvaluationStale, PROMPT_VERSION, RUBRIC_VERSION, validateResumeText } from "./ATSEvaluationEngine";
import type { ATSResponse } from "./ATSHelpers";

export interface EvaluationRequest { subteamPk: string; jobTitle: string }
function roleRequirements(config: { importantRequirementsByRole?: { role: string; text: string }[] }, title: string): string {
    return config.importantRequirementsByRole?.find(item => item.role === title)?.text || "";
}

export class ATSEvaluationService {
    constructor(private readonly response: ATSResponse, private readonly deps: EvaluationDependencies = {}) { }

    private ready(): boolean {
        return isEvaluationEnabled(this.deps);
    }

    private async context(teamPk: string, applicationId: string, request: EvaluationRequest, allowArchived = false) {
        const app = await Application.findOne({ _id: applicationId, teamPk }).exec();
        if (!app) { this.response.setStatus(404); return null; }
        const preference = app.rolePreferences.find(p => p.subteamPk === request.subteamPk && p.role === request.jobTitle);
        if (!preference) { this.response.setStatus(400); return null; }
        const config = await SubteamConfig.findOne({ subteamPk: request.subteamPk }).exec();
        if ((!config || !config.roles.includes(request.jobTitle)) && !allowArchived) { this.response.setStatus(400); return null; }
        return { app, config: config || { roles: [] as string[], importantRequirementsByRole: [] }, archived: !config?.roles.includes(request.jobTitle) };
    }

    async get(teamPk: string, applicationId: string, request: EvaluationRequest) {
        const context = await this.context(teamPk, applicationId, request, true);
        if (!context) return { error: "InvalidApplicationRole", message: "The application or opening was not found." };
        const record = await AutomatedEvaluation.findOne({ applicationId, subteamPk: request.subteamPk, jobTitle: request.jobTitle }).exec();
        if (!record) return { configured: this.ready(), evaluation: null, label: EVALUATION_LABEL };
        if (record.status === "scored" && (!this.ready() || context.archived)) {
            await this.markStale(record);
        }
        let currentResumeHash: string | undefined;
        if (record.status === "scored" && this.ready()) {
            try {
                currentResumeHash = contentHash(validateResumeText(await this.deps.extractResumeText!(String(context.app._id))));
            } catch {
                await this.markStale(record);
            }
        }
        if (record.status === "scored" && isEvaluationStale(record, {
            jobTitle: request.jobTitle, importantRequirements: roleRequirements(context.config, request.jobTitle),
            modelVersion: this.deps.provider?.modelVersion || record.modelVersion,
            ...(currentResumeHash ? { resumeContentHash: currentResumeHash } : {}),
        })) {
            await this.markStale(record);
        }
        return { configured: this.ready(), label: EVALUATION_LABEL, evaluation: this.publicRecord(record) };
    }

    async queue(teamPk: string, applicationId: string, request: EvaluationRequest, retry = false) {
        if (!this.ready()) { this.response.setStatus(503); return NOT_CONFIGURED; }
        const context = await this.context(teamPk, applicationId, request);
        if (!context) return { error: "InvalidApplicationRole", message: "The application or opening was not found." };
        const filter = { applicationId, subteamPk: request.subteamPk, jobTitle: request.jobTitle };
        let record = await AutomatedEvaluation.findOne(filter).exec();
        if (record?.status === "scored") {
            // Verify source content even for a direct queue request.
            try {
                const hash = contentHash(validateResumeText(await this.deps.extractResumeText!(String(context.app._id))));
                if (record.resumeContentHash !== hash) record.status = "stale";
            } catch {
                record.status = "stale";
            }
        }
        // Existing work and unchanged scores are returned before considering retries.
        if (record && this.canReuseEvaluation(record, request.jobTitle, roleRequirements(context.config, request.jobTitle), retry)) {
            return this.evaluationResponse(record);
        }
        const retryError = this.retryError(record, retry);
        if (retryError) {
            this.response.setStatus(409);
            return retryError;
        }
        if (!record) {
            record = new AutomatedEvaluation({ ...filter, applicantId: context.app.applicantId, teamPk });
        }
        this.prepareQueuedRecord(record, roleRequirements(context.config, request.jobTitle));
        await record.save();
        this.response.setStatus(202);
        return { configured: true, label: EVALUATION_LABEL, evaluation: this.publicRecord(record) };
    }

    private canReuseEvaluation(record: IAutomatedEvaluation, jobTitle: string, requirements: string, retry: boolean): boolean {
        if (record.status === "queued" || record.status === "processing") return true;
        return record.status === "scored" && !retry && !isEvaluationStale(record, {
            jobTitle,
            importantRequirements: requirements,
            modelVersion: this.deps.provider!.modelVersion,
        });
    }

    private retryError(record: IAutomatedEvaluation | null, retry: boolean) {
        if (record?.status === "failed" && record.attempts >= MAX_ATTEMPTS) {
            return { error: "RetryLimit", message: "The evaluation reached its retry limit." };
        }
        if (retry && record?.status !== "failed") {
            return { error: "NotRetryable", message: "Only failed evaluations can be retried." };
        }
        return null;
    }

    private prepareQueuedRecord(record: IAutomatedEvaluation, requirements: string): void {
        // A failed attempt keeps its count. Fresh/stale work starts a new attempt cycle.
        if (record.status !== "failed") record.attempts = 0;
        const scoringContextChanged = (record.importantRequirements || "") !== requirements ||
            record.rubricVersion !== RUBRIC_VERSION || record.promptVersion !== PROMPT_VERSION ||
            record.modelVersion !== this.deps.provider!.modelVersion;
        if (scoringContextChanged) record.set("resumeContentHash", undefined);
        record.importantRequirements = requirements;
        record.status = "queued";
        record.rubricVersion = RUBRIC_VERSION;
        record.promptVersion = PROMPT_VERSION;
        record.modelVersion = this.deps.provider!.modelVersion;
        record.queuedAt = new Date();
        record.set("failureCode", undefined);
        record.set("failureMessage", undefined);
    }

    private evaluationResponse(record: IAutomatedEvaluation) {
        return { configured: true, label: EVALUATION_LABEL, evaluation: this.publicRecord(record) };
    }

    async queueAll(teamPk: string, applicationId: string) {
        if (!this.ready()) { this.response.setStatus(503); return NOT_CONFIGURED; }
        const app = await Application.findOne({ _id: applicationId, teamPk }).exec();
        if (!app) { this.response.setStatus(404); return { error: "NotFound", message: "Application not found." }; }
        const results = [];
        for (const preference of app.rolePreferences) {
            try {
                results.push({
                    jobTitle: preference.role, subteamPk: preference.subteamPk,
                    result: await this.queue(teamPk, applicationId, { jobTitle: preference.role, subteamPk: preference.subteamPk })
                });
            } catch {
                results.push({
                    jobTitle: preference.role, subteamPk: preference.subteamPk,
                    result: { error: "QueueFailed", message: "This evaluation could not be queued." }
                });
            }
        }
        this.response.setStatus(202);
        return { configured: true, results };
    }

    /** Compatibility entry point; background workers use ATSEvaluationProcessor directly. */
    async process(record: IAutomatedEvaluation, leaseToken?: string) {
        return new ATSEvaluationProcessor(this.deps).process(record, leaseToken);
    }

    private async markStale(record: IAutomatedEvaluation) {
        record.status = "stale";
        record.staleAt = new Date();
        await record.save();
    }

    private publicRecord(record: IAutomatedEvaluation) {
        const showScore = record.status === "scored" || record.status === "stale";
        return {
            status: record.status, jobTitle: record.jobTitle, subteamPk: record.subteamPk,
            importantRequirements: record.importantRequirements, inferredJobFocus: record.inferredJobFocus,
            overallScore: showScore ? record.overallScore : undefined,
            categories: showScore ? record.categories : undefined,
            explanation: showScore ? record.explanation : undefined,
            failureCode: record.failureCode, failureMessage: record.failureMessage,
            queuedAt: record.queuedAt, startedAt: record.startedAt, scoredAt: record.scoredAt,
            failedAt: record.failedAt, staleAt: record.staleAt, updatedAt: record.updatedAt,
        };
    }
}

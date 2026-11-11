import { Application } from "../../models/Application";
import { AutomatedEvaluation, EVALUATION_LABEL, type IAutomatedEvaluation } from "../../models/AutomatedEvaluation";
import { SubteamConfig } from "../../models/SubteamConfig";
import { contentHash, EvaluationError, isEvaluationStale, PROMPT_VERSION, RUBRIC_VERSION, scoreExtractedResume, validateResumeText, type ScoringProvider } from "./ATSEvaluationEngine";
import type { ATSResponse } from "./ATSHelpers";

export interface EvaluationRequest { subteamPk: string; jobTitle: string }
export interface EvaluationDependencies {
    provider?: ScoringProvider;
    // Injected in tests. Production extraction must be separately approved and configured.
    extractResumeText?: (applicantId: string) => Promise<string>;
    enabled?: boolean;
}

const NOT_CONFIGURED = { error: "AIScoringNotConfigured", message: "AI scoring is not configured. The club must enable server-side AI configuration." };

function roleRequirements(config: { importantRequirementsByRole?: { role: string; text: string }[] }, title: string): string {
    return config.importantRequirementsByRole?.find(item => item.role === title)?.text || "";
}

export class ATSEvaluationService {
    constructor(private readonly response: ATSResponse, private readonly deps: EvaluationDependencies = {}) {}

    private ready(): boolean {
        return this.deps.enabled === true && !!this.deps.provider && !!this.deps.extractResumeText;
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
            record.status = "stale";
            record.staleAt = new Date();
            await record.save();
        }
        let currentResumeHash: string | undefined;
        if (record.status === "scored" && this.ready()) {
            try {
                currentResumeHash = contentHash(validateResumeText(await this.deps.extractResumeText!(String(context.app.applicantId))));
            } catch {
                record.status = "stale";
                record.staleAt = new Date();
                await record.save();
            }
        }
        if (record.status === "scored" && isEvaluationStale(record, {
            jobTitle: request.jobTitle, importantRequirements: roleRequirements(context.config, request.jobTitle),
            modelVersion: this.deps.provider?.modelVersion || record.modelVersion,
            ...(currentResumeHash ? { resumeContentHash: currentResumeHash } : {}),
        })) {
            record.status = "stale";
            record.staleAt = new Date();
            await record.save();
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
                const hash = contentHash(validateResumeText(await this.deps.extractResumeText!(String(context.app.applicantId))));
                if (record.resumeContentHash !== hash) record.status = "stale";
            } catch {
                record.status = "stale";
            }
        }
        if (record && (record.status === "queued" || record.status === "processing")) return { configured: true, label: EVALUATION_LABEL, evaluation: this.publicRecord(record) };
        if (record?.status === "scored" && !retry && !isEvaluationStale(record, {
            jobTitle: request.jobTitle, importantRequirements: roleRequirements(context.config, request.jobTitle),
            modelVersion: this.deps.provider!.modelVersion,
        })) return { configured: true, label: EVALUATION_LABEL, evaluation: this.publicRecord(record) };
        if (record?.status === "failed" && record.attempts >= 3) {
            this.response.setStatus(409);
            return { error: "RetryLimit", message: "The evaluation reached its retry limit." };
        }
        if (retry && record?.status !== "failed") { this.response.setStatus(409); return { error: "NotRetryable", message: "Only failed evaluations can be retried." }; }
        if (!record) record = new AutomatedEvaluation({ ...filter, applicantId: context.app.applicantId, teamPk });
        if (record.status !== "failed") record.attempts = 0;
        const requirements = roleRequirements(context.config, request.jobTitle);
        if ((record.importantRequirements || "") !== requirements || record.rubricVersion !== RUBRIC_VERSION ||
            record.promptVersion !== PROMPT_VERSION || record.modelVersion !== this.deps.provider!.modelVersion) {
            record.set("resumeContentHash", undefined);
        }
        record.importantRequirements = requirements;
        record.status = "queued";
        record.rubricVersion = RUBRIC_VERSION;
        record.promptVersion = PROMPT_VERSION;
        record.modelVersion = this.deps.provider!.modelVersion;
        record.queuedAt = new Date();
        record.set("failureCode", undefined);
        record.set("failureMessage", undefined);
        await record.save();
        this.response.setStatus(202);
        return { configured: true, label: EVALUATION_LABEL, evaluation: this.publicRecord(record) };
    }

    async queueAll(teamPk: string, applicationId: string) {
        if (!this.ready()) { this.response.setStatus(503); return NOT_CONFIGURED; }
        const app = await Application.findOne({ _id: applicationId, teamPk }).exec();
        if (!app) { this.response.setStatus(404); return { error: "NotFound", message: "Application not found." }; }
        const results = [];
        for (const preference of app.rolePreferences) {
            try {
                results.push({ jobTitle: preference.role, subteamPk: preference.subteamPk,
                    result: await this.queue(teamPk, applicationId, { jobTitle: preference.role, subteamPk: preference.subteamPk }) });
            } catch { results.push({ jobTitle: preference.role, subteamPk: preference.subteamPk,
                result: { error: "QueueFailed", message: "This evaluation could not be queued." } }); }
        }
        this.response.setStatus(202);
        return { configured: true, results };
    }

    // Worker entry point for a future club-controlled queue. Tests inject the source and provider.
    async process(record: IAutomatedEvaluation, leaseToken?: string) {
        if (!this.ready()) throw new EvaluationError("NOT_CONFIGURED", NOT_CONFIGURED.message);
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
            const resumeText = await this.deps.extractResumeText!(String(record.applicantId));
            // Content hash prevents duplicate scoring of unchanged input for this application/job.
            const hash = contentHash(validateResumeText(resumeText));
            if (record.resumeContentHash === hash && record.overallScore !== undefined &&
                record.rubricVersion === RUBRIC_VERSION && record.modelVersion === this.deps.provider!.modelVersion &&
                record.promptVersion === PROMPT_VERSION) {
                record.status = "scored";
                await save();
                return;
            }
            const scored = await scoreExtractedResume({ resumeText, jobTitle: record.jobTitle, importantRequirements: record.importantRequirements || "" }, this.deps.provider!);
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

import { Application, type IApplication } from "../../models/Application";
import { AutomatedEvaluation } from "../../models/AutomatedEvaluation";
import { SubteamConfig } from "../../models/SubteamConfig";
import { isEvaluationEnabled, scoringEvent, type EvaluationDependencies } from "./ATSEvaluationTypes";
import { queueSubmittedApplication, type RoleConfigLookup } from "./SubmissionEvaluationQueue";

export const RECONCILIATION_INTERVAL_MS = 60_000;
export const RECONCILIATION_BATCH_SIZE = 50;

/** Scans metadata only. Missing evaluations are recovered independently of submission. */
export class EvaluationReconciliationWorker {
    private afterId: IApplication["_id"] | undefined;
    private upperId: IApplication["_id"] | undefined;
    private running = false;

    constructor(private readonly deps: EvaluationDependencies) {}

    async tick(): Promise<void> {
        if (!isEvaluationEnabled(this.deps) || this.running) return;
        this.running = true;
        try {
            if (!this.upperId) {
                const last = await Application.findOne({}).select("_id").sort({ _id: -1 }).exec();
                if (!last) return;
                this.upperId = last._id;
            }
            const applications = await Application.find({ _id: { $lte: this.upperId, ...(this.afterId ? { $gt: this.afterId } : {}) } })
                .select("_id applicantId teamPk rolePreferences")
                .sort({ _id: 1 }).limit(RECONCILIATION_BATCH_SIZE).exec();
            if (!applications.length) { this.afterId = undefined; this.upperId = undefined; return; }
            const existing = await AutomatedEvaluation.find({ applicationId: { $in: applications.map(app => app._id) } })
                .select("applicationId subteamPk jobTitle").lean().exec();
            const key = (applicationId: unknown, subteamPk: string, jobTitle: string) => JSON.stringify([String(applicationId), subteamPk, jobTitle]);
            const present = new Set(existing.map(record => key(record.applicationId, record.subteamPk, record.jobTitle)));
            const configs = new Map<string, ReturnType<RoleConfigLookup>>();
            const lookupConfig = (subteamPk: string) => {
                if (!configs.has(subteamPk)) configs.set(subteamPk, SubteamConfig.findOne({ subteamPk }).exec());
                return configs.get(subteamPk)!;
            };
            for (const application of applications) {
                for (const preference of application.rolePreferences) {
                    try {
                        if (present.has(key(application._id, preference.subteamPk, preference.role))) continue;
                        await queueSubmittedApplication({
                            _id: application._id,
                            applicantId: application.applicantId,
                            teamPk: application.teamPk,
                            rolePreferences: [preference],
                        }, this.deps, lookupConfig);
                        present.add(key(application._id, preference.subteamPk, preference.role));
                    } catch {
                        scoringEvent("reconcile_failed");
                    }
                }
                this.afterId = application._id;
            }
            // Keyset pagination bounds memory and avoids repeatedly scanning only the first batch.
            if (applications.length < RECONCILIATION_BATCH_SIZE || String(this.afterId) === String(this.upperId)) {
                this.afterId = undefined;
                this.upperId = undefined;
            }
        } finally {
            this.running = false;
        }
    }

    start(): () => Promise<void> {
        if (!isEvaluationEnabled(this.deps)) return async () => {};
        let stopped = false;
        let inFlight = Promise.resolve();
        const run = async () => {
            inFlight = this.tick().catch(() => { scoringEvent("reconcile_failed"); });
            await inFlight;
            if (!stopped) timer = setTimeout(run, RECONCILIATION_INTERVAL_MS);
        };
        let timer = setTimeout(run, 0);
        return async () => { stopped = true; clearTimeout(timer); await inFlight; };
    }
}

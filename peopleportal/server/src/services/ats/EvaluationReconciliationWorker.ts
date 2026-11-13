import { Application, type IApplication } from "../../models/Application";
import { AutomatedEvaluation } from "../../models/AutomatedEvaluation";
import { isEvaluationEnabled, type EvaluationDependencies } from "./ATSEvaluationTypes";
import { queueSubmittedApplication } from "./SubmissionEvaluationQueue";

export const RECONCILIATION_INTERVAL_MS = 60_000;
export const RECONCILIATION_BATCH_SIZE = 50;

/** Scans metadata only. Missing evaluations are recovered independently of submission. */
export class EvaluationReconciliationWorker {
    private afterId: IApplication["_id"] | undefined;
    private running = false;

    constructor(private readonly deps: EvaluationDependencies) {}

    async tick(): Promise<void> {
        if (!isEvaluationEnabled(this.deps) || this.running) return;
        this.running = true;
        try {
            const applications = await Application.find(this.afterId ? { _id: { $gt: this.afterId } } : {})
                .select("_id applicantId teamPk rolePreferences")
                .sort({ _id: 1 }).limit(RECONCILIATION_BATCH_SIZE).exec();
            for (const application of applications) {
                for (const preference of application.rolePreferences) {
                    try {
                        const existing = await AutomatedEvaluation.findOne({
                            applicationId: application._id,
                            subteamPk: preference.subteamPk,
                            jobTitle: preference.role,
                        }).select("_id").exec();
                        if (existing) continue; // Any status means the evaluation already exists.
                        await queueSubmittedApplication({
                            _id: application._id,
                            applicantId: application.applicantId,
                            teamPk: application.teamPk,
                            rolePreferences: [preference],
                        }, this.deps);
                    } catch {
                        // Continue the scan; the next full cycle revisits this title.
                    }
                }
                this.afterId = application._id;
            }
            // Keyset pagination bounds memory and avoids repeatedly scanning only the first batch.
            if (applications.length < RECONCILIATION_BATCH_SIZE) this.afterId = undefined;
        } finally {
            this.running = false;
        }
    }

    start(): () => void {
        if (!isEvaluationEnabled(this.deps)) return () => {};
        let stopped = false;
        const run = async () => {
            try { await this.tick(); } catch { /* Retry next interval; never log application data. */ }
            if (!stopped) timer = setTimeout(run, RECONCILIATION_INTERVAL_MS);
        };
        let timer = setTimeout(run, 0);
        return () => { stopped = true; clearTimeout(timer); };
    }
}

import { randomUUID } from "crypto";
import { AutomatedEvaluation, type IAutomatedEvaluation } from "../../models/AutomatedEvaluation";
import { ATSEvaluationService, type EvaluationDependencies } from "./ATSEvaluationService";

export const MAX_ATTEMPTS = 3;
export interface EvaluationQueue {
    claim(token: string, now: Date): Promise<IAutomatedEvaluation | null>;
    exhaust(now: Date): Promise<void>;
}
export const mongoEvaluationQueue: EvaluationQueue = {
    async exhaust(now) {
        await AutomatedEvaluation.updateMany({ attempts: { $gte: MAX_ATTEMPTS }, $or: [
            { status: "queued" }, { status: "processing", leaseUntil: { $lte: now } },
        ] }, { $set: { status: "failed", failedAt: now, failureCode: "RETRY_LIMIT", failureMessage: "The evaluation reached its retry limit." } }).exec();
    },
    async claim(token, now) {
        return AutomatedEvaluation.findOneAndUpdate({ $and: [
            { $or: [{ attempts: { $lt: MAX_ATTEMPTS } }, { attempts: { $exists: false } }] },
            { $or: [{ status: "queued" }, { status: "processing", leaseUntil: { $lte: now } }] },
        ] }, { $set: { status: "processing", leaseToken: token, leaseUntil: new Date(now.getTime() + 120_000) }, $inc: { attempts: 1 } },
        { new: true, sort: { queuedAt: 1 } }).exec();
    },
};
export class ATSEvaluationWorker {
    constructor(private readonly deps: EvaluationDependencies, private readonly queue: EvaluationQueue = mongoEvaluationQueue) {}
    async tick(): Promise<boolean> {
        if (!this.deps.enabled || !this.deps.provider || !this.deps.extractResumeText) return false;
        const now = new Date();
        await this.queue.exhaust(now);
        const token = randomUUID();
        const record = await this.queue.claim(token, now);
        if (!record) return false;
        await new ATSEvaluationService({ setStatus() {}, setHeader() {} }, this.deps).process(record, token);
        return true;
    }
    start(): () => void {
        if (!this.deps.enabled || !this.deps.provider || !this.deps.extractResumeText) return () => {};
        let stopped = false;
        const run = async () => {
            try { await this.tick(); } catch { /* No raw errors or résumé text in logs. Expired leases recover work. */ }
            if (!stopped) timer = setTimeout(run, 2000);
        };
        let timer = setTimeout(run, 0);
        return () => { stopped = true; clearTimeout(timer); };
    }
}

import { randomUUID } from "crypto";
import { AutomatedEvaluation, type IAutomatedEvaluation } from "../../models/AutomatedEvaluation";
import { ATSEvaluationProcessor } from "./ATSEvaluationProcessor";
import { isEvaluationEnabled, type EvaluationDependencies, MAX_ATTEMPTS, LEASE_DURATION_MS, WORKER_INTERVAL_MS } from "./ATSEvaluationTypes";
export { MAX_ATTEMPTS } from "./ATSEvaluationTypes";

export interface EvaluationQueue {
    claim(token: string, now: Date): Promise<IAutomatedEvaluation | null>;
    exhaust(now: Date): Promise<void>;
}
export const mongoEvaluationQueue: EvaluationQueue = {
    async exhaust(now) {
        await AutomatedEvaluation.updateMany({
            attempts: { $gte: MAX_ATTEMPTS }, $or: [
                { status: "queued" }, { status: "processing", leaseUntil: { $lte: now } },
            ]
        }, { $set: { status: "failed", failedAt: now, failureCode: "RETRY_LIMIT", failureMessage: "The evaluation reached its retry limit." } }).exec();
    },
    async claim(token, now) {
        return AutomatedEvaluation.findOneAndUpdate({
            $and: [
                { $or: [{ attempts: { $lt: MAX_ATTEMPTS } }, { attempts: { $exists: false } }] },
                { $or: [{ status: "queued" }, { status: "processing", leaseUntil: { $lte: now } }] },
            ]
        }, { $set: { status: "processing", leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_DURATION_MS) }, $inc: { attempts: 1 } },
            { new: true, sort: { queuedAt: 1 } }).exec();
    },
};
export class ATSEvaluationWorker {
    constructor(private readonly deps: EvaluationDependencies, private readonly queue: EvaluationQueue = mongoEvaluationQueue) { }
    async tick(): Promise<boolean> {
        if (!isEvaluationEnabled(this.deps)) return false;
        const now = new Date();
        await this.queue.exhaust(now);
        const token = randomUUID();
        const record = await this.queue.claim(token, now);
        if (!record) return false;
        await new ATSEvaluationProcessor(this.deps).process(record, token);
        return true;
    }
    start(): () => void {
        if (!isEvaluationEnabled(this.deps)) return () => { };
        let stopped = false;
        const run = async () => {
            try { await this.tick(); } catch { /* No raw errors or résumé text in logs. Expired leases recover work. */ }
            if (!stopped) timer = setTimeout(run, WORKER_INTERVAL_MS);
        };
        let timer = setTimeout(run, 0);
        return () => { stopped = true; clearTimeout(timer); };
    }
}

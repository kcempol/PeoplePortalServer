import { Schema, model } from "mongoose";
// Provision one club-approved budget document during migration. Never auto-reset.
export const ScoringBudget = model("ScoringBudget", new Schema({
    _id: String, usedUsd: { type: Number, required: true, min: 0 },
}));
export const mongoSpendLedger = {
    async reserve(usd: number, ceiling: number): Promise<boolean> {
        return !!(await ScoringBudget.findOneAndUpdate(
            { _id: "ats-scoring", usedUsd: { $lte: ceiling - usd } },
            { $inc: { usedUsd: usd } }, { new: true },
        ).exec());
    },
};

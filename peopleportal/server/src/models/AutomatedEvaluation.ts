import { Document, Schema, Types, model } from "mongoose";

export const EVALUATION_LABEL = "Experimental title-based score.";
export type EvaluationStatus = "queued" | "processing" | "scored" | "failed" | "stale";
export type CategoryKey = "skills" | "projects" | "experience" | "outcomes";

export interface EvaluationCategory {
    key: CategoryKey;
    score: number; // 0-100; the server calculates the weighted total
    explanation: string;
    evidence: string[]; // validated excerpts from the extracted resume only
}

export interface IAutomatedEvaluation extends Document {
    applicantId: Types.ObjectId;
    applicationId: Types.ObjectId;
    teamPk: string;
    subteamPk: string;
    jobTitle: string;
    importantRequirements?: string;
    inferredJobFocus?: string;
    status: EvaluationStatus;
    overallScore?: number;
    categories?: EvaluationCategory[];
    explanation?: string;
    resumeContentHash?: string;
    rubricVersion: string;
    modelVersion: string;
    promptVersion: string;
    failureCode?: string;
    failureMessage?: string; // fixed safe message; never source text or provider error
    queuedAt?: Date;
    startedAt?: Date;
    scoredAt?: Date;
    failedAt?: Date;
    staleAt?: Date;
    createdAt: Date;
    updatedAt: Date;
    leaseToken?: string;
    leaseUntil?: Date;
    attempts: number;
}

const CategorySchema = new Schema<EvaluationCategory>({
    key: { type: String, enum: ["skills", "projects", "experience", "outcomes"], required: true },
    score: { type: Number, min: 0, max: 100, required: true },
    explanation: { type: String, required: true },
    evidence: { type: [String], default: [] },
}, { _id: false });

const AutomatedEvaluationSchema = new Schema<IAutomatedEvaluation>({
    applicantId: { type: Schema.Types.ObjectId, ref: "Applicant", required: true, index: true },
    applicationId: { type: Schema.Types.ObjectId, ref: "Application", required: true },
    teamPk: { type: String, required: true },
    subteamPk: { type: String, required: true },
    jobTitle: { type: String, required: true },
    importantRequirements: { type: String, maxlength: 500 },
    inferredJobFocus: String,
    status: { type: String, enum: ["queued", "processing", "scored", "failed", "stale"], required: true },
    overallScore: { type: Number, min: 0, max: 100 },
    categories: [CategorySchema],
    explanation: String,
    resumeContentHash: String,
    rubricVersion: { type: String, required: true },
    modelVersion: { type: String, required: true },
    promptVersion: { type: String, required: true },
    failureCode: String,
    failureMessage: String,
    queuedAt: Date,
    startedAt: Date,
    scoredAt: Date,
    failedAt: Date,
    staleAt: Date,
    leaseToken: String,
    leaseUntil: Date,
    attempts: { type: Number, default: 0 },
}, { timestamps: true });

// Migration: create this collection and indexes after shared Mongo access is approved.
// Existing Application.stars and Application.notes remain human-only; do not backfill them.
AutomatedEvaluationSchema.index({ applicationId: 1, subteamPk: 1, jobTitle: 1 }, { unique: true });
AutomatedEvaluationSchema.index({ teamPk: 1, status: 1, updatedAt: -1 });
AutomatedEvaluationSchema.index({ applicantId: 1, resumeContentHash: 1 });
AutomatedEvaluationSchema.index({ status: 1, leaseUntil: 1, queuedAt: 1 });

export const AutomatedEvaluation = model<IAutomatedEvaluation>("AutomatedEvaluation", AutomatedEvaluationSchema);

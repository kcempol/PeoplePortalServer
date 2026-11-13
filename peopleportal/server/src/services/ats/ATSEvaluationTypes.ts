/** Shared scoring and extraction limits. Changes require matching boundary tests. */
export const MAX_ATTEMPTS = 3;
export const LEASE_DURATION_MS = 120_000;
export const WORKER_INTERVAL_MS = 2_000;
export const SUBMISSION_QUEUE_TIMEOUT_MS = 250;

/** Fixed operational codes only: callers must never pass source text or raw errors. */
export function scoringEvent(code: "queue_failed" | "worker_failed" | "lease_lost" | "reconcile_failed" | "queue_timeout") {
    console.warn(`[ats] ${code}`);
}
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_BYTES = 48_000;
export const MIN_TEXT_LENGTH = 80;
export const MAX_ESTIMATED_INPUT_TOKENS = 12_000;
export const MAX_PDF_PAGES = 20;
export const EXTRACTION_TIMEOUT_MS = 10_000;
export const PROVIDER_TIMEOUT_MS = 45_000;
export const CATEGORY_KEYS = ["skills", "projects", "experience", "outcomes"] as const;
export const EVALUATION_STATUSES = ["queued", "processing", "scored", "failed", "stale"] as const;
import type { ScoringProvider } from "./ATSEvaluationEngine";

export interface EvaluationDependencies {
    provider?: ScoringProvider;
    extractResumeText?: (applicantId: string) => Promise<string>;
    enabled?: boolean;
}
export type EnabledEvaluationDependencies = Required<EvaluationDependencies>;
export const NOT_CONFIGURED = {
    error: "AIScoringNotConfigured",
    message: "AI scoring is not configured. The club must enable server-side AI configuration.",
};
export function isEvaluationEnabled(deps: EvaluationDependencies): deps is EnabledEvaluationDependencies {
    return deps.enabled === true && !!deps.provider && !!deps.extractResumeText;
}

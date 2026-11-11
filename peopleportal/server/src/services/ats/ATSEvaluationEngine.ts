import { createHash } from "crypto";
import type { CategoryKey, EvaluationCategory } from "../../models/AutomatedEvaluation";

export const RUBRIC_VERSION = "title-rubric-v1";
export const PROMPT_VERSION = "resume-evidence-v2";
export const SCORING_INSTRUCTIONS = `Evaluate résumé evidence relevant to the specified job title and optional important requirements only.
Use fixed categories: relevant skills and knowledge, demonstrated projects or work, relevant or transferable experience, and contributions and outcomes.
Give each category a 0-100 score, short explanation, and up to five exact résumé excerpts. Do not calculate the overall score; the server does that.
Infer the job focus from the title and requirements. Do not use names, contact details, protected traits, school or employer prestige, or inferred personal characteristics.
Do not recommend rejecting, advancing, or hiring the applicant. This is an experimental title-based score, not a hiring decision.`;
export const CATEGORY_WEIGHTS: Record<CategoryKey, number> = {
    skills: 0.35,
    projects: 0.35,
    experience: 0.20,
    outcomes: 0.10,
};
// Preflight ceiling before any provider call. A production adapter must also
// enforce a club-set dollar cap using its selected model's current prices.
export const MAX_ESTIMATED_INPUT_TOKENS = 12_000;

export interface ScoringInput {
    resumeText: string;
    jobTitle: string;
    importantRequirements?: string;
}
export interface ProviderResult {
    inferredJobFocus: string;
    explanation: string;
    categories: EvaluationCategory[];
}
export interface ScoringProvider {
    readonly modelVersion: string;
    score(input: ScoringInput): Promise<ProviderResult>;
}

// TEST ONLY. Never selected by server configuration or a client request.
export class MockScoringProvider implements ScoringProvider {
    readonly modelVersion = "mock-test-only";
    constructor(private readonly response: ProviderResult | ((input: ScoringInput) => ProviderResult)) {}
    async score(input: ScoringInput): Promise<ProviderResult> {
        return typeof this.response === "function" ? this.response(input) : this.response;
    }
}

export class EvaluationError extends Error {
    constructor(readonly code: string, readonly safeMessage: string) { super(safeMessage); }
}

export function contentHash(text: string): string {
    return createHash("sha256").update(text.normalize("NFKC").trim()).digest("hex");
}

export function validateResumeText(text: string): string {
    if (typeof text !== "string" || !text.trim()) throw new EvaluationError("RESUME_EMPTY", "No readable résumé text was found.");
    if (Buffer.byteLength(text, "utf8") > 48_000 || Math.ceil(text.length / 4) > MAX_ESTIMATED_INPUT_TOKENS)
        throw new EvaluationError("RESUME_TOO_LARGE", "Résumé text exceeds the scoring limit.");
    if (text.trim().length < 80) throw new EvaluationError("RESUME_TOO_SHORT", "There is too little readable résumé text to score.");
    return text.normalize("NFKC").trim();
}

export function prepareResumeEvidence(text: string): string {
    const evidence = validateResumeText(text)
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[contact removed]")
        .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[contact removed]")
        .replace(/https?:\/\/\S+/gi, "[link removed]")
        .split("\n")
        .filter(line => !prohibitedContent(line))
        // Retain work evidence and skills, never identity/education/employer headers.
        .filter(line => /^\s*[-*•]?\s*(?:built|developed|implemented|designed|created|maintained|tested|improved|reduced|increased|delivered|led|contributed|automated|analyzed|skills\s*:|technologies\s*:)/i.test(line))
        .map(line => redactEntities(line.replace(/\b(?:at|for)\s+[A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*)*/g, "for an organization")))
        .join("\n");
    if (evidence.trim().length < 80) throw new EvaluationError("INSUFFICIENT_SAFE_EVIDENCE", "There is too little job-relevant evidence after privacy filtering.");
    return evidence;
}

export function prohibitedContent(text: string): boolean {
    return /[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/|\+?\d[\d ().-]{7,}\d|\b\d{1,6}\s+\w+\s+(?:street|st|road|rd|avenue|ave)\b|\b(?:name|email|phone|address|nationality|citizenship|religion|race|ethnicity|gender|pregnant|pregnancy|married|marital|disability|disabled|sexual|orientation|age|born|birthday|male|female|young|old|prestigious|prestige|elite|ivy league|university|college|school|handsome|attractive|personality|introvert|extrovert)\b/i.test(text);
}

// Conservative proper-name filter. Unknown capitalized tokens are removed even
// when that sacrifices evidence; extend technical vocabulary only after review.
const SAFE_CAPITALIZED = new Set(("Built Developed Implemented Designed Created Maintained Tested Improved Reduced Increased Delivered Led Contributed Automated Analyzed Skills Technologies Relevant Demonstrated Evidence Measured Transferable Software UI Engineer Frontend Backend Full Stack React TypeScript JavaScript Python Java Rust Go C SQL HTML CSS Node Express MongoDB PostgreSQL Docker Kubernetes AWS API APIs REST GraphQL Git Linux Figma TensorFlow PyTorch NLP ML AI CI CD Unit Integration Accessibility The This A No Limited Strong Some " ).trim().split(/\s+/));
function redactEntities(text: string): string {
    return text.replace(/\b[A-Z][\p{L}\p{N}_'-]*\b/gu, token => SAFE_CAPITALIZED.has(token) ? token : "[entity removed]");
}

export function weightedScore(categories: EvaluationCategory[]): number {
    const keys = Object.keys(CATEGORY_WEIGHTS) as CategoryKey[];
    if (categories.length !== keys.length || new Set(categories.map(c => c.key)).size !== keys.length ||
        categories.some(c => !keys.includes(c.key) || !Number.isFinite(c.score) || c.score < 0 || c.score > 100)) {
        throw new EvaluationError("INVALID_PROVIDER_RESULT", "The scoring response could not be validated.");
    }
    return Math.round(categories.reduce((total, c) => total + c.score * CATEGORY_WEIGHTS[c.key], 0));
}

export function validateProviderResult(result: ProviderResult, resumeText: string): number {
    if (!result || typeof result.explanation !== "string" || typeof result.inferredJobFocus !== "string" ||
        !Array.isArray(result.categories) || result.explanation.length > 2000 || result.inferredJobFocus.length > 200) {
        throw new EvaluationError("INVALID_PROVIDER_RESULT", "The scoring response could not be validated.");
    }
    const total = weightedScore(result.categories);
    if (prohibitedContent(result.explanation) || prohibitedContent(result.inferredJobFocus))
        throw new EvaluationError("PROHIBITED_OUTPUT", "The scoring response contains prohibited personal information.");
    for (const category of result.categories) {
        if (typeof category.explanation !== "string" || category.explanation.length > 1000 ||
            !Array.isArray(category.evidence) || category.evidence.length > 5 ||
            category.evidence.some(e => typeof e !== "string" || e.length > 300 || !resumeText.includes(e))) {
            throw new EvaluationError("INVALID_EVIDENCE", "The scoring evidence could not be validated.");
        }
        if (prohibitedContent(category.explanation) || category.evidence.some(prohibitedContent))
            throw new EvaluationError("PROHIBITED_OUTPUT", "The scoring response contains prohibited personal information.");
    }
    // Names and organization names not in the reviewed technical vocabulary
    // must not be introduced by the provider into free-form explanations.
    if ([result.inferredJobFocus, result.explanation, ...result.categories.map(c => c.explanation)].some(text => redactEntities(text) !== text))
        throw new EvaluationError("PROHIBITED_OUTPUT", "The scoring response contains unapproved identifying content.");
    return total;
}

export function isEvaluationStale(saved: { jobTitle: string; importantRequirements?: string; resumeContentHash?: string; rubricVersion: string; modelVersion: string; promptVersion: string }, current: { jobTitle: string; importantRequirements?: string; resumeContentHash?: string; modelVersion: string }): boolean {
    return saved.jobTitle !== current.jobTitle ||
        (saved.importantRequirements || "").trim() !== (current.importantRequirements || "").trim() ||
        (current.resumeContentHash !== undefined && saved.resumeContentHash !== current.resumeContentHash) ||
        saved.rubricVersion !== RUBRIC_VERSION || saved.promptVersion !== PROMPT_VERSION || saved.modelVersion !== current.modelVersion;
}

export async function scoreExtractedResume(input: ScoringInput, provider: ScoringProvider) {
    const resumeText = validateResumeText(input.resumeText);
    if (!input.jobTitle.trim()) throw new EvaluationError("JOB_TITLE_REQUIRED", "A job title is required.");
    if (input.jobTitle.length > 160 || (input.importantRequirements?.length || 0) > 500)
        throw new EvaluationError("INVALID_JOB_CONTEXT", "The job context exceeds the scoring limit.");
    if (prohibitedContent(input.jobTitle) || prohibitedContent(input.importantRequirements || ""))
        throw new EvaluationError("INVALID_JOB_CONTEXT", "The job context contains prohibited personal information.");
    const evidenceText = prepareResumeEvidence(resumeText);
    const result = await provider.score({ ...input, resumeText: evidenceText });
    return { ...result, overallScore: validateProviderResult(result, evidenceText), resumeContentHash: contentHash(resumeText) };
}

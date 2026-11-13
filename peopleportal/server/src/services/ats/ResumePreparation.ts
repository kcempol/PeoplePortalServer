import { MAX_TEXT_BYTES, MIN_TEXT_LENGTH, MAX_ESTIMATED_INPUT_TOKENS } from "./ATSEvaluationTypes";
export class EvaluationError extends Error {
    constructor(readonly code: string, readonly safeMessage: string) { super(safeMessage); }
}

export function validateResumeText(text: string): string {
    if (typeof text !== "string" || !text.trim()) throw new EvaluationError("RESUME_EMPTY", "No readable résumé text was found.");
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES || Math.ceil(text.length / 4) > MAX_ESTIMATED_INPUT_TOKENS)
        throw new EvaluationError("RESUME_TOO_LARGE", "Résumé text exceeds the scoring limit.");
    if (text.trim().length < MIN_TEXT_LENGTH) throw new EvaluationError("RESUME_TOO_SHORT", "There is too little readable résumé text to score.");
    return text.normalize("NFKC").trim();
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const LINK_PATTERN = /https?:\/\/\S+/gi;
const OUTPUT_EMAIL_PATTERN = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;
const OUTPUT_LINK_PATTERN = /https?:\/\//i;
const OUTPUT_PHONE_PATTERN = /\+?\d[\d ().-]{7,}\d/i;
const ADDITIONAL_SENSITIVE_PATTERN = /\b(?:christian|muslim|jewish|hindu|buddhist|catholic|atheist|gay|lesbian|transgender|nonbinary|autistic|adhd|bipolar|depression|veteran|democrat|republican|black|white|asian|hispanic|latino|latina)\b/i;
const INSTRUCTION_PATTERN = /\b(?:ignore|disregard|override)\b.{0,60}\b(?:instructions?|prompts?|rules?)\b|\b(?:system prompt|give every category|maximum score|score me|hire me|reveal|secret|api key)\b/i;
const ADDRESS_PATTERN = /\b\d{1,6}\s+\w+\s+(?:street|st|road|rd|avenue|ave)\b/i;
const PERSONAL_OR_PRESTIGE_PATTERN = /\b(?:name|email|phone|address|nationality|citizenship|religion|race|ethnicity|gender|pregnant|pregnancy|married|marital|disability|disabled|sexual|orientation|age|born|birthday|male|female|young|old|prestigious|prestige|elite|ivy league|university|college|school|handsome|attractive|personality|introvert|extrovert)\b/i;
const PROHIBITED_PATTERNS = [
    OUTPUT_EMAIL_PATTERN,
    OUTPUT_LINK_PATTERN,
    OUTPUT_PHONE_PATTERN,
    ADDITIONAL_SENSITIVE_PATTERN,
    INSTRUCTION_PATTERN,
    ADDRESS_PATTERN,
    PERSONAL_OR_PRESTIGE_PATTERN
];

const WORK_EVIDENCE_PATTERN = /^\s*[-*•]?\s*(?:built|developed|implemented|designed|created|maintained|tested|improved|reduced|increased|delivered|led|contributed|automated|analyzed|skills\s*:|technologies\s*:)/i;

export function prepareResumeEvidence(text: string): string {
    const lines = validateResumeText(text)
        .replace(EMAIL_PATTERN, "[contact removed]")
        .replace(PHONE_PATTERN, "[contact removed]")
        .replace(LINK_PATTERN, "[link removed]")
        .split("\n");
    const bullets: string[] = [];
    let active = false;
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || /^[A-Z\s&/]+:?$/.test(line)) { active = false; continue; }
        if (WORK_EVIDENCE_PATTERN.test(line)) { bullets.push(line); active = true; }
        else if (active && !/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}:?$/.test(line)) bullets[bullets.length - 1] += ` ${line}`;
        else active = false;
    }
    const evidence = bullets
        .filter(line => !prohibitedContent(line))
        // Retain work evidence and skills, never identity/education/employer headers.
        .filter(line => WORK_EVIDENCE_PATTERN.test(line))
        .map(line => redactEntities(line.replace(/\b(?:at|for)\s+[A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*)*/g, "for an organization"))
            .replace(/[\p{L}\p{M}][\p{L}\p{M}'-]*/gu, token => SAFE_WORDS.has(token.toLowerCase()) ? token : "[detail removed]"))
        .join("\n");
    if (evidence.replace(/\[(?:detail|entity|identity|contact|link) removed\]/g, "").trim().length < MIN_TEXT_LENGTH)
        throw new EvaluationError("INSUFFICIENT_SAFE_EVIDENCE", "There is too little job-relevant evidence after privacy filtering.");
    return evidence;
}

export function prohibitedContent(text: string): boolean {
    return PROHIBITED_PATTERNS.some(pattern => pattern.test(text));
}

// Conservative proper-name filter. Unknown capitalized tokens are removed even
// when that sacrifices evidence; extend technical vocabulary only after review.
const SAFE_CAPITALIZED = new Set([
    "Built Developed Implemented Designed Created Maintained Tested Improved Reduced Increased Delivered Led",
    "Contributed Automated Analyzed Skills Technologies Relevant Demonstrated Evidence Measured Transferable Software UI",
    "Engineer Frontend Backend Full Stack React TypeScript JavaScript Python Java Rust Go",
    "C SQL HTML CSS Node Express MongoDB PostgreSQL Docker Kubernetes AWS API",
    "APIs REST GraphQL Git Linux Figma TensorFlow PyTorch NLP ML AI CI",
    "CD Unit Integration Accessibility The This A No Limited Strong Some",
].join(" ").split(/\s+/));
// Reviewed work vocabulary; unknown names/organizations and unfamiliar technical terms are removed.
const SAFE_WORDS = new Set([...SAFE_CAPITALIZED].map(word => word.toLowerCase()).concat((
    "a an and are as at based by can data development demonstrated engineering evidence for from has in is it job knowledge " +
    "of on or relevant selected that the their this through title to using was were with work worked wrote writing " +
    "application applications software platform systems system service services product products feature features project projects " +
    "test tests testing accessibility page load time percent caching changes measured outcome outcomes contributions performance " +
    "faster rendering improved reduced increased latency users user backend frontend full stack tools database databases pipelines " +
    "deployed deployment designed built implemented developed created maintained led team teams documented repeated benchmarks " +
    "automated analyzed contributed delivered collaborated research analysis models model trained training accuracy results " +
    "customer customers requirements design api apis server servers client clients integration unit ci cd deployment security " +
    "reliability monitoring debugged fixed errors caching memory optimization optimized technical skills technologies experience " +
    "supported support useful successful scalable responsive accessible documentation code review reviewed reviews component components " +
    "no limited strong some not supporting supplied organization identity contact entity detail removed link volunteer volunteers"
).split(/\s+/)));
export function redactEntities(text: string): string {
    return text.replace(/\b[A-Z][\p{L}\p{N}_'-]*\b/gu, token => SAFE_CAPITALIZED.has(token) ? token : "[entity removed]");
}

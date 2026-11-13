import { spawn } from "child_process";
import { createHash } from "crypto";
import { EvaluationError, validateResumeText } from "./ATSEvaluationEngine";

import { MAX_RESUME_BYTES as MAX_BYTES, MAX_TEXT_BYTES, MAX_PDF_PAGES, EXTRACTION_TIMEOUT_MS } from "./ATSEvaluationTypes";
export interface ResumeObject { contentType: string; size: number; body: AsyncIterable<Uint8Array> }
export type ResumeObjectReader = (key: string) => Promise<ResumeObject>;
export type PDFParser = (bytes: Buffer) => Promise<string>;

// Poppler must be installed in the deployment image. No shell or temporary files.
export const popplerParser: PDFParser = bytes => new Promise((resolve, reject) => {
    const child = spawn("pdftotext", ["-f", "1", "-l", String(MAX_PDF_PAGES + 1), "-", "-"], { stdio: ["pipe", "pipe", "ignore"] });
    let output = Buffer.alloc(0);
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Extraction timeout")); }, EXTRACTION_TIMEOUT_MS);
    child.on("error", () => { clearTimeout(timer); reject(new Error("Extractor unavailable")); });
    child.stdin.on("error", () => { });
    child.stdout.on("data", (chunk: Buffer) => {
        output = Buffer.concat([output, chunk]);
        if (output.length > MAX_TEXT_BYTES) { child.kill("SIGKILL"); reject(new Error("Extraction limit")); }
    });
    child.on("close", code => {
        clearTimeout(timer);
        const text = output.toString("utf8");
        code === 0 && (text.match(/\f/g)?.length || 0) <= MAX_PDF_PAGES ? resolve(text) : reject(new Error("Unreadable or over-limit PDF"));
    });
    child.stdin.end(bytes);
});

export function createResumeExtractor(
    lookup: (applicationId: string) => Promise<ApplicantResume | null>,
    read: ResumeObjectReader, parse: PDFParser = popplerParser,
) {
    return async (applicantId: string): Promise<string> => {
        try {
            const applicant = await lookup(applicantId);
            validateOwnership(applicant, applicantId);
            const object = await read(applicant.key);
            validateMetadata(object);
            const bytes = await readBoundedObject(object);
            validatePdfHeader(bytes, object.size);
            if (applicant.applicantId && createHash("sha256").update(bytes).digest("hex") !== applicant.hash) {
                throw new Error("Snapshot changed");
            }
            let text = await parse(bytes);
            text = redactApplicantName(text, applicant.fullName);
            return validateResumeText(text);
        } catch { throw new EvaluationError("RESUME_UNREADABLE", "The résumé is missing, unsupported, or unreadable."); }
    };
}

async function readBoundedObject(object: ResumeObject): Promise<Buffer> {
    const chunks: Buffer[] = []; let size = 0;
    for await(const chunk of object.body) {
        size += chunk.length;
        if (size > MAX_BYTES || size > object.size) throw new Error("Object limit");
        chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    return bytes;
}

function validatePdfHeader(bytes: Buffer, expectedSize: number): void {
    if (bytes.length !== expectedSize || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new Error("Invalid PDF");
    }
}

function redactApplicantName(text: string, fullName?: string): string {
    for (const name of(fullName || "").split(/\s+/).filter(part => part.length > 1)) {
        text = text.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[identity removed]");
    }
    return text;
}

interface ApplicantResume { id: string; key: string; fullName?: string; applicantId?: string; hash?: string }
function validateOwnership(applicant: ApplicantResume | null, applicantId: string): asserts applicant is ApplicantResume {
    const expectedKey = applicant?.applicantId ? `resumes/${applicant.applicantId}/${applicantId}.pdf` : `resumes/${applicantId}.pdf`;
    if (!applicant || applicant.id !== applicantId || applicant.key !== expectedKey ||
        (applicant.applicantId && !/^[a-f0-9]{64}$/.test(applicant.hash || ""))) {
        throw new Error("Invalid ownership");
    }
}
function validateMetadata(object: ResumeObject): void {
    if (object.contentType !== "application/pdf" || !Number.isInteger(object.size) || object.size <= 0 || object.size > MAX_BYTES)
        throw new Error("Unsupported object");
}

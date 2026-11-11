import { spawn } from "child_process";
import { EvaluationError, validateResumeText } from "./ATSEvaluationEngine";

const MAX_BYTES = 10 * 1024 * 1024;
export interface ResumeObject { contentType: string; size: number; body: AsyncIterable<Uint8Array> }
export type ResumeObjectReader = (key: string) => Promise<ResumeObject>;
export type PDFParser = (bytes: Buffer) => Promise<string>;

// Poppler must be installed in the deployment image. No shell or temporary files.
export const popplerParser: PDFParser = bytes => new Promise((resolve, reject) => {
    const child = spawn("pdftotext", ["-f", "1", "-l", "21", "-", "-"], { stdio: ["pipe", "pipe", "ignore"] });
    let output = Buffer.alloc(0);
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Extraction timeout")); }, 10_000);
    child.on("error", () => { clearTimeout(timer); reject(new Error("Extractor unavailable")); });
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
        output = Buffer.concat([output, chunk]);
        if (output.length > 48_000) { child.kill("SIGKILL"); reject(new Error("Extraction limit")); }
    });
    child.on("close", code => {
        clearTimeout(timer);
        const text = output.toString("utf8");
        code === 0 && (text.match(/\f/g)?.length || 0) <= 20 ? resolve(text) : reject(new Error("Unreadable or over-limit PDF"));
    });
    child.stdin.end(bytes);
});

export function createResumeExtractor(
    lookup: (applicantId: string) => Promise<{ id: string; key: string; fullName?: string } | null>,
    read: ResumeObjectReader, parse: PDFParser = popplerParser,
) {
    return async (applicantId: string): Promise<string> => {
        try {
            const applicant = await lookup(applicantId);
            if (!applicant || applicant.id !== applicantId || applicant.key !== `resumes/${applicantId}.pdf`)
                throw new Error("Invalid ownership");
            const object = await read(applicant.key);
            if (object.contentType !== "application/pdf" || !Number.isInteger(object.size) || object.size <= 0 || object.size > MAX_BYTES)
                throw new Error("Unsupported object");
            const chunks: Buffer[] = []; let size = 0;
            for await (const chunk of object.body) {
                size += chunk.length;
                if (size > MAX_BYTES || size > object.size) throw new Error("Object limit");
                chunks.push(Buffer.from(chunk));
            }
            const bytes = Buffer.concat(chunks);
            if (size !== object.size || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Invalid PDF");
            let text = await parse(bytes);
            for (const name of (applicant.fullName || "").split(/\s+/).filter(part => part.length > 1)) {
                text = text.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[identity removed]");
            }
            return validateResumeText(text);
        } catch { throw new EvaluationError("RESUME_UNREADABLE", "The résumé is missing, unsupported, or unreadable."); }
    };
}

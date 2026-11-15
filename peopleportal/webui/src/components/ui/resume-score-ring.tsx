import { cn } from "@/lib/utils";

export type ResumeScoreStatus = "queued" | "processing" | "scored" | "failed" | "stale";

interface ResumeScoreRingProps {
    role: string;
    score?: number;
    status?: ResumeScoreStatus;
    loading?: boolean;
    error?: boolean;
}

export function ResumeScoreRing({ role, score, status, loading, error }: ResumeScoreRingProps) {
    const validScore = status === "scored" && typeof score === "number" &&
        Number.isFinite(score) && score >= 0 && score <= 100;
    const pending = loading || status === "queued" || status === "processing";
    const showScore = validScore && !error && !loading;
    const description = error ? "Score unavailable" : showScore ? `${Math.round(score)} out of 100` :
        pending ? "Scoring in progress" : status === "stale" ? "Score needs updating" :
        status === "failed" ? "Scoring failed" : "Score unavailable";

    return (
        <span
            role="img"
            aria-label={`${role} resume match: ${description}`}
            title={description}
            className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center"
        >
            <svg viewBox="0 0 40 40" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden="true">
                <circle cx="20" cy="20" r="17" fill="none" strokeWidth="3.5" className="stroke-muted-foreground/20" />
                {showScore && (
                    <circle
                        cx="20" cy="20" r="17" fill="none" stroke="currentColor" strokeWidth="3.5"
                        pathLength="100" strokeDasharray={`${score} 100`} strokeLinecap={score === 0 ? "butt" : "round"}
                        className={cn(score >= 80 ? "text-emerald-500" : score >= 50 ? "text-amber-400" : "text-red-400")}
                    />
                )}
            </svg>
            <span aria-hidden="true" className={cn("text-sm font-semibold tabular-nums", !showScore && "text-muted-foreground")}>
                {showScore ? Math.round(score) : pending && !error ? "…" : "—"}
            </span>
        </span>
    );
}

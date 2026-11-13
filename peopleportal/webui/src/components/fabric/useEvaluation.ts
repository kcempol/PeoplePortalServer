import React from "react";
import { toast } from "sonner";
import { PEOPLEPORTAL_SERVER_ENDPOINT } from "@/commons/config";

interface EvaluationResult {
    configured: boolean;
    label: string;
    evaluation: null | {
        status: "queued" | "processing" | "scored" | "failed" | "stale";
        overallScore?: number;
        explanation?: string;
        failureMessage?: string;
        categories?: { key: string; score: number; explanation: string; evidence: string[] }[];
    };
}
interface EvaluationOptions {
    teamPk: string;
    applicationId: string;
    preference: { role: string; subteamPk: string };
    refresh: number;
    onConfigured: (configured: boolean) => void;
}
export const EVALUATION_POLL_MS = 3000;
export const EVALUATION_REQUEST_TIMEOUT_MS = 10_000;

/** One abortable request at a time. Terminal results stop polling; errors remain visible and retryable. */
export function useEvaluation({ teamPk, applicationId, preference, refresh, onConfigured }: EvaluationOptions) {
    const [result, setResult] = React.useState<EvaluationResult | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [reload, setReload] = React.useState(0);
    const generation = React.useRef(0);
    const queueGeneration = React.useRef(0);
    const endpoint = evaluationEndpoint(teamPk, applicationId);

    React.useEffect(() => {
        setResult(null); setBusy(false); setError(null);
        return () => { queueGeneration.current++; };
    }, [teamPk, applicationId, preference.role, preference.subteamPk]);
    React.useEffect(() => {
        const current = ++generation.current;
        let active = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let controller: AbortController | undefined;
        let failures = 0;
        const query = new URLSearchParams({ subteamPk: preference.subteamPk, jobTitle: preference.role });
        const load = async () => {
            controller = new AbortController();
            const timeout = setTimeout(() => controller?.abort(), EVALUATION_REQUEST_TIMEOUT_MS);
            setLoading(true);
            try {
                const data = await evaluationRequest<EvaluationResult>(`${endpoint}?${query}`, "Could not load the evaluation.", { signal: controller.signal });
                if (!active || generation.current !== current) return;
                setResult(data); setError(null); onConfigured(data.configured); failures = 0;
                if (data.evaluation?.status === "queued" || data.evaluation?.status === "processing") timer = setTimeout(load, EVALUATION_POLL_MS);
            } catch {
                if (!active || generation.current !== current) return;
                setError("Could not load the evaluation. Retry to refresh its status.");
                if (++failures < 5) timer = setTimeout(load, Math.min(EVALUATION_POLL_MS * 2 ** (failures - 1), 30_000));
            } finally {
                clearTimeout(timeout);
                if (active && generation.current === current) setLoading(false);
            }
        };
        void load();
        return () => { active = false; generation.current++; clearTimeout(timer); controller?.abort(); };
    }, [endpoint, preference.role, preference.subteamPk, refresh, reload, onConfigured]);

    async function queue(retry: boolean) {
        const current = queueGeneration.current;
        setBusy(true);
        try {
            const data = await evaluationRequest<EvaluationResult>(`${endpoint}${retry ? "/retry" : ""}`, "Could not queue evaluation.", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ subteamPk: preference.subteamPk, jobTitle: preference.role }),
            });
            if (queueGeneration.current === current) { setResult(data); setReload(value => value + 1); }
        } catch (failure) {
            if (queueGeneration.current === current) toast.error(failure instanceof Error ? failure.message : "Could not queue evaluation.");
        } finally { if (queueGeneration.current === current) setBusy(false); }
    }
    return { result, loading, error, busy, queue, retryLoad: () => setReload(value => value + 1) };
}

export async function evaluationRequest<T>(url: string, fallback: string, options?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options?.signal?.aborted) abort();
    options?.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, EVALUATION_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(url, { credentials: "include", ...options, signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data?.message === "string" ? data.message : fallback);
        return data as T;
    } finally {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
    }
}
export const CATEGORY_LABELS: Record<string, string> = {
    skills: "Relevant skills and knowledge (35%)",
    projects: "Demonstrated projects or work (35%)",
    experience: "Relevant or transferable experience (20%)",
    outcomes: "Contributions and outcomes (10%)",
};
export function evaluationEndpoint(teamPk: string, applicationId: string): string {
    return `${PEOPLEPORTAL_SERVER_ENDPOINT}/api/ats/applications/${encodeURIComponent(teamPk)}/${encodeURIComponent(applicationId)}/evaluation`;
}

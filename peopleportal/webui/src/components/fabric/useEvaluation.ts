import React from "react";
import { toast } from "sonner";
import { PEOPLEPORTAL_SERVER_ENDPOINT } from "@/commons/config";

interface ExperimentalEvaluationResult {
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

/** Loads one title, polls active work, and exposes queue/retry actions to the panel. */
export function useEvaluation({ teamPk, applicationId, preference, refresh, onConfigured }: EvaluationOptions) {
    const [result, setResult] = React.useState<ExperimentalEvaluationResult | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [poll, setPoll] = React.useState(0);
    const endpoint = evaluationEndpoint(teamPk, applicationId);
    React.useEffect(() => {
        setResult(null);
    }, [applicationId]);
    React.useEffect(() => {
        let active = true;
        const query = new URLSearchParams({ subteamPk: preference.subteamPk, jobTitle: preference.role });
        evaluationRequest<ExperimentalEvaluationResult>(`${endpoint}?${query}`, "Could not load the evaluation.")
            .then(data => { if (active) { setResult(data); onConfigured(data.configured); } })
            .catch (() => { /* Preserve last status; an active job will retry on the next poll. */ });
        return () => { active = false; };
    }, [endpoint, preference.role, preference.subteamPk, refresh, onConfigured, poll]);
    React.useEffect(() => {
        if (result?.evaluation?.status !== "queued" && result?.evaluation?.status !== "processing") return;
        const timer = window.setInterval(() => setPoll(value => value + 1), EVALUATION_POLL_MS);
        return () => window.clearInterval(timer);
    }, [result?.evaluation?.status]);
    async function queue(retry: boolean) {
        setBusy(true);
        try {
            const data = await evaluationRequest<ExperimentalEvaluationResult>(`${endpoint}${retry ? "/retry" : ""}`, "Could not queue evaluation.", {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ subteamPk: preference.subteamPk, jobTitle: preference.role }),
            });
            setResult(data);
        } catch (error) { toast.error(error instanceof Error ? error.message : "Could not queue evaluation."); }
        finally { setBusy(false); }
    }
    return { result, busy, queue };
}

export const EVALUATION_POLL_MS = 3000;

export async function evaluationRequest<T>(url: string, fallback: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, { credentials: "include", ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || fallback);
    return data as T;
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

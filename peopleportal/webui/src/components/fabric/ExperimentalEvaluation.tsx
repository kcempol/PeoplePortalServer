import { useEvaluation, evaluationEndpoint, evaluationRequest, CATEGORY_LABELS } from "./useEvaluation";
import React from "react";
import { toast } from "sonner";
import { Button } from "../ui/button";

function ExperimentalRoleEvaluation({ teamPk, applicationId, preference, refresh, onConfigured }: {
    teamPk: string; applicationId: string;
    preference: { role: string; subteamPk: string };
    refresh: number; onConfigured: (configured: boolean) => void;
}) {
    const { result, busy, queue, loading, error, retryLoad } = useEvaluation({ teamPk, applicationId, preference, refresh, onConfigured });
    const evaluation = result?.evaluation;
    return <div className="rounded border p-3 space-y-3" aria-label={`Evaluation for ${preference.role}`}>
        <h5 className="font-medium">{preference.role}</h5>
        <p className="text-xs text-muted-foreground">Experimental title-based score.</p>
        {loading && !result && <p role="status">Loading evaluation…</p>}
        {error && <div role="alert"><p>{error}</p><Button size="sm" onClick={retryLoad}>Retry loading</Button></div>}
        {result && !result.configured && <p className="text-sm text-muted-foreground">AI scoring cannot run until the club enables its server-side AI configuration.</p>}
        {evaluation && <div className="space-y-2 text-sm">
            <p>Status: <strong>{evaluation.status}</strong>{evaluation.overallScore !== undefined && ` · ${evaluation.overallScore}/100`}</p>
            {evaluation.failureMessage && <p>{evaluation.failureMessage}</p>}
            {evaluation.explanation && <p>{evaluation.explanation}</p>}
            {evaluation.categories?.map(category => <div key={category.key} className="rounded bg-muted/50 p-2">
                <strong>{CATEGORY_LABELS[category.key] || category.key}: {category.score}/100</strong><p>{category.explanation}</p>
                {category.evidence.length > 0 && <ul className="list-disc pl-5">{category.evidence.map((item, i) => <li key={i}>{item}</li>)}</ul>}
            </div>)}
        </div>}
        {result?.configured && <Button size="sm" disabled={busy || evaluation?.status === "queued" || evaluation?.status === "processing"}
            onClick={() => queue(evaluation?.status === "failed")}>
            {evaluation?.status === "failed" ? "Retry evaluation" : evaluation?.status === "stale" ? "Rescore résumé" : "Score résumé"}
        </Button>}
    </div>;
}

export function ExperimentalEvaluation({ teamPk, applicationId, preferences }: {
    teamPk: string; applicationId: string;
    preferences: { role: string; subteamPk: string }[];
}) {
    const [configured, setConfigured] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [refresh, setRefresh] = React.useState(0);
    const onConfigured = React.useCallback((value: boolean) => setConfigured(value), []);
    React.useEffect(() => { setConfigured(false); }, [applicationId]);
    async function queueAll() {
        setBusy(true);
        try {
            const endpoint = evaluationEndpoint(teamPk, applicationId);
            const data = await evaluationRequest<{ results: { result: { error?: string } }[] }>(
                `${endpoint}/all`, "Could not queue evaluations.", { method: "POST" });
            if(data.results.some((item: { result: { error?: string } }) => item.result.error))
                throw new Error("Some job evaluations could not be queued. Review the individual job panels.");
            setRefresh(value => value + 1);
            toast.success("Evaluations queued for all applied job titles.");
        } catch(error) {
            setRefresh(value => value + 1);
            toast.error(error instanceof Error ? error.message : "Could not queue all evaluations.");
        } finally { setBusy(false); }
    }
    return <section className="space-y-3" aria-label="Experimental AI evaluations">
        <div><h4 className="font-medium">Experimental title-based scores.</h4>
            <p className="text-xs text-muted-foreground">When scoring is enabled, new applications are evaluated automatically for every selected job title. Use the actions below to recover missing evaluations or rescore. Scores never change application stages or human feedback.</p></div>
        {configured && <Button size="sm" disabled={busy} onClick={queueAll}>Score résumé for all applied jobs</Button>}
        {preferences.map(preference => <ExperimentalRoleEvaluation key={`${applicationId}:${preference.subteamPk}:${preference.role}`}
            teamPk={teamPk} applicationId={applicationId} preference={preference} refresh={refresh} onConfigured={onConfigured} />)}
    </section>;
}

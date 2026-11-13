import type { IApplication } from "../../models/Application";
import { AutomatedEvaluation } from "../../models/AutomatedEvaluation";
import { SubteamConfig } from "../../models/SubteamConfig";
import { PROMPT_VERSION, RUBRIC_VERSION } from "./ATSEvaluationEngine";
import { productionEvaluationDependencies } from "./ATSEvaluationSetup";
import { isEvaluationEnabled, scoringEvent, type EvaluationDependencies } from "./ATSEvaluationTypes";

/** Called only after the application transaction commits. Never extracts or scores inline. */
export async function queueSubmittedApplication(
    application: Pick<IApplication, "_id" | "applicantId" | "teamPk" | "rolePreferences">,
    deps: EvaluationDependencies = productionEvaluationDependencies(),
): Promise<void> {
    if (!isEvaluationEnabled(deps)) return;

    for (const preference of application.rolePreferences) {
        try {
            const config = await SubteamConfig.findOne({ subteamPk: preference.subteamPk }).exec();
            const requirements = config?.importantRequirementsByRole?.find(item => item.role === preference.role)?.text || "";
            // Repeated delivery cannot reset an existing score, attempt count or active lease.
            await AutomatedEvaluation.updateOne({
                applicationId: application._id,
                subteamPk: preference.subteamPk,
                jobTitle: preference.role,
            }, { $setOnInsert: {
                applicantId: application.applicantId,
                teamPk: application.teamPk,
                importantRequirements: requirements,
                status: "queued",
                attempts: 0,
                queuedAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
                rubricVersion: RUBRIC_VERSION,
                promptVersion: PROMPT_VERSION,
                modelVersion: deps.provider.modelVersion,
            } }, { upsert: true, timestamps: false }).exec();
        } catch {
            scoringEvent("queue_failed");
            // A failure for one title must not prevent the other titles or the submission.
            // Reconciliation revisits missing records; reviewers can also recover them manually.
        }
    }
}

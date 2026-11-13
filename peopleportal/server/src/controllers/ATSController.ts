import { Application, ApplicationStage } from "../models/Application";
import { SubteamConfig } from "../models/SubteamConfig";
import { TeamRecruitingStatus } from "../models/TeamRecruitingStatus";
import { Types } from "mongoose";
import { AuthentikClientError, AuthentikClientErrorType } from "../clients/AuthentikClient/models";
import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { s3Client, BUCKET_NAME } from "../clients/AWSClient/S3Client";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { validateS3FileSignature, FILE_SIGNATURES, copyS3Object, getS3ObjectSha256 } from "../utils/s3-validation";
import { scoreApplication, getScoresForApplication } from "../scoring/scoreApplication";
const MAX_RESPONSE_LENGTH = 2000;
const MAX_WHY_APPDEV_WORDS = 200;
const MIN_RESPONSE_WORDS = 10;
function isOwnResumeKey(applicantId: string, key: string): boolean {
    return key === `resumes/${applicantId}.pdf` || key.startsWith(`resumes/${applicantId}/`);
}
/**
  People Portal Server
  Copyright (C) 2026  Atheesh Thirumalairajan

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import {
    Body,
    Request,
    Controller,
    Get,
    Path,
    Post,
    Put,
    Route,
    SuccessResponse,
    Tags,
    Security,
    Query,
} from "tsoa";
import type * as express from "express";
import { AuthentikClient } from "../clients/AuthentikClient";
import type { GetGroupInfoResponse } from "../clients/AuthentikClient/models";
import { Applicant, type IApplicant, type ApplicantProfile } from "../models/Applicant";
import type { IApplication } from "../models/Application";
import { EmailClient } from "../clients/EmailClient";
import { OrgController } from "./OrgController";
import type { AuthorizedUser } from "../clients/OpenIdClient";
import { ATSApplicantService } from "../services/ats/ATSApplicantService";
import { ATSApplicationService } from "../services/ats/ATSApplicationService";
import { ATSRecruitmentService } from "../services/ats/ATSRecruitmentService";
import { ATSEvaluationService, type EvaluationRequest } from "../services/ats/ATSEvaluationService";
import { productionEvaluationDependencies } from "../services/ats/ATSEvaluationRuntime";
import type {
    ATSSubteamConfigRequest,
    ATSTeamApplicationRequest,
    ATSUpdateApplicationStageRequest,
    ATSKanbanApplicationCard,
    ATSApplicationDetails,
} from "../services/ats/ATSHelpers";

/* HTTP entry points for recruitment. Decorators describe access rules and the
 * public API; each method delegates the workflow to one of three services:
 * applicants: profiles, resume links, and submissions;
 * applications: recruiter review, feedback, and stage changes;
 * recruitment: open roles, team settings, and recruitment totals.
 * Shared validation and formatting live in ATSHelpers. */
@Route("/api/ats")
export class ATSController extends Controller {
    private readonly authentikClient: AuthentikClient;
    private readonly emailClient: EmailClient;
    private readonly orgController: OrgController;

    constructor() {
        super();
        this.authentikClient = new AuthentikClient();
        this.emailClient = new EmailClient();
        this.orgController = new OrgController();
    }

    // Services use this controller's response status and its current clients.
    private get applicants() {
        return new ATSApplicantService(this, this.authentikClient);
    }

    private get applications() {
        return new ATSApplicationService(
            this,
            this.authentikClient,
            this.emailClient,
            this.orgController,
        );
    }

    private get recruitment() {
        return new ATSRecruitmentService(this, this.authentikClient);
    }

    private get evaluations() {
        return new ATSEvaluationService(this, productionEvaluationDependencies());
    }

    @Post("applications/{teamId}/{applicationId}/evaluation/all")
    @Tags("Recruitment Actions")
    @Security("bindles", ["corp:hiringaccess"])
    @SuccessResponse(202)
    async queueAllEvaluations(@Path() teamId: string, @Path() applicationId: string) {
        return this.evaluations.queueAll(teamId, applicationId);
    }

    /** Staff-only experimental evaluation. No AI or résumé service is enabled yet. */
    @Get("applications/{teamId}/{applicationId}/evaluation")
    @Tags("Recruitment Actions")
    @Security("bindles", ["corp:hiringaccess"])
    @SuccessResponse(200)
    async getEvaluation(@Path() teamId: string, @Path() applicationId: string,
        @Query() subteamPk: string, @Query() jobTitle: string) {
        return this.evaluations.get(teamId, applicationId, { subteamPk, jobTitle });
    }

    @Post("applications/{teamId}/{applicationId}/evaluation")
    @Tags("Recruitment Actions")
    @Security("bindles", ["corp:hiringaccess"])
    @SuccessResponse(202)
    async queueEvaluation(@Path() teamId: string, @Path() applicationId: string,
        @Body() body: EvaluationRequest) {
        return this.evaluations.queue(teamId, applicationId, body);
    }

    @Post("applications/{teamId}/{applicationId}/evaluation/retry")
    @Tags("Recruitment Actions")
    @Security("bindles", ["corp:hiringaccess"])
    @SuccessResponse(202)
    async retryEvaluation(@Path() teamId: string, @Path() applicationId: string,
        @Body() body: EvaluationRequest) {
        return this.evaluations.queue(teamId, applicationId, body, true);
    }

    /**
     * Generates a presigned URL for uploading a resume to the AWS S3 bucket.
     * Checks for PDF File Type, Prevents Path Traversals and requires valid
     * Guest Authentication Token.
     *
     * @param request Express Request Object
     * @param fileName Resume File Name
     * @param contentType Resume File Content Type
     * @returns AWS S3 Upload URL, Download URL and Key
     */
    @Get("resume/upload-url")
    @Tags("Applicant Portal")
    @Security("ats_otp")
    @SuccessResponse(200)
    async getResumeUploadUrl(
        @Request() request: express.Request,
        @Query() fileName: string,
        @Query() contentType: string,
    ) {
        return this.applicants.getResumeUploadUrl(
            request,
            fileName,
            contentType,
        );
    }

    /**
     * Generates a presigned URL for downloading a resume from the AWS S3 bucket.
     * Requires valid Guest Authentication Token and intended for use by applicants
     * to view their resume and profile.
     *
     * @param request Express Request Object
     * @param key Resume Key
     * @returns AWS S3 Download URL
     */
    @Get("resume/download")
    @Tags("Applicant Portal")
    @Security("ats_otp")
    @SuccessResponse(307, "Temporary Redirect")
    async getResumeDownloadUrl(@Request() request: any, @Query() key: string) {
        return this.applicants.getResumeDownloadUrl(request, key);
    }

    /**
     * Fetches Subteam Recruitment Configuration from the external database and populates
     * subteam and parent information via Authentik API calls. To perform this action, the
     * user must either be a Team Owner (on the parent team) or, hold the `corp:hiringaccess`
     * bindle.
     *
     * @param teamId Subteam ID
     * @returns Subteam Recruitment Configuration
     */
    @Get("config/{teamId}")
    @Tags("Recruitment Configuration")
    @SuccessResponse(200)
    @Security("bindles", ["corp:hiringaccess"])
    async getSubTeamATSConfig(@Path() teamId: string) {
        return this.recruitment.getSubTeamATSConfig(teamId);
    }

    /**
     * Configure a subteam to recruit for specific roles with addtional role specific
     * questions. This endpoint automatically sets the `isRecruiting` status for a
     * subteam. To perform this action, the user must either be a Team Owner or hold
     * the `corp:hiringaccess` bindle.
     *
     * @param teamId People Portal Team ID
     * @param body Subteam Configuration Request
     * @returns Updated Subteam Recruitment Configuration
     */
    @Post("config/{teamId}")
    @Tags("Recruitment Configuration")
    @SuccessResponse(200, "Created or Updated")
    @Security("bindles", ["corp:hiringaccess"])
    async createOrUpdateSubteamConfig(
        @Path() teamId: string,
        @Body() body: ATSSubteamConfigRequest,
    ) {
        return this.recruitment.createOrUpdateSubteamConfig(teamId, body);
    }

    /**
     * Public API that fetches the list of teams that are currently recruiting
     * new candidates. Provides a list of roles and other Recruitment Info in
     * addition to the team and subteam info.
     *
     * @returns List of Teams Recruiting
     */
    @Get("openteams")
    @Tags("Applicant Portal")
    @SuccessResponse(200)
    async getAllRecruitingTeams() {
        return this.recruitment.getAllRecruitingTeams();
    }

    /**
     * Fetches the list of available application stages an applicant can
     * be in. To access this list, the user must be logged in via OIDC.
     *
     * @returns List of Application Stages
     */
    @Get("stages")
    @Tags("Recruitment Actions")
    @SuccessResponse(200)
    @Security("oidc")
    async getApplicationStages() {
        return this.applications.getApplicationStages();
    }

    /**
     * Public endpoint that provides information about the team, its subteams and
     * the roles they're recruiting for. Ideally, this endpoint is used so that the
     * applicant can view all available roles, the role specific questions to aid in
     * selecting and ranking roles.
     *
     * @param teamId Team ID for a currently recruiting team.
     * @returns Team Recuritment Info
     */
    @Get("openteams/{teamId}")
    @Tags("Applicant Portal")
    @SuccessResponse(200)
    async getTeamDetails(@Path() teamId: string) {
        return this.recruitment.getTeamDetails(teamId);
    }

    /**
     * Fetches all applications for a team in a lightweight format suitable for
     * the Kanban board. To perform this action, the user must either be a Team Owner
     * or hold the `corp:hiringaccess` bindle.
     *
     * @param teamId People Portal Team ID
     * @returns Candidate Applications List
     */
    @Get("applications/{teamId}")
    @Tags("Recruitment Actions")
    @Security("bindles", ["corp:hiringaccess"])
    @SuccessResponse(200)
    async getTeamApplications(
        @Path() teamId: string,
    ): Promise<ATSKanbanApplicationCard[]> {
        return this.applications.getTeamApplications(teamId);
    }

    /**
     * Fetches all information about an application including, preferred roles,
     * responses to role specific questions and the application stage history.
     * To perform this action, the user must either be a Team Owner or hold
     * the `corp:hiringaccess` bindle.
     *
     * `profile` is the profile as submitted with this application (falling back to
     * the applicant's current profile for older applications). `scores` holds the ATS
     * resume scores for only the roles applied for, although every resume is scored
     * against all positions.
     *
     * @param teamId People Portal Team ID
     * @param applicationId Application ID
     * @returns Full Application Details
     */
    @Get("applications/{teamId}/{applicationId}/info")
    @Tags("Recruitment Actions")
    @Security("bindles", ["corp:hiringaccess"])
    @SuccessResponse(200)
    async getApplicationDetails(@Path() teamId: string, @Path() applicationId: string): Promise<ATSApplicationDetails | { error: string, message: string }> {
        try {
            const app = await Application.findOne({ _id: applicationId, teamPk: teamId })
                .populate<{ applicantId: IApplicant }>('applicantId')
                .lean()
                .exec();

            if (!app) {
                this.setStatus(404);
                return { error: "NotFound", message: "Application not found" };
            }

            return {
                id: app._id.toString(),
                applicantId: app.applicantId._id.toString(),
                name: app.applicantId.fullName || 'Unknown Applicant',
                email: app.applicantId.email || '',
                stage: app.stage,
                rolePreferences: app.rolePreferences,
                appliedAt: app.appliedAt,
                stars: app.stars || 0,

                // Detailed fields
                profile: (app.profileSnapshot ?? app.applicantId.profile) as any,
                scores: await getScoresForApplication(app),
                responses: app.responses as any,
                stageHistory: app.stageHistory,
                ...(app.notes ? { notes: app.notes } : {}),
                ...(app.hiredRole ? { hiredRole: app.hiredRole } : {}),
                ...(app.appDevInternalPk ? { appDevInternalPk: app.appDevInternalPk } : {})
            };

        } catch (err) {
            console.error("Error fetching application details:", err);
            this.setStatus(500);
            return { error: "ServerError", message: "Failed to fetch application details" };
        }
    }

    /**
     * Updates a candidate's star rating and any notes that are added for
     * feedback. To perform this action, the user must either be a Team Owner
     * or hold the `corp:hiringaccess` bindle.
     *
     * @param teamId People Portal Team ID
     * @param applicationId Application ID
     * @param body Optional manual star rating (1-5) and feedback notes in Markdown
     */

    @Put("applications/{teamId}/{applicationId}/feedback")
    @Tags("Recruitment Actions")
    @SuccessResponse(200)
    @Security("bindles", ["corp:hiringaccess"])
    async updateApplicationFeedback(
        @Request() req: express.Request,
        @Path() teamId: string,
        @Path() applicationId: string,
        @Body() body: { stars?: number; notes?: string },
    ) {
        return this.applications.updateApplicationFeedback(
            req,
            teamId,
            applicationId,
            body,
        );
    }

    /**
     * Provides a signed AWS S3 URL (valid for 15 minutes) to the resume that was
     * submitted with an application. To obtain the resume, the user must either be
     * a team owner or hold the `corp:hiringaccess` bindle.
     *
     * The application must belong to the team in the request; otherwise a 404 is
     * returned. The resume served is the application's own copy (`resumeKey`), so
     * resumes uploaded for later applications never change what this team sees.
     * Applications created before per-application resumes existed fall back to the
     * applicant's current profile resume.
     *
     * For backwards compatibility, an **applicant ID** is also accepted in place of the
     * application ID. It resolves to that applicant's application for this team (there
     * is at most one), with the same team check.
     *
     * @param teamId People Portal Team ID
     * @param applicationId Application ID (or, for older clients, the Applicant ID)
     * @returns Signed S3 Download URL, or `resumeUrl: undefined` if no resume is on file
     */
    @Get("applications/{teamId}/{applicationId}/resume")
    @Tags("Recruitment Actions")
    @SuccessResponse(200)
    @Security("bindles", ["corp:hiringaccess"])
    async getApplicantUrls(@Path() teamId: string, @Path() applicationId: string) {
        try {
            if (!Types.ObjectId.isValid(applicationId)) {
                this.setStatus(404);
                return { error: "NotFound", message: "Application not found" };
            }

            /* Resolve by application ID first, then by applicant ID (older clients). Both are scoped to the team. */
            const application =
                await Application.findOne({ _id: applicationId, teamPk: teamId }).select('resumeKey applicantId').lean().exec() ??
                await Application.findOne({ applicantId: applicationId, teamPk: teamId }).select('resumeKey applicantId').lean().exec();

            if (!application) {
                this.setStatus(404);
                return { error: "NotFound", message: "Application not found" };
            }

            /* Per-application copy, or the profile resume for applications that predate it */
            let resumeUrl: string | undefined = application.resumeKey;
            if (!resumeUrl) {
                const applicant = await Applicant.findById(application.applicantId).exec();
                resumeUrl = applicant?.profile?.get('resumeUrl');
            }

            let resumeDownloadUrl: string | undefined;
            if (resumeUrl) {
                try {
                    // Stored values are S3 keys. Values starting with http are legacy
                    // full URLs and are returned as-is.
                    if (!resumeUrl.startsWith('http')) {
                        const command = new GetObjectCommand({
                            Bucket: BUCKET_NAME,
                            Key: resumeUrl,
                        });
                        resumeDownloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 }); // 15 mins
                    } else {
                        resumeDownloadUrl = resumeUrl;
                    }

                } catch (s3Error) {
                    console.error("Error signing S3 URL:", s3Error);
                    // Fallback or just ignore, maybe client can deal with the raw key or empty string?
                    // We'll leave it undefined if signing fails.
                }
            }

            return {
                resumeUrl: resumeDownloadUrl,
            };

        } catch (err) {
            console.error("Error fetching applicant URLs:", err);
            this.setStatus(500);
            return { error: "ServerError", message: "Failed to fetch applicant URLs" };
        }
    }

    /**
     * Updates the stage for an Application to a team. Stages are determined
     * by the ApplicationStage enum. Additionally, stage state changes are
     * permitted based on the following ruleset:
     *
     * - Applications in the **Applied** stage can only be moved to **Interview** or **Rejected**
     * - Applications in the **Interview** stage can only be moved to **Potential Hire**, **Hired**, or **Rejected**
     * - Applications in the **Potential Hire** stage can only be moved to **Hired** or **Rejected**
     * - Applications in the **Hired** stage are not movable
     * - Applications in the **Rejected** stage are not movable
     *
     * Stage changes save their history and pending follow-up work before sending email
     * or changing team membership. Additional information depends on the target stage:
     *
     * - Transitions to **Interview** need Interview Guidelines and Link for Scheduling
     * - Transitions to **Rejected** directly send an email without additional information
     * - Transitions to **Potential Hire** update the stage without sending an email
     * - Transtions to **Hired** happen based on a ruleset:
     *   - If the user is an existing App Dev member, they are automatically added to the team
     *     and an email is sent notifying them about the change.
     *
     *   - Otherwise, we generate a unique invite link, valid for 48 hours, and send them an email
     *     with onboarding instructions.
     *
     * If follow-up work fails, repeat the same stage request to resume it with the saved
     * input. Completed work is skipped; another stage is blocked until this work finishes.
     *
     * To perform this action, the user must either be a team owner or hold the `corp:hiringaccess`
     * bindle. Additionally, requests will only be allowed if the Applicant has applied to the
     * team provided in the request.
     *
     * @param req Express Request Object
     * @param teamId People Portal Team ID
     * @param applicationId Candidate Application ID
     * @param body Stage Update Payload
     * @returns Stage Update Status
     */
    @Put("applications/{teamId}/{applicationId}/stage")
    @Tags("Recruitment Actions")
    @SuccessResponse(200, "Stage updated")
    @Security("bindles", ["corp:hiringaccess"])
    async updateApplicationStage(
        @Request() req: express.Request,
        @Path() teamId: string,
        @Path() applicationId: string,
        @Body() body: ATSUpdateApplicationStageRequest,
    ) {
        return this.applications.updateApplicationStage(
            req,
            teamId,
            applicationId,
            body,
        );
    }

    /**
     * Fetches all the other teams the applicant has applied to and the
     * stage they're currently in for those teams. To access this, the
     * user needs to be a Team Owner or have the `corp:hiringaccess` bindle.
     *
     * Information about the applicant will only be available if they applied
     * to the team provided in the request; otherwise a 404 is returned.
     *
     * @param teamId People Portal Team ID
     * @param applicantId Candidate's Applicant ID
     * @returns List of Other Applications
     */
    @Get("applications/{teamId}/{applicantId}/otherapps")
    @Tags("Recruitment Actions")
    @SuccessResponse(200)
    @Security("bindles", ["corp:hiringaccess"])
    async getApplicantApplications(@Path() teamId: string, @Path() applicantId: string) {
        try {
            /* Only reveal an applicant's history to teams they applied to */
            const appliedToTeam = Types.ObjectId.isValid(applicantId) &&
                await Application.exists({ applicantId, teamPk: teamId });

            if (!appliedToTeam) {
                this.setStatus(404);
                return { error: "NotFound", message: "Applicant not found" };
            }

            const applications = await Application.find({ applicantId: applicantId })
                .lean()
                .sort({ appliedAt: -1 })
                .exec();

            const results = await Promise.all(applications.map(async (app: any) => {
                let teamName = app.teamPk;

                try {
                    const teamInfo = await this.authentikClient.getGroupInfo(app.teamPk);
                    if (teamInfo && teamInfo.attributes && teamInfo.attributes.friendlyName) {
                        teamName = teamInfo.attributes.friendlyName;
                    } else if (teamInfo && teamInfo.name) {
                        teamName = teamInfo.name;
                    }
                } catch (e) {
                    console.error(`Failed to fetch team info for ${app.teamPk}`, e);
                }

                // Enrich role preferences with subteam names
                const rolePreferencesWithNames = await Promise.all((app.rolePreferences || []).map(async (pref: any) => {
                    let subteamName = pref.subteamPk;
                    try {
                        const subteamInfo = await this.authentikClient.getGroupInfo(pref.subteamPk);
                        subteamName = subteamInfo.attributes?.friendlyName || subteamInfo.name;
                    } catch (e) {
                        console.error(`Failed to fetch subteam info for ${pref.subteamPk}`, e);
                    }
                    return { ...pref, subteamName };
                }));

                return {
                    id: app._id,
                    teamPk: app.teamPk,
                    teamName: teamName,
                    rolePreferences: rolePreferencesWithNames,
                    stage: app.stage,
                    appliedAt: app.appliedAt,
                    hiredRole: app.hiredRole
                };
            }));

            return results;

        } catch (err) {
            console.error("Error fetching applicant applications:", err);
            this.setStatus(500);
            return { error: "ServerError", message: "Failed to fetch applicant history" };
        }
    }

    /**
     * Primary Endpoint for either an internal or external user to submit their application
     * to a team that's currently recruiting. For access to this API, the user must be
     * authenticated via the Guest Authorization Layer.
     *
     * This handler performs basic request and session validation, verifies that the team exists
     * and is actively recruiting, validates the user’s selected roles and profile information,
     * checks required application questions and responses, prevents duplicate applications,
     * verifies the uploaded resume is a real PDF (before anything is written), updates or
     * creates the applicant record, sets attributes for existing internal members, and finally
     * creates a new application.
     *
     * Each application keeps what was submitted with it, independent of later applications:
     * - The resume is copied to `resumes/<applicantId>/<applicationId>.pdf` (`resumeKey`), and
     *   the SHA-256 of that copy is stored as `resumeHash`.
     * - The submitted profile is stored as `profileSnapshot`. The applicant's own profile
     *   remains a working copy that is replaced on every apply.
     *
     * After the application is created, the resume is scored in the background against
     * every scoring position (not only the roles applied for). Scores are cached by
     * `resumeHash`, so a byte-identical resume is never scored twice.
     *
     * @param body Team Application Request
     * @param request Express Request Object
     * @returns Application Submission Status
     */
    @Post("applications/apply")
    @Tags("Applicant Portal")
    @SuccessResponse(201, "Application submitted")
    @Security("ats_otp")
    async applyToTeam(
        @Body() body: ATSTeamApplicationRequest,
        @Request() request: express.Request
    ) {
        try {
            const { teamPk, rolePreferences, profile, responses } = body;

            // 1. Basic Validation
            if (!teamPk || !rolePreferences || rolePreferences.length === 0 || !profile) {
                this.setStatus(400);
                return {
                    error: "InvalidRequest",
                    message: "TeamPk, role preferences, and profile are required."
                };
            }

            const userEmail = request.session.tempsession?.user?.email;
            if (!userEmail) {
                this.setStatus(401);
                return { error: "Unauthorized", message: "User session not found. Please verify your email." };
            }

            // 2. Verify team exists and is recruiting
            const teamInfo: GetGroupInfoResponse = await this.authentikClient.getGroupInfo(teamPk);
            const teamStatus = await TeamRecruitingStatus.findOne({ teamPk }).exec();

            if (!teamStatus || !teamStatus.isRecruiting) {
                this.setStatus(403);
                return {
                    error: "RecruitmentClosed",
                    message: "This team is not currently accepting applications."
                };
            }

            // 3. Collect all available roles from recruiting subteams
            const allAvailableRoles = new Set<string>();
            const allQuestions = new Set<string>();

            for (const subteamPk of teamStatus.recruitingSubteamPks) {
                const config = await SubteamConfig.findOne({ subteamPk }).exec();
                if (config && config.isRecruiting) {
                    config.roles.forEach(role => allAvailableRoles.add(role));
                }
            }

            // 4. Validate all selected roles are available
            for (const pref of rolePreferences) {
                // Check if the subteam actually offers this role
                const subteamConfig = await SubteamConfig.findOne({ subteamPk: pref.subteamPk }).exec();
                if (!subteamConfig || !subteamConfig.isRecruiting || !subteamConfig.roles.includes(pref.role)) {
                    this.setStatus(400);
                    return {
                        error: "InvalidRole",
                        message: `Role '${pref.role}' is not available in the specified subteam`
                    };
                }
            }

            // 5. Collect role-specific questions for selected roles
            for (const subteamPk of teamStatus.recruitingSubteamPks) {
                const config = await SubteamConfig.findOne({ subteamPk }).exec();
                if (config && config.isRecruiting) {
                    if (config && config.isRecruiting) {
                        for (const pref of rolePreferences) {
                            if (pref.subteamPk === subteamPk) { // Only check if this preference belongs to this subteam
                                if (config.roles.includes(pref.role)) {
                                    const roleQuestions = config.roleSpecificQuestions[pref.role] || [];
                                    roleQuestions.forEach((q: string) => allQuestions.add(q));
                                }
                            }
                        }
                    }
                }
            }

            // 6. Validate personal profile
            if (!profile.resumeUrl || profile.resumeUrl.trim() === '') {
                this.setStatus(400);
                return { error: "MissingRequiredField", message: "Resume URL is required" };
            }

            if (!profile.resumeUrl.toLowerCase().endsWith('.pdf')) {
                this.setStatus(400);
                return { error: "InvalidFileType", message: "Only PDF resumes are accepted" };
            }

            if (!profile.whyAppDev || profile.whyAppDev.trim() === '') {
                this.setStatus(400);
                return { error: "MissingRequiredField", message: "Please provide 'Why App Dev'" };
            }

            if (!profile.instagramFollow || profile.instagramFollow.trim() === '') {
                this.setStatus(400);
                return { error: "MissingRequiredField", message: "Please confirm Instagram follow" };
            }

            if (profile.linkedinUrl && profile.linkedinUrl.trim() !== "") {
                try { new URL(profile.linkedinUrl) } catch {
                    this.setStatus(400);
                    return { error: "InvalidURL", message: "Please provide a valid LinkedIn URL" };
                }
            }

            if (profile.githubUrl && profile.githubUrl.trim() !== "") {
                try { new URL(profile.githubUrl) } catch {
                    this.setStatus(400);
                    return { error: "InvalidURL", message: "Please provide a valid GitHub URL" };
                }
            }

            const whyAppDevWords = profile.whyAppDev.trim().split(/\s+/).filter(Boolean).length;
            if (whyAppDevWords > MAX_WHY_APPDEV_WORDS) {
                this.setStatus(400);
                return {
                    error: "WordCountExceeded",
                    message: `'Why App Dev' must be ${MAX_WHY_APPDEV_WORDS} words or less`
                };
            }

            // 7. Validate responses - Team question
            const teamName = teamInfo.attributes.friendlyName || teamInfo.name;
            const teamQuestionKey = `Why are you interested in ${teamName}?`;
            allQuestions.add(teamQuestionKey);

            for (const question of Array.from(allQuestions)) {
                if (!responses[question] || responses[question].trim() === '') {
                    this.setStatus(400);
                    return {
                        error: "MissingResponse",
                        message: `Please answer: ${question}`
                    };
                }

                if (responses[question].length > MAX_RESPONSE_LENGTH) {
                    this.setStatus(400);
                    return {
                        error: "ResponseTooLong",
                        message: `Response too long for: ${question}. Maximum ${MAX_RESPONSE_LENGTH} characters.`
                    };
                }

                const wordCount = responses[question].trim().split(/\s+/).filter(Boolean).length;
                if (wordCount < MIN_RESPONSE_WORDS) {
                    this.setStatus(400);
                    return {
                        error: "ResponseTooShort",
                        message: `Response too short for: ${question}. Please provide at least ${MIN_RESPONSE_WORDS} words.`
                    };
                }
            }

            // 8. Check for duplicate application
            const applicant = await Applicant.findOne({ email: userEmail }).exec();

            if (applicant) {
                const existingApp = await Application.findOne({
                    applicantId: applicant._id,
                    teamPk: teamPk
                }).exec();

                if (existingApp) {
                    this.setStatus(409);
                    return {
                        error: "DuplicateApplication",
                        message: "You have already applied to this team."
                    };
                }
            }

            // 8.1 The resume must be the applicant's own upload. Without this, an
            //     applicant could submit another applicant's S3 key: it would be
            //     copied into their application (and deleted if not a valid PDF).
            if (!applicant) {
                /* Created at OTP verification and required to upload a resume */
                this.setStatus(404);
                return { error: "ApplicantNotFound", message: "Applicant not found" };
            }

            if (!isOwnResumeKey(applicant._id.toString(), profile.resumeUrl)) {
                this.setStatus(403);
                return { error: "InvalidResume", message: "The resume must be one you uploaded." };
            }

            // 9. Validate Resume Signature (before any writes, so an invalid
            //    file can never overwrite the applicant's stored profile)
            try {
                const isValidSignature = await validateS3FileSignature(profile.resumeUrl, [FILE_SIGNATURES.PDF]);
                if (!isValidSignature) {
                    // Delete invalid file
                    await s3Client.send(new DeleteObjectCommand({
                        Bucket: BUCKET_NAME,
                        Key: profile.resumeUrl
                    })).catch(e => console.error("Failed to delete invalid resume", e));

                    this.setStatus(400);
                    return { error: "InvalidFileSignature", message: "The uploaded file is not a valid PDF." };
                }
            } catch (e) {
                console.error("Failed to validate resume", e);
                this.setStatus(500);
                return { error: "FileProcessingError", message: "Failed to process resume file." };
            }

            // 9.0.1 Give this application its own copy of the resume. The applicant's
            //       working resume (profile.resumeUrl) is overwritten on every upload,
            //       so reviewers read this per-application copy instead. The hash of
            //       the copy is the ResumeScore cache key.
            const applicationId = new Types.ObjectId();
            const resumeKey = `resumes/${applicant._id}/${applicationId}.pdf`;
            let resumeHash: string;
            try {
                await copyS3Object(profile.resumeUrl, resumeKey);
                resumeHash = await getS3ObjectSha256(resumeKey);
            } catch (e) {
                console.error("Failed to copy or hash resume", e);
                this.setStatus(500);
                return { error: "FileProcessingError", message: "Failed to process resume file." };
            }

            // 9.1 Create/update applicant
            const updatedApplicant = await Applicant.findOneAndUpdate(
                { email: userEmail },
                {
                    $set: {
                        email: userEmail,
                        fullName: request.session.tempsession?.user?.name || userEmail.split('@')[0],
                        profile: new Map(Object.entries(profile)),
                        updatedAt: new Date()
                    }
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            ).exec();

            // 9.5 Check Previous App Dev History, if exists!
            let appDevInternalPk = null;
            try {
                const internalUser = await this.authentikClient.getUserInfoFromEmail(userEmail)
                appDevInternalPk = internalUser.pk
            } catch (_e) {
                /* Not previously in App Dev */
            }

            // 10. Create application with ordered role preferences, its own resume
            //     copy and a snapshot of the profile as submitted
            let application: IApplication;
            try {
                application = await Application.create({
                    _id: applicationId,
                    applicantId: updatedApplicant._id,
                    teamPk: teamPk,
                    rolePreferences: rolePreferences,  // Ordered array of roles
                    stage: ApplicationStage.APPLIED,
                    responses: new Map(Object.entries(responses)),
                    appliedAt: new Date(),
                    appDevInternalPk,
                    resumeKey,
                    resumeHash,
                    profileSnapshot: new Map(Object.entries(profile)),
                    stageHistory: [{
                        stage: ApplicationStage.APPLIED,
                        changedAt: new Date()
                    }]
                });
            } catch (e) {
                /* Don't leave an orphaned resume copy behind */
                await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: resumeKey }))
                    .catch(err => console.error("Failed to delete orphaned resume copy", err));
                throw e;
            }

            await Applicant.findByIdAndUpdate(
                updatedApplicant._id,
                { $push: { applicationIds: application._id } }
            ).exec();

            // 11. Score the resume against all positions in the background. Not
            //     awaited: scoring never delays or fails the submission, and
            //     resumes already scored (same hash) are skipped.
            scoreApplication(application).catch(e => console.error("Background resume scoring failed", e));

            return {
                message: "Application submitted successfully",
                id: application._id
            };

        } catch (err) {
            console.error("Application submission error:", err);
            this.setStatus(500);
            return {
                error: "ServerError",
                message: "Failed to submit application"
            };
        }
    }

    /**
     * Updates the applicant's recruitment profile with common questions and
     * other updates like their Resume. To access this API, a token from the
     * Guest Authentication Layer is needed.
     *
     * @param body Applicant Profile Payload
     * @param request Express Request Object
     * @returns Profile Update Status
     */
    @Post("profile")
    @Tags("Applicant Portal")
    @SuccessResponse(200, "Profile Updated")
    @Security("ats_otp")
    async updateProfile(@Body() body: ApplicantProfile, @Request() request: express.Request) {
        try {
            const userEmail = request.session?.tempsession?.user?.email
            if (!userEmail) {
                this.setStatus(401);
                return { error: "Unauthorized", message: "User session not found." };
            }

            const applicant = await Applicant.findOne({ email: userEmail });
            if (!applicant) {
                this.setStatus(404);
                return { error: "NotFound", message: "Applicant not found." };
            }

            // Merge existing profile with new updates
            const currentProfile = applicant.profile ? Object.fromEntries(applicant.profile) : {};

            // Immediate Signature Validation for new Resume Uploads
            if (body.resumeUrl && body.resumeUrl !== currentProfile.resumeUrl) {
                // A new resume must be the applicant's own upload (see isOwnResumeKey)
                if (!isOwnResumeKey(applicant._id.toString(), body.resumeUrl)) {
                    this.setStatus(403);
                    return { error: "InvalidResume", message: "The resume must be one you uploaded." };
                }

                const isValid = await validateS3FileSignature(body.resumeUrl, [FILE_SIGNATURES.PDF]);
                if (!isValid) {
                    // Cleanup invalid file
                    await s3Client.send(new DeleteObjectCommand({
                        Bucket: BUCKET_NAME,
                        Key: body.resumeUrl
                    })).catch(e => console.error("Failed to delete invalid resume", e));

                    this.setStatus(400);
                    return { error: "InvalidFileSignature", message: "The uploaded file is not a valid PDF." };
                }
            }

            const updatedProfile = { ...currentProfile, ...body };

            await Applicant.findOneAndUpdate(
                { email: userEmail },
                {
                    $set: {
                        profile: updatedProfile,
                        updatedAt: new Date()
                    }
                }
            );

            return { message: "Profile updated successfully" };

        } catch (err) {
            console.error("Error updating profile:", err);
            this.setStatus(500);
            return { error: "ServerError", message: "Failed to update profile" };
        }
    }

    /* Compatibility methods for existing callers; workflows stay in the services.
     * These methods have no HTTP route decorator and are not additional endpoints. */
    async processHiredStageTransition(
        authorizedUser: AuthorizedUser,
        teamInfo: GetGroupInfoResponse,
        application: IApplication,
        applicant: IApplicant,
    ): Promise<void> {
        return this.applications.processHiredStageTransition(
            authorizedUser,
            teamInfo,
            application,
            applicant,
        );
    }

    async addSubteamToRecruiting(
        @Path() teamId: string,
        @Path() subteamId: string,
    ) {
        return this.recruitment.addSubteamToRecruiting(teamId, subteamId);
    }

    async removeSubteamFromRecruiting(
        @Path() teamId: string,
        @Path() subteamId: string,
    ) {
        return this.recruitment.removeSubteamFromRecruiting(teamId, subteamId);
    }

    /**
     * Per-team recruitment totals for the executive console, one row per active
     * team with a count for each application stage.
     *
     * Teams come from the groups list, which excludes archived ones, so a team
     * that has been archived drops off this page rather than lingering with a
     * frozen count. Teams that have never received an application are still
     * listed, with zeroes, because "nobody applied" is the thing an executive
     * most wants to see.
     *
     * Counts are aggregated in one grouped query rather than a count per team
     * per stage, which would be teams x stages round trips.
     *
     * @returns One row per active team, plus the stage keys used
     */
    @Get("teamstats")
    @Tags("Recruitment Actions")
    @SuccessResponse(200)
    @Security("executive")
    async getTeamRecruitmentStats() {
        return this.recruitment.getTeamRecruitmentStats();
    }
}

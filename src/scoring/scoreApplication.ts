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

import { ResumeScore } from "../models/ResumeScore";
import { ALL_SCORED_POSITIONS, normalizePosition } from "./positions";
import { getResumeScorer } from "./ResumeScorer";

/** Minimal application shape needed for scoring */
interface ScorableApplication {
    resumeKey?: string;
    resumeHash?: string;
    rolePreferences: { role: string, subteamPk: string }[];
}

/** One applied-for role and the resume's score for it */
export interface ApplicationRoleScore {
    /** Role title as applied for */
    role: string;
    /** Canonical position the role maps to (`Default` if not on the list) */
    position: string;
    /**
     * Score from 0 to 100. Absent while `pending`.
     * @minimum 0
     * @maximum 100
     */
    score?: number;
    /** Optional per-criterion sub-scores */
    breakdown?: Record<string, number>;
    /** Version of the scorer that produced the score */
    scoringVersion: string;
    /** True if this resume has not been scored for this position yet */
    pending: boolean;
}

const MONGO_DUPLICATE_KEY = 11000;

/** A score must be a finite number from 0 to 100 */
function isValidScore(score: unknown): score is number {
    return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100;
}

/** Keeps only finite numeric sub-scores; returns undefined if none remain */
function sanitizeBreakdown(breakdown: unknown): Record<string, number> | undefined {
    if (!breakdown || typeof breakdown !== "object" || Array.isArray(breakdown)) return undefined;
    const entries = Object.entries(breakdown as Record<string, unknown>)
        .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]));
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Scores an application's resume against EVERY position in
 * `ALL_SCORED_POSITIONS`, regardless of which roles were applied for.
 *
 * Scores are cached by `(resumeHash, position, scoringVersion)`: positions
 * that already have a score for this resume content are skipped, so a
 * byte-identical resume submitted with another application never reaches the
 * scorer again. Concurrent runs for the same resume are safe: the unique index
 * rejects the second insert, which is treated as "already scored".
 *
 * Never throws; failures are logged so a scoring problem cannot fail an apply.
 */
export async function scoreApplication(app: ScorableApplication): Promise<void> {
    const { resumeKey, resumeHash } = app;
    if (!resumeKey || !resumeHash) {
        console.warn("scoreApplication: application has no resumeKey/resumeHash, skipping");
        return;
    }

    const scorer = getResumeScorer();
    let alreadyScored: Set<string>;
    try {
        const positions = await ResumeScore.distinct("position", {
            resumeHash,
            scoringVersion: scorer.version
        }).exec();
        alreadyScored = new Set(positions as string[]);
    } catch (e) {
        console.error("scoreApplication: failed to read existing scores", e);
        return;
    }

    /* Sequential on purpose: a real scorer may be rate limited or expensive */
    for (const position of ALL_SCORED_POSITIONS) {
        if (alreadyScored.has(position)) continue;

        try {
            const result = await scorer.score({ resumeKey, resumeHash, position });

            /* Never cache an invalid result: a stored record counts as "scored"
               and would never be retried */
            if (!isValidScore(result?.score)) {
                console.error(`scoreApplication: scorer ${scorer.version} returned invalid score for "${position}"`, result?.score);
                continue;
            }

            const breakdown = sanitizeBreakdown(result.breakdown);
            await ResumeScore.findOneAndUpdate(
                { resumeHash, position, scoringVersion: scorer.version },
                {
                    $setOnInsert: {
                        resumeHash,
                        position,
                        scoringVersion: scorer.version,
                        score: result.score,
                        breakdown,
                        scoredAt: new Date()
                    }
                },
                { upsert: true, runValidators: true }
            ).exec();
        } catch (e: any) {
            if (e?.code === MONGO_DUPLICATE_KEY) continue; /* Scored concurrently by another run */
            console.error(`scoreApplication: failed to score position "${position}"`, e);
        }
    }
}

/**
 * Returns the resume's scores for only the roles the applicant applied for,
 * one entry per role preference, in preference order. Roles that do not map
 * onto a canonical position get the `Default` score. Roles whose score has
 * not been written yet are returned with `pending: true`.
 *
 * Applications without a `resumeHash` (created before per-application
 * resumes existed) have no scores, so an empty array is returned.
 */
export async function getScoresForApplication(app: ScorableApplication): Promise<ApplicationRoleScore[]> {
    if (!app.resumeHash) return [];

    const scoringVersion = getResumeScorer().version;
    const roles = (app.rolePreferences || []).map(pref => ({
        role: pref.role,
        position: normalizePosition(pref.role)
    }));

    const positions = Array.from(new Set(roles.map(r => r.position)));
    const scores = await ResumeScore.find({
        resumeHash: app.resumeHash,
        scoringVersion,
        position: { $in: positions }
    }).lean().exec();

    const byPosition = new Map(scores.map(s => [s.position, s]));
    return roles.map(({ role, position }) => {
        const found = byPosition.get(position);
        return {
            role,
            position,
            scoringVersion,
            pending: !found,
            ...(found ? { score: found.score } : {}),
            ...(found?.breakdown ? { breakdown: found.breakdown } : {})
        };
    });
}

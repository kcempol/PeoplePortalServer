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

export interface ResumeScoreInput {
    /** S3 key of the resume to score (an application's `resumeKey`) */
    resumeKey: string;
    /** SHA-256 of the resume bytes */
    resumeHash: string;
    /** Canonical position to score against (see `src/scoring/positions.ts`) */
    position: string;
}

export interface ResumeScoreResult {
    /** Score from 0 to 100 */
    score: number;
    /** Optional per-criterion sub-scores, e.g. `{ skills: 80, experience: 65 }` */
    breakdown?: Record<string, number>;
}

/**
 * Pluggable resume scorer.
 *
 * To plug in a real implementation, implement this interface and register it
 * with `setResumeScorer` at startup. Give it a NEW `version`: the version is
 * part of the `ResumeScore` cache key, so changing it makes every resume get
 * re-scored by the new implementation instead of reusing stale results.
 */
export interface ResumeScorer {
    readonly version: string;
    score(input: ResumeScoreInput): Promise<ResumeScoreResult>;
}

/**
 * Placeholder scorer used until real scoring logic exists. Always returns a
 * score of 0, so its results are easy to recognise (and discard) by
 * `scoringVersion = "stub-v1"`.
 */
export class StubResumeScorer implements ResumeScorer {
    readonly version = "stub-v1";

    async score(_input: ResumeScoreInput): Promise<ResumeScoreResult> {
        return { score: 0 };
    }
}

let activeScorer: ResumeScorer = new StubResumeScorer();

/** The scorer currently used for new scores */
export function getResumeScorer(): ResumeScorer {
    return activeScorer;
}

/** Replaces the active scorer (call once at startup, or in tests) */
export function setResumeScorer(scorer: ResumeScorer): void {
    activeScorer = scorer;
}

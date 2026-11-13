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

import { Document, Schema, model } from "mongoose";

/**
 * ATS score for one resume against one scoring position.
 *
 * Scores are keyed by resume CONTENT (`resumeHash`, the SHA-256 of the PDF
 * bytes), not by application or S3 path. Every resume is scored against all
 * positions (see `src/scoring/positions.ts`), so a byte-identical resume
 * submitted with several applications reuses the same records and is never
 * scored twice. Reviewers are only shown the positions matching the roles
 * an applicant actually applied for.
 *
 * `scoringVersion` is part of the key: changing the scorer (bumping its
 * `version`) makes old records stop matching, so resumes are re-scored.
 */
export interface IResumeScore extends Document {
  resumeHash: string;
  position: string;
  scoringVersion: string;
  score: number;
  breakdown?: Record<string, number>;
  scoredAt: Date;
}

const ResumeScoreSchema = new Schema<IResumeScore>({
  resumeHash: { type: String, required: true },
  position: { type: String, required: true },
  scoringVersion: { type: String, required: true },
  score: { type: Number, required: true, min: 0, max: 100 },
  breakdown: { type: Schema.Types.Mixed, required: false },
  scoredAt: { type: Date, default: Date.now, required: true }
}, { timestamps: true });

/* One score per resume content, position and scorer version */
ResumeScoreSchema.index({ resumeHash: 1, position: 1, scoringVersion: 1 }, { unique: true });

export const ResumeScore = model<IResumeScore>('ResumeScore', ResumeScoreSchema);

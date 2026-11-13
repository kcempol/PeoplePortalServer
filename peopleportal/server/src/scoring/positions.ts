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

/**
 * Canonical positions every resume is scored against. Subteams define their
 * roles as free text (`SubteamConfig.roles`), so applied-for roles are mapped
 * onto this list with `normalizePosition`.
 */
export const SCORING_POSITIONS = [
    "Product Manager",
    "Software Engineer",
    "Frontend Engineer",
    "Backend Engineer",
    "Machine Learning Engineer",
    "Fullstack Engineer",
    "DevOps Engineer",
    "Quantum Researcher",
    "UI/UX Engineer",
] as const;

/** Fallback position for roles that do not map onto `SCORING_POSITIONS` */
export const DEFAULT_POSITION = "Default";

/** Every position a resume is scored against: the canonical list plus Default */
export const ALL_SCORED_POSITIONS: readonly string[] = [...SCORING_POSITIONS, DEFAULT_POSITION];

/** Lowercases and strips everything but letters and digits: "Full-Stack Engineer" -> "fullstackengineer" */
const normalizeKey = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Extra spellings that map onto a canonical position. Keys are written
 * human-readable and normalized at load time, so add entries freely.
 */
const POSITION_ALIASES: Record<string, (typeof SCORING_POSITIONS)[number]> = {
    "PM": "Product Manager",
    "Product Management": "Product Manager",

    "SWE": "Software Engineer",
    "Software Developer": "Software Engineer",
    "Software Engineering": "Software Engineer",

    "Frontend": "Frontend Engineer",
    "Frontend Developer": "Frontend Engineer",

    "Backend": "Backend Engineer",
    "Backend Developer": "Backend Engineer",

    "ML Engineer": "Machine Learning Engineer",
    "Machine Learning": "Machine Learning Engineer",

    "Full Stack Engineer": "Fullstack Engineer",
    "Full Stack Developer": "Fullstack Engineer",
    "Fullstack": "Fullstack Engineer",

    "DevOps": "DevOps Engineer",

    "Quantum": "Quantum Researcher",

    "UI/UX": "UI/UX Engineer",
    "UI/UX Designer": "UI/UX Engineer",
    "UX Designer": "UI/UX Engineer",
    "UI Designer": "UI/UX Engineer",
};

const POSITION_LOOKUP: ReadonlyMap<string, string> = new Map<string, string>([
    ...SCORING_POSITIONS.map((p): [string, string] => [normalizeKey(p), p]),
    ...Object.entries(POSITION_ALIASES).map(([alias, p]): [string, string] => [normalizeKey(alias), p]),
]);

/**
 * Maps a free-text role title onto a canonical scoring position. Matching is
 * case- and punctuation-insensitive ("full-stack engineer" and "Full Stack
 * Engineer" both match "Fullstack Engineer"). Roles that match neither a
 * canonical name nor an alias return `DEFAULT_POSITION`.
 *
 * @param role Role title as configured on a subteam
 * @returns Canonical position name, or `DEFAULT_POSITION`
 */
export function normalizePosition(role: string): string {
    return POSITION_LOOKUP.get(normalizeKey(role ?? "")) ?? DEFAULT_POSITION;
}

# ATS Data Model

How the Applicant Tracking System (ATS) stores recruiting configuration, applicants,
applications and resume scores in MongoDB, and how resumes in S3 are linked to them.

> In this codebase a "team" is an Authentik group (`teamPk`) and a "subteam" is a child
> group (`subteamPk`). Names, descriptions and hierarchy live in Authentik; MongoDB only
> stores the IDs.

## Collections

```
TeamRecruitingStatus (teamPk) ──recruitingSubteamPks──► SubteamConfig (subteamPk)
                                                              ▲
Applicant ◄──applicantId── Application (teamPk) ──rolePreferences[].subteamPk
   └──applicationIds─────────►┘      │
                                     └──resumeHash──► ResumeScore (resumeHash, position, scoringVersion)
```

| Collection | Model file | One document per | Purpose |
|---|---|---|---|
| `SubteamConfig` | `src/models/SubteamConfig.ts` | subteam | Recruiting flag, free-text `roles`, role-specific questions |
| `TeamRecruitingStatus` | `src/models/TeamRecruitingStatus.ts` | parent team | Which subteams are recruiting; maintained automatically when a `SubteamConfig` is saved |
| `Applicant` | `src/models/Applicant.ts` | person (unique email) | Identity plus a **working copy** profile, replaced on every apply |
| `Application` | `src/models/Application.ts` | applicant + team (unique) | Ranked role preferences, answers, stage, reviewer stars/notes, and **what was submitted** |
| `ResumeScore` | `src/models/ResumeScore.ts` | resume content + position + scorer version | Cached ATS score |

## Per-application resumes and profile snapshots

The applicant's working resume lives at the fixed S3 key `resumes/<applicantId>.pdf`
(`Applicant.profile.resumeUrl`, which holds an S3 **key**, not a URL). Every upload
overwrites it, and every apply replaces `Applicant.profile`. To make sure reviewers see
what was actually submitted to *their* team, each application stores its own copy:

| `Application` field | Contents |
|---|---|
| `resumeKey` | `resumes/<applicantId>/<applicationId>.pdf`, copied from the working resume at apply time |
| `resumeHash` | SHA-256 (hex) of the bytes at `resumeKey`; the `ResumeScore` cache key |
| `profileSnapshot` | The profile (`resumeUrl`, `whyAppDev`, `instagramFollow`, links) as submitted |

All three are optional. Applications created before these fields existed fall back to the
applicant's current profile and working resume, and have no scores.

### Apply flow (`POST /api/ats/applications/apply`)

1. Validate team, roles, profile and answers (unchanged).
2. Reject duplicates (one application per applicant per team).
3. Verify the uploaded resume is a real PDF (file signature) **before any writes**, so an
   invalid file can never overwrite the stored profile.
4. Copy the resume to `resumes/<applicantId>/<applicationId>.pdf` and hash the copy.
   If this fails, nothing is written.
5. Upsert the applicant (working copy profile replaced, as before).
6. Create the application with `resumeKey`, `resumeHash` and `profileSnapshot`. If this
   fails, the resume copy is deleted.
7. Start scoring in the background (not awaited; never fails the submission).

## Resume scoring

### Positions

Every resume is scored against **all** positions in `src/scoring/positions.ts`, regardless
of which roles were applied for:

Product Manager, Software Engineer, Frontend Engineer, Backend Engineer, Machine Learning
Engineer, Fullstack Engineer, DevOps Engineer, Quantum Researcher, UI/UX Engineer, plus
**Default**.

Subteam roles are free text, so `normalizePosition(role)` maps them onto this list:
case- and punctuation-insensitive matching ("full-stack engineer" → Fullstack Engineer),
plus an alias table (`SWE`, `ML Engineer`, `UI/UX Designer`, ...). Anything else maps to
**Default**. Add aliases in `POSITION_ALIASES`.

### Caching

`ResumeScore` has a unique index on `{ resumeHash, position, scoringVersion }`:

- Scores are keyed by **resume content**, not by application or S3 path. A byte-identical
  resume submitted with several applications is scored once and the records are shared.
- Re-exported files (same document, different bytes) hash differently and are re-scored.
- Concurrent submissions of the same resume can each run the scorer, but only one
  record per position is stored (the duplicate insert is ignored).
- `scoringVersion` is part of the key, so changing the scorer re-scores every resume.

### What reviewers see

`GET /api/ats/applications/{teamId}/{applicationId}/info` returns `scores` for **only the
roles applied for**: one entry per role preference, in preference order, each with
`role`, `position`, `score` (0–100), optional `breakdown`, `scoringVersion` and `pending`.
Roles not on the list show the Default score. Entries are `pending` until background
scoring finishes.

### Plugging in a real scorer

The current scorer is `StubResumeScorer` (`version = "stub-v1"`, always scores 0).
To replace it:

1. Implement `ResumeScorer` from `src/scoring/ResumeScorer.ts`:
   `score({ resumeKey, resumeHash, position }) → { score, breakdown? }`.
2. Give it a **new** `version` string.
3. Register it once at startup with `setResumeScorer(new MyScorer())`.

Stub scores remain in the collection under `stub-v1` and can be deleted.

## Endpoint changes

| Endpoint | Change |
|---|---|
| `POST /api/ats/applications/apply` | Stores `resumeKey`, `resumeHash`, `profileSnapshot`; PDF check moved before writes; starts background scoring |
| `GET /api/ats/applications/{teamId}/{applicationId}/resume` | Takes an **application ID** and returns that application's resume copy. Must belong to `teamId`, otherwise 404. Still accepts an applicant ID (older clients), which resolves to that applicant's application for the team. Older applications fall back to the profile resume. |
| `GET /api/ats/applications/{teamId}/{applicationId}/info` | `profile` is the submitted snapshot (falls back to the current profile); new `scores` array |
| `GET /api/ats/applications/{teamId}/{applicantId}/otherapps` | Returns 404 unless the applicant applied to `teamId` |

Full request/response docs are generated from the controller JSDoc and served at `/api/docs`.

## Known limitations

- Resumes overwritten before this change cannot be recovered; those applications use the
  fallback.
- The local dev stack has no S3, so the apply and resume flows can only be exercised
  end-to-end against a real bucket.

## Follow-ups on merge into TechOps

These live in the TechOps monorepo and were intentionally not changed here:

- **webui:** in `peopleportal/webui/src/components/fabric/DashboardTeamRecuitment.tsx`
  (the resume fetch, around line 536), pass `selectedApplication.id` instead of
  `selectedApplication.applicantId`. The applicant-ID form keeps working through the
  compatibility path, so this is not urgent.
- **webui (deferred feature):** display `scores` in the application details modal.
- **corpwiki:** in `docs/people-portal-user-guide/recruitment/evaluating-applications.md`,
  under "Application Info", note that the profile and resume shown are the ones submitted
  with that application.
- **corpwiki:** move this page into the People Portal dev guide.

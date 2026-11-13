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

## Rollback

Every commit on `feature/ats-schema-update` builds on its own, so the fastest rollback
after a failed deploy is to **redeploy the last known-good commit**. When a change has to
come out of the branch instead, use `git revert` as described below.

Not every commit can be reverted alone. Later commits edit the same lines (conflicts), or
use code that an earlier commit added (the build breaks). The table was checked at
`3318e96` by reverting each commit, or each group of commits, in a scratch worktree and
running `tsoa spec-and-routes` + `tsc`.

| Commit | What it does | Revert alone? | How to roll it back |
|---|---|---|---|
| `65900ed` | gitignore | ✅ | `git revert 65900ed` |
| `0c73f1c` | schema fields + `ResumeScore` model | ❌ build breaks (everything later uses it) | `git revert --no-edit 0c73f1c^..HEAD` (the whole feature) |
| `43ee17a` | scoring module | ❌ conflicts | revert the scoring group below |
| `903bf59` | S3 copy/hash helpers | ❌ build breaks (apply flow uses them) | `git revert --no-edit 903bf59^..HEAD` |
| `99a3e65` | PDF check before writes | ❌ conflicts with `7451ae2` | `git revert --no-edit 99a3e65^..HEAD` |
| `ea61dc3` | per-application resume copy, hash, snapshot | ❌ conflicts, and later endpoints use its `Types` import | `git revert --no-edit ea61dc3^..HEAD` |
| `4b3e40e` | background scoring after apply | ❌ import-line conflict with `7591372` | `git revert --no-edit 7591372 4b3e40e` (stops scoring; details no longer return `scores`) |
| `9bbcaec` | resume by application ID + team check | ✅ | `git revert 9bbcaec` |
| `7591372` | snapshot profile + scores in details | ✅ | `git revert 7591372` |
| `5947b98` | otherapps team check | ✅ | `git revert 5947b98` |
| `66aa90b` | this doc | ✅ | `git revert 66aa90b` |
| `7451ae2` | resume key ownership check | ✅ | `git revert 7451ae2` (**reopens a security gap**: avoid) |
| `3318e96` | reject invalid scorer results | ✅ | `git revert 3318e96` |

**Grouped rollbacks** (each verified to build):

- **Remove the whole scoring feature:** `git revert --no-edit 3318e96 7591372 4b3e40e 43ee17a`.
  Resumes are still copied and hashed per application, and existing `ResumeScore` documents
  are left untouched.
- **Remove per-application resumes and everything after them:**
  `git revert --no-edit ea61dc3^..HEAD`. Applications already created keep their
  `resumeKey`, `resumeHash` and `profileSnapshot` fields, which the reverted code ignores.

A range like `X^..HEAD` reverts newest-first, which is why it applies cleanly. Commits added
after this table was written also need checking: a range revert includes them as well.

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

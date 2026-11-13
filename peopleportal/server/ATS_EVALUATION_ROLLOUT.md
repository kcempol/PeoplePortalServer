# Experimental ATS evaluation rollout

## Unification release prerequisites

The active pipeline is AutomatedEvaluation per application/subteam/raw title.
ResumeScore records/modules remain legacy compatibility; stub scores are suppressed.
Consumers of details.scores must migrate to the evaluation endpoints. Application
snapshot fields and the teammate's original history are retained.

Before enablement:
- Review optional `snapshotHash`, `contextKey` and `revision` evaluation fields with
  the schema owner; check legacy revision handling and processing records without leases.
- Enforce immutability/access policy on referenced application snapshot S3 keys.
  Current reads trust persisted snapshot hashes; processing verifies actual bytes.
- Set `ATS_AI_PRIVACY_REVIEWED_VERSION=work-evidence-v4` only after club review of
  prepared résumés AND job context, languages, vocabulary losses and scoring fairness.
- Pin the approved model snapshot and review cost parameters. Check that deployed
  structured output, S3 reads/copies, Poppler and actual indexes work in staging.
- Rehearse queue CAS races, duplicate upserts, ambiguous commits, interrupted config
  invalidation, lease expiry and the 30-second shutdown deadline in approved staging.
- Publish fixed-code operational events to monitoring; alert on backlog age, missing
  records, failed evaluations, lease recovery and reserved budget exhaustion.
- Do not delete snapshots after ambiguous commits. Orphan cleanup requires a separate
  verified procedure; no migration or cleanup was performed by this work.

Full local verification does not establish production throughput or privacy guarantees.
See `src/services/ats/README.md` and `docs/ats-change-ledger.md` for current behavior.

The production provider, bounded PDF extractor, lease worker, and status polling
are implemented. They remain disabled in development and tests. Missing club
configuration returns `AIScoringNotConfigured` (HTTP 503). Tests use synthetic
text and mocked model methods, PDF parsers, object readers, and AI transport.
No score changes an application stage, star rating, or human note.

## When shared MongoDB access is approved

1. Review the `AutomatedEvaluation` schema and create its compound unique index
   on `(applicationId, subteamPk, jobTitle)`, plus the status and applicant/hash
   indexes, and the status/lease/queue worker index. Check for duplicates and
   index build impact before deployment. Initialize missing attempts to zero;
   move legacy processing records without leases back to queued.
2. Add `importantRequirementsByRole` to existing `SubteamConfig` documents as
   an empty array where absent. Existing roles and role-specific questions
   remain valid. Do not migrate human `Application.stars` or `notes` into AI data.
3. Confirm read/write permissions for the new collection and run a staging
   migration and rollback rehearsal. Test a team with multiple job titles and
   an applicant with more than one application.
4. Provision `ScoringBudget` with `{_id: "ats-scoring", usedUsd: 0}`. Missing
   budget records block scoring. Never automatically reset the ledger. Convert
   any previously deployed draft requirements maps to `{role, text}` arrays.

## When the club supplies its AI configuration

1. Store the club-owned `OPENAI_API_KEY` in the server's secret manager. Never
   put it in the UI, source files, logs, or fixtures. Confirm the club's model,
   output token limit, per-evaluation cost ceiling, and total spend ceiling.
   The server-side `readClubScoringConfig` contract requires
   `ATS_AI_SCORING_ENABLED=true`, `OPENAI_API_KEY`, `ATS_AI_MODEL`,
   `ATS_AI_MAX_OUTPUT_TOKENS`, and `ATS_AI_MAX_COST_USD_PER_EVALUATION`.
   Also require `ATS_AI_TOTAL_BUDGET_USD`, `ATS_AI_INPUT_USD_PER_MILLION`, and
   `ATS_AI_OUTPUT_USD_PER_MILLION`, reviewed against current model prices.
   Production activation additionally requires `NODE_ENV=production`,
   `ATS_AI_CLUB_CONFIRMED=true`, `ATS_AI_PRIVACY_REVIEWED_VERSION=work-evidence-v4`,
   and the club's S3 bucket/access-key/secret configuration required by the existing client.
2. Review the implemented provider's strict structured output and conservative
   spend reservations. Reservations include the maximum output allowance and
   are never refunded after uncertain billing outcomes or failures.
3. Install Poppler (`pdftotext`) in the deployment image. Extraction validates
   applicant ownership, canonical object key, PDF type/header, 10 MiB maximum,
   20-page limit, 48 KB text ceiling, and ten-second parsing timeout. OCR is
   unsupported. No file bytes or full text are persisted or logged.
4. Rehearse worker recovery in staging. Atomic claims use two-minute leases,
   token-fenced writes, and three attempts. Startup registers the worker only
   with complete production configuration. Shutdown stops schedules, drains active
   work and closes HTTP/Agenda/Redis/Mongo within a 30-second deadline.

Until these steps are complete, processing is exercised only with injected
local test dependencies. Changing role settings also invalidates in-flight
leases so an old worker cannot publish an outdated result.

Privacy preparation reconstructs wrapped work bullets, screens instruction and
protected-content patterns, redacts known submitted names, and removes unknown
Unicode words using reviewed work vocabulary. Job context is prepared through the
same vocabulary boundary. Model narratives use fixed choices; positive scores need
substantive exact excerpts, excluding placeholder-only evidence. These conservative
rules can discard useful technical evidence and do not guarantee semantic privacy
across languages/formats. Review adversarial cases, evidence quality and fairness
before providing the version-matched approval. No real résumés were processed.

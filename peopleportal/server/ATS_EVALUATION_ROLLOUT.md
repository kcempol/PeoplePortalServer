# Experimental ATS evaluation rollout

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
   `ATS_AI_CLUB_CONFIRMED=true`, and the club's existing S3 configuration.
2. Review the implemented provider's strict structured output and conservative
   spend reservations. Reservations include the maximum output allowance and
   are never refunded after uncertain billing outcomes or failures.
3. Install Poppler (`pdftotext`) in the deployment image. Extraction validates
   applicant ownership, canonical object key, PDF type/header, 10 MiB maximum,
   20-page limit, 48 KB text ceiling, and ten-second parsing timeout. OCR is
   unsupported. No file bytes or full text are persisted or logged.
4. Rehearse worker recovery in staging. Atomic claims use two-minute leases,
   token-fenced writes, and three attempts. Startup registers the worker only
   with complete production configuration. Stop hooks clear its scheduling.

Until these steps are complete, processing is exercised only with injected
local test dependencies. Changing role settings also invalidates in-flight
leases so an old worker cannot publish an outdated result.

Privacy filtering removes known applicant names and contact patterns, discards
identity/education/protected-trait lines, retains action/skills evidence, and
removes unrecognized capitalized entities. Explanations and evidence are
validated before persistence. This conservative rule-based boundary can remove
useful evidence and reject legitimate output; it does not guarantee semantic
detection across all languages and formats. Review synthetic adversarial cases
and club privacy requirements before enablement. No real résumés were processed.

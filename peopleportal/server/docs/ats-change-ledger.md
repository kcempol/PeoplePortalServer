# ATS unification change ledger

Base: `a14010200a422cadfde86ff1c655e94cd6ed4598`. Teammate history through
`a27f3299c51afb3dbb8a1807f55247066f8d71b8` remains an ancestor.
Local ATS source checkpoint: `0f7880bb2981c285af38dfd40f5088b983bfe106`.

## Batch 1 — restore local workflow and bind extraction to application snapshots

- One active submission path delegates to the transactional applicant service.
- Application snapshot copy/hash/profile fields are retained. The submitted name
  is snapshotted for stable privacy preparation. Missing snapshots fail automatic
  scoring safely; legacy reviewers retain the canonical working-resume fallback.
- Extractor checks exact applicant/application key and actual PDF-byte SHA-256.
- ResumeScore modules and stored data are preserved for compatibility. Stub
  assessments are suppressed and the UI uses AutomatedEvaluation only.
- Failed/ambiguous commits never delete snapshots; orphan cleanup is a separately
  approved operational task. No migration or external service was run.
- Verification: route generation, server compilation, 35 existing focused tests
  and 3 snapshot-specific tests (one newly added transaction regression) passed.
- Correctness delta review: no new blocker/high issue; requested transaction-field
  coverage was added. Other baseline audit issues remain for later batches.
- This batch includes the previously checkpointed local refactor, UI and workers.
  Their known baseline limitations remain disabled pending the next batches.

Rollback: revert deliverable commits newest-first. Do not revert the teammate merge
or rewrite shared history. `git log --oneline integration/ats-unified` supplies exact
commit SHAs; subsequent batches depend on this batch.

## Batch 2 — atomic transitions and current scoring context

Depends on batch 1 (`68bb6b5`). Manual transitions compare status plus revision;
legacy documents with absent revision remain supported despite hydrated defaults.
Processors require a lease and compare status/token/expiry/context before writes.
Actual model/prompt/rubric and snapshot hash are stored together; requirements are
loaded before scoring and checked again before publication. Scored reads compare
immutable snapshot/context metadata instead of re-downloading every PDF.
Queue handoff waits at most 250ms; late writes may finish safely and reconciliation
repairs missing work. Fixed operational event codes contain no private data.

Query-aware tests replace old unleased processing mocks and cover wrong token,
expired lease, changed state/context, changed requirements, retry cap, new-context
retry, legacy revision defaults and per-title scores. Server compilation and focused
tests pass. Concurrency reviewer found hydrated-default compatibility issue; fixed
and regression-tested. Delta re-review found no additional actionable issue.
Real Mongo unique-index and transaction behavior remains a staging prerequisite.

## Batch 3 — privacy policy and evidence integrity

Depends on `83a11ba`. Prompt version increments to v3. Wrapped bullets are joined
before filtering. Instruction-like/protected-content bullets are dropped, unknown
narrative terms are redacted, and placeholder text cannot satisfy minimum evidence.
Positive scores require nonempty substantive exact excerpts. Free-form model
narratives are replaced by fixed safe schema choices; raw title and validated
evidence still explain the per-title result. This deliberately sacrifices narrative
richness and unfamiliar technical vocabulary for privacy. Calibration must measure
that tradeoff before production.

Production now also requires `ATS_AI_PRIVACY_REVIEWED_VERSION=work-evidence-v3`.
Only club owners may approve this after reviewing residual heuristic limitations,
ambiguous names/technical terms, languages and formats. This flag is not evidence
of guaranteed privacy or scoring fairness. No approval was provisioned here.
Adversarial synthetic tests cover lowercase traits/names, instructions, wrapped
evidence, empty/placeholder excerpts, and complete-but-disabled config permutations.

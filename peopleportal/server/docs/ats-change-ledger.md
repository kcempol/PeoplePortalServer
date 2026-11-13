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

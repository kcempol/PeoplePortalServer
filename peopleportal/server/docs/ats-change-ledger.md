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

Privacy reviewer found a Unicode-name bypass; Unicode-aware tokenization and four
script regression cases close that demonstrated gap. Delta review found no further
actionable issue. Baseline heuristic limitations remain subject to club review.

## Batch 4 — bounded recovery and graceful shutdown

Depends on `b35e66f`. Reconciliation uses a finite high-water mark per sweep, one
batch lookup for existing evaluations, a shared per-subteam config promise and a
batch-local tuple set. Missing records remain retryable after interrupted passes.
Retry-exhaustion scans run once/minute rather than once/job. Shutdown stops accepting
requests, stops schedules, drains active work and closes Agenda/Redis/Mongo, with a
30-second force-termination deadline. Fixed event codes expose operational failures.
Tests cover new arrivals without starvation, partial recovery, existing statuses,
pending worker drain, bounded exhaustion cadence and shutdown timeout. Server compile
and focused tests pass. Performance review and low-priority delta re-review found
no remaining actionable issue. Production load/query-plan testing remains required.

## Batch 5 — reviewer loading and request recovery

Depends on `73e6e15`. UI distinguishes initial loading, failed requests and disabled
configuration. GET polling is completion-based and abortable; terminal states stop
polling. Requests time out after 10 seconds; load failures back off and stop after
five attempts, with manual retry available. Queue state uses a separate identity
generation so load refreshes cannot strand buttons or apply results to another app.
Seven mocked hook tests pass. Readability/testing reviewer found the busy-state
race and missing timeout coverage; both fixed, delta re-reviewed without remaining
actionable findings. Full web typecheck retains 18 pre-existing errors in unrelated
files; changed ATS files do not appear in its diagnostics.

## Final audit follow-ups and verification

Batch 6 depends on `97bb452`. Final correctness review requested a fresh attempt
cycle when a worker discovers changed context before scoring; reset-to-one on the
claimed attempt is now covered by a regression. Final privacy review requested the
same boundary on job titles/requirements; provider fields are prepared while raw
context identity stays distinct. Prompt and privacy-policy versions increment to
v4 so older approvals/results cannot be reused. Static S3 configuration and API
key/model values must be nonblank. Active snapshot/submission error logs use fixed
codes only. Runtime/rollout documentation now agrees with these gates and shutdown.

Final specialist audit dispositions (sequential, read-only):
- Correctness: no blocker/high; immutable storage and API-field deprecation documented;
  new-context attempt allowance corrected and tested.
- Concurrency: no blocker/high; real Mongo races/transactions remain staging work.
- Privacy/security: no blocker/high after Unicode and job-context delta fixes;
  semantic privacy, calibration and fairness still require human review.
- Performance: no blocker/high; no measured throughput claim; sweep latency and
  multi-instance overhead documented.
- Readability/testing: no blocker/high; rollout and final ledger completion requested
  and addressed. Focused UI timeout/identity tests are meaningful regressions.

Verification: server generation/compilation, 53 final focused ATS tests, 168 final server
unit tests, all 36 UI tests, scoped ATS UI typecheck,
and diff checks passed. Full UI compilation retains 18 pre-existing errors outside
the changed ATS files. Model/parser/provider/network components were mocked; no
real Mongo/S3/OpenAI integration or résumé data was used. Production enablement,
schema/index deployment and storage immutability still require approved staging.

## Delivery commits and rollback

| Commit | Purpose |
| --- | --- |
| `68bb6b5` | Restore local workflow and adapt application snapshots |
| `83a11ba` | Atomic state/context transitions |
| `b35e66f` | Evidence and privacy boundary |
| `73e6e15` | Bounded reconciliation and graceful drain |
| `97bb452` | UI error/poll recovery |
| `de22106` | Final audit fixes, v4 context preparation and staging documentation |

The final documentation-only commit adds this completed index. Roll back that HEAD
first if desired, then `de22106`, `97bb452`, `73e6e15`, `b35e66f`, `83a11ba`,
`68bb6b5`, stopping before base `a140102`.
The checkpoint and teammate history are retained; nothing was pushed or deployed.

## PR scope update: defer UI work

The review branch was published as PR #2 targeting `feat/ats-ai-prescreen`.
At the owner's request, a follow-up commit restores all four changed web UI files
to base `a140102`. The PR therefore contains no net web UI changes. The earlier
UI work and verification above remain historical checkpoints, recoverable from
the preceding commits; the final reviewer interface will be decided separately.
Server scoring, queueing, schema integration, and API behavior are unchanged by
this scope update. Verification for this update checks exact web UI equality with
the base, unchanged server source, and `git diff --check`; no live services run.

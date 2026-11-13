# Schema branch integration

This merge preserves the original `feature/ats-schema-update` history through
`a27f3299c51afb3dbb8a1807f55247066f8d71b8`, mapped from the standalone server root
into `peopleportal/server` in the monorepo.

Included: application-specific résumé copies and byte hashes, profile snapshots,
ResumeScore cache and position normalization, the pluggable scorer, automatic
all-position scoring, submitted-profile/detail responses, application-specific
résumé downloads, ownership checks, and the original data-model/rollback guide.

The incoming submission/profile/details/resume/otherapps implementations take
precedence. Existing recruitment, human-feedback/stage services, evaluation
endpoints, pending-stage-action schema and avatar utilities remain available.
The default incoming scorer is still `StubResumeScorer` (`stub-v1`, score zero).
Its scoring path is distinct from the gated AutomatedEvaluation pipeline.

This is a feature-branch integration, not production activation. The newer local
ATS refactor/reconciliation changes in the original checkout are intentionally
not part of this merge and must be adapted to these snapshot fields afterward.
In particular, the experimental extractor still reads the applicant's working
résumé; adapting it to application-specific résumé copies is follow-up work.
The two scoring contracts must be reconciled before live AI scoring is enabled.
No migrations, external scoring or deployment were performed during integration.

The standalone rollback ranges in `ats-data-model.md` describe the source branch.
They should not be applied blindly across this monorepo merge. To undo this merge,
review a merge revert against its first parent; never rewrite the shared branch.

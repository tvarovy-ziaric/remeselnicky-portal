# Trust/evidence aggregation read model (R2-008, R4-016–R4-018)

Migration `0034_trust_evidence_read_model.sql` established two additive,
`security_invoker` views over the approved-public R2 discovery intersection.
Migration `0090_completed_job_work_volume.sql` activated verified completed-Job
volume and migration `0094_unlocked_provider_review_reputation.sql` activates
unlocked customer-review quality:

- `current_searchable_trust_evidence_summaries` contains one global factual
  summary per searchable profile.
- `current_searchable_profession_trust_evidence` contains exact governed
  profession context and never replaces it with a global average.

The repository reads both views in one repeatable-read snapshot for 1–50 unique
server-derived public profile IDs. Hidden, suspended, rejected, and unknown
profiles all produce the same absence. Results contain no owner/customer/
reviewer identifiers, Job or claim IDs, review/evaluation text, contact data,
exact location, media/storage data, or ranking coefficients.

## Cold-start and activated evidence contract

Profiles without evidence remain neutral:

- `customerScore` is `null`, never a fabricated zero or default score;
- customer, supervisor, and source-diversity confidence are
  `INSUFFICIENT_SAMPLE`, which expresses uncertainty and never negative
  quality;
- customer and supervisor quality are explicitly unavailable.

R4 activation changes only facts backed by authoritative provenance:

- `verifiedJobCount` comes from customer-accepted or explicitly distinguished
  admin-completed Job evidence and is never itself a positive rating;
- `customerReviewCount` and `customerScore` come only from unlocked
  `CUSTOMER_TO_PROVIDER` main reviews;
- each review contributes one equal-weight score derived from its answered
  dimensions, while N/A dimensions are excluded;
- global and exact-profession aggregates stay separate;
- non-zero review count and quality availability must be coherent, or the
  domain serializer fails closed;
- raw comments, authors, customers, Jobs and exact timestamps never enter
  these aggregate views.

R4-018 records optional customer reviews of an exact verified
`JobParticipant` in a separate append-only stream. Each logical review
snapshots only the professions, skills and confirmed operational roles that
the participant actually carried on that completed Job. A participant with
verified work but no confirmed profession remains reviewable, but contributes
to no invented profession context. These records are not folded into the
main-provider headline average: a cross-target weighting policy is not locked.

Reviews of a concrete historical `JobWorkGroup` snapshot every qualifying
assignment interval that overlapped verified execution. They remain a
separate team-context signal and never change an individual member's review
count or score. Reusable Crew membership is not an eligibility source and
later Crew/group changes cannot rewrite the snapshot. No participant or team
body is added to a public/search aggregate by migration `0095`.

Small-sample confidence intentionally remains `INSUFFICIENT_SAMPLE`, and the
search signal keeps `review_sample_sufficient = false`. Scores and evidence
counts may be displayed, but score-driven ordering stays disabled until a
separate governed confidence policy is approved.

## Other authoritative facts

- current approved, non-expired credential types are counted distinctly;
- current public projects are counted distinctly only when their authoritative
  evidence status is `VERIFIED`;
- completed Job participation is counted distinctly with its exact profession
  context.

Profession rows require exact profession relevance for credential, project,
skill, and specialization facts. Attachment/photo/revision quantities are not
counted. Paid status, founder status, profile completeness, profile photos, and
tag quantity are absent and cannot improve the read model.

R4-019 may extend supervisor hooks only from sources that retain the locked
provenance and anti-gaming constraints. Ranking policy remains separate and
must not treat raw volume as an opaque quality score.

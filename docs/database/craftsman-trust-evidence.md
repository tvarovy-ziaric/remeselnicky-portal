# Trust/evidence aggregation read model (R2-008)

Migration `0034_trust_evidence_read_model.sql` adds two additive,
`security_invoker` views over the approved-public R2 discovery intersection:

- `current_searchable_trust_evidence_summaries` contains one global factual
  summary per searchable profile.
- `current_searchable_profession_trust_evidence` contains exact governed
  profession context and never replaces it with a global average.

The repository reads both views in one repeatable-read snapshot for 1–50 unique
server-derived public profile IDs. Hidden, suspended, rejected, and unknown
profiles all produce the same absence. Results contain no owner/customer/
reviewer identifiers, Job or claim IDs, review/evaluation text, contact data,
exact location, media/storage data, or ranking coefficients.

## Sparse cold-start contract

R2 has no completed-Job participation or review source authority. Therefore:

- `customerReviewCount`, `supervisorEvaluationCount`, `verifiedJobCount`, and
  `independentEvidenceSourceCount` are factual zero;
- `customerScore` is `null`, never a fabricated zero or default score;
- customer, supervisor, and source-diversity confidence are
  `INSUFFICIENT_SAMPLE`, which expresses uncertainty and never negative
  quality;
- customer and supervisor quality are explicitly unavailable;
- profession evidence-supported level and skill/specialization evidence hooks
  remain nullable/false until a provenance-preserving future projector exists.

The domain serializer rejects non-zero unavailable R4 evidence rather than
accepting a fabricated review or verified-Job count.

## Existing authoritative facts

The only non-zero facts derivable now are kept in volume, never quality,
confidence, source diversity, or ranking:

- current approved, non-expired credential types are counted distinctly;
- current public projects are counted distinctly only when their authoritative
  evidence status is `VERIFIED` (today this remains zero because existing
  self-declared projects are `UNVERIFIED`).

Profession rows require exact profession relevance for credential, project,
skill, and specialization facts. Attachment/photo/revision quantities are not
counted. Paid status, founder status, profile completeness, profile photos, and
tag quantity are absent and cannot improve the read model.

R4-016–R4-019 must replace the neutral hooks only from completed Job,
JobParticipant, review, and supervisor-evaluation sources that retain the
locked provenance and anti-gaming constraints. R2-009 separately owns any
cross-signal ranking policy and must not treat raw volume as an opaque score.

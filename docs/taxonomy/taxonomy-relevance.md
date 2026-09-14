# Taxonomy relevance facts (R2-005)

`@portal/search` projects bounded, categorical profession, specialization, and
skill relevance facts from the validated R2 search read-model. This ticket does
not create a ranking score, numeric weights, a database migration, or another
public read path. R2-009 remains responsible for combining taxonomy, geo,
qualification, availability, and trust signals into `Recommended` ordering.

## Trusted composition boundary

The projector is server-internal. Its candidate input is the allowlisted,
validated `SearchableCraftsmanCandidate` produced from the approved-public 0029
views. Its query is constructed from governed autocomplete suggestions; client
supplied profile/provenance objects or arbitrary taxonomy codes must not be
cast into either input type.

Autocomplete marks suggestion objects with process-local, non-serializable
provenance. The query composer verifies that provenance before minting its
opaque query type. JSON round-trips and client-constructed lookalikes therefore
fail closed; a future persisted/cached selection must be revalidated against
the active catalogs instead of bypassing this boundary.

A query contains one canonical profession, at most one specialization, and at
most 20 unique canonical skills. `TEST:*`, malformed codes, a specialization
from another profession, and skills without the queried profession link fail
closed. Candidate capability relationships are checked again before facts are
projected.

## Explainable facts

- `taxonomyEligibility` is `EXACT_PROFESSION` only when the candidate has the
  queried profession. Specialization and skill facts can enrich that match but
  can never create eligibility without it.
- Profession, specialization, and skill support is categorical:
  `NONE`, `SELF_DECLARED`, or `EVIDENCE_SUPPORTED`. Evidence remains explicitly
  separate and stronger in provenance; no threshold or owner-writable evidence
  source is introduced.
- Declared proficiency is returned only with
  `declaredLevelInfluence = WEAK_CONTEXT_ONLY`. A self-declared `MASTER` never
  manufactures a match.
- Skill aggregation is `PRESENCE_ONLY`. One deterministic representative match
  is exposed, preferring evidence-supported provenance and then code-point code
  order. Additional matching tags do not increase the signal.

The output allowlist contains the profile UUID, governed taxonomy codes, levels,
and categorical facts only. Labels, identity/contact text, popularity,
completeness, media, founder status, and paid-placement data are neither read
nor copied.

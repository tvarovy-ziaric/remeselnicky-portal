# Recommended organic ranking (R2-009)

The alpha `Recommended` pipeline composes the already-authorized R2 search
facts in `@portal/search`. It adds no database state and publishes no numeric
score, weight, coefficient, or administrator override.

## Eligibility and order

The pipeline first removes candidates without the exact governed profession.
A server-owned resolver, already bound to the governed profession/service
query, supplies the current qualification context. Missing context and an
unavailable required/optional qualification decision fail closed. A
non-regulated context is minted only inside the pipeline from that resolver;
there is no caller-supplied `NOT_APPLICABLE` literal that can bypass R2-006.
For a regulated query, the same server-owned resolver evaluates qualification
inside `rank` for each exact profile UUID. Candidate payloads never carry a
detached qualification result that could be swapped onto another profile.

Eligible candidates use this deterministic lexicographic order:

1. searched specialization presence, then searched skill presence;
2. service-area band, then internal distance within the band;
3. the required-credential hard gate (not a score);
4. indicative availability as a soft positive;
5. profession-relevant evidence/trust presence;
6. declared proficiency as weak secondary context;
7. profile UUID in code-point order.

The strong geo tier contains both an explicitly declared additional area and
the normal radius. `FARTHER_BY_AGREEMENT` follows, then an explicitly broadened
outside-area match. A no-location query has `DISTANCE_UNAVAILABLE` for every
candidate and therefore creates no geo advantage or penalty. Mixed available
and unavailable distance rows are rejected as an incoherent query snapshot.

An approved optional credential is not placed before availability. It is one
profession-scoped evidence-presence fact at the later evidence stage; a
missing optional credential is neutral. Required credentials remain a hard
eligibility gate.

## Cold start and anti-gaming

Evidence is categorical `SUPPORTED` or `COLD_START_NEUTRAL`. Counts are reduced
only to the presence of an authoritative profession-scoped credential or
verified-work fact; their magnitude never improves order. Query-relevant
evidence-supported profession, specialization, or skill facts may establish
support, while self-declared data remains distinct. Current null scores and
`INSUFFICIENT_SAMPLE` confidence do not rank.

A new profile has no negative reputation. It can outrank an evidenced profile
on any earlier profession/service, geo, required-qualification, or availability
stage. Self-declared `MASTER` is considered only at the final weak-context
stage and can never repair a worse earlier match.

Paid/premium/founder state, completeness, profile photos, tag quantity,
indicative price, tiny-sample response/acceptance/completion metrics, raw
dispute/cancellation counts, and casual admin boosts are neither inputs nor
output and cannot affect the comparator.

## Privacy boundary

The result allowlist contains only the public profile UUID, categorical match
facts, rounded approximate distance, evidence-presence booleans, and declared
level context. Internal metre distance is used for stable comparison but is
not returned. Availability facts retain and validate their originating profile
UUID so a soft-positive fact cannot be moved to another candidate. Candidate
names/cards, representative public media and relevant
indicative prices remain separate public projections for R2-011 to join by
profile UUID. The ranking result never carries contact details, exact location,
storage data, review/evaluator text, provenance identifiers, or raw counts.

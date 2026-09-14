# Public search cards and why-matched explanations

R2-011 composes cards only from the current server-side search cohort. The DB
adapter resolves the exact profession, specialization and skills against the
currently activated governed catalogs, then keeps candidate eligibility,
service-area, availability, trust and credential qualification in one
read-only repeatable-read snapshot through final projection.

The Web Alpha cohort is capped at 100 profiles **after** exact profession and
optional identity matching. More than 100 matching profiles fails closed; it
does not silently rank an arbitrary UUID page. Outward cursor slicing happens
only after the complete bounded cohort is ranked and alternate sorting is
applied.

Public output is an explicit allowlist: safe public identity, the matched
profession, municipality and rounded kilometres, nullable customer rating and
count, verified-work count, fixed-label relevant badges, categorical
availability, one already-public representative media asset ID, and bounded
human explanations. Reasons follow product priority: taxonomy match, geography,
required qualification, availability, then one evidence/trust fact. They never
describe numeric weights.

Exact coordinates/metres, contacts, addresses, storage keys/hashes, evidence
documents, reviewer/admin metadata and private availability intervals are not
part of the DTO. Indicative price remains `null` until a governed exact
service-to-price match exists. Name/company search is accepted by the read
path, while analytics may retain only the boolean fact that it was used.

Search pages and responses are `no-store` and `noindex`; invalid queries use a
bounded `INVALID_QUERY`, while dependency/integrity failures use a uniform
`TEMPORARILY_UNAVAILABLE` response.

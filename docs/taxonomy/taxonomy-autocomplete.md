# Governed taxonomy autocomplete (R2-002)

`@portal/search` provides a bounded parser and deterministic autocomplete
service for profession/service discovery. It is lexical only: there is no AI,
semantic expansion, profile popularity, claim count, or organic ranking input.

## Input and ordering

- Queries contain 1–120 Unicode code points and at most eight distinct
  normalized tokens. Result limits are 1–20, defaulting to 10.
- Contact channels, URL/domain/handle, address-keyword, postal-code, and secret
  patterns are rejected before normalization. The profession/service query is
  not a channel for submitting personal data.
- NFKD normalization makes Slovak diacritics and case equivalent. The database
  uses an explicit Slovak `translate` expression and does not depend on the
  optional PostgreSQL `unaccent` extension.
- Exact canonical profession matches come first. The remaining fixed groups
  distinguish canonical and alias matches across profession, specialization,
  and skill kinds. Within a group, normalized ASCII labels and stable codes use
  code-point ordering, so ICU/locale configuration cannot change ties.
- Match precedence is an implementation boundary, not a numeric score exposed
  to organic craftsman ranking.

## Catalog governance

The database adapter reads only the latest activated release when it is
`CANONICAL` and `HUMAN_REVIEW_APPROVED`. Entries and relevant parent
professions must be `ACTIVE`; public `TEST:*`, deprecated, placeholder, and
unactivated content is excluded. The skill release must be pinned to the same
current profession-taxonomy release, and every returned skill has at least one
active governed profession link.

Profession and specialization aliases come only from `taxonomy_aliases`. All
three governed alias kinds are searchable: `LEGACY_CODE`, `LEGACY_SLUG`, and
`SEARCH_TERM`. Skills have no alias table, so only their canonical label and
slug are searchable. Alias text is never returned; results always contain the
target's canonical label and explicit code/kind/profession links. New Slovak
synonyms therefore require the existing human-reviewed taxonomy release flow.

## Public API boundary

`GET /v1/public/taxonomy/suggestions?q=...&limit=...` is implemented as an
isolated Fastify route registration. Unknown, missing, or duplicate query
parameters are rejected. Responses are `no-store`, never echo the query, never
include matched alias text, and expose only `code`, `kind`, canonical `label`,
`matchedBy`, and `professionCodes`. Unexpected persistence or governance data
fails closed without leaking database errors. Route registration remains an
explicit application-composition step so deployments without the dependency do
not silently expose a partial autocomplete.

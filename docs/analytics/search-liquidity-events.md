# Search analytics and liquidity boundary

R2-013 extends the provider-neutral `@portal/analytics` catalog with explicit
discovery observations. Analytics remains downstream of the authoritative
search/domain result: it never admits a candidate, changes a filter, changes
ranking or turns indicative availability into a booking promise.

## Stable event contract

| Event                                   | Source          | Emission boundary                                                                                    |
| --------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| `search_started`                        | `CLIENT_UX`     | An explicit first-page search submit or normalized filter/sort change; not typing or autocomplete.   |
| `search_executed`                       | `SERVER_QUERY`  | A successful first-page result snapshot after public, account, qualification and service-area gates. |
| `search_results_viewed`                 | `CLIENT_UX`     | The result list or zero-result state is actually visible; not SSR/prefetch alone.                    |
| `craftsman_profile_opened_from_search`  | `CLIENT_UX`     | Actual navigation from a visible result card, with its one-based displayed position.                 |
| `craftsman_request_cta_clicked`         | `CLIENT_UX`     | Actual CTA interaction. It is not `job_request_submitted` or another business outcome.               |
| `shortlist_added` / `shortlist_removed` | `SERVER_DOMAIN` | Only after an R2-012 command commits with `APPLIED`.                                                 |

The pre-existing `public_profile_viewed` event is unchanged. R2-013 does not
emit it or add a profile-route hook: it may be wired only when that route has a
D27-compliant first-party consent/admission boundary and records an actually
visible public profile rather than a prefetch.

`search_executed` is the authoritative liquidity fact. `search_started` and
`search_results_viewed` are optional-consent UX observations and are never used
as supply denominators.

## Search properties

`search_executed` contains the opaque per-search UUID, governed profession and
optional specialization codes, boolean optional-filter usage, location scope,
sort mode, local `R2_SEARCH_V1` analytics version and result/availability count
buckets. It never contains the raw query, identity query value, municipality
code, exact distance, coordinates, result IDs, result DTOs, why-matched text,
rank scores or weights.

For alpha, `location_scope` only says `NONE` or `MUNICIPALITY_SELECTED`. A
trusted server may optionally map the governed selected municipality through
the active location catalog and attach both:

- `location_area_granularity`: `DISTRICT` or `REGION`;
- `location_area_code`: its governed stable code.

The pair is all-or-nothing, is absent for `NONE`, and must never be accepted as
a browser-authored value. Municipality-level provider analytics stays disabled
until D27 aggregation/suppression is implemented. Tiny-cohort suppression and
roll-up policy belongs to the trusted reporting layer; this ticket does not
invent its numeric threshold.

Counts are buckets, never exact provider properties:

- `ZERO`;
- `ONE_TO_FOUR`;
- `FIVE_PLUS`.

The server instrumentation helper accepts either a complete exact total or an
explicit `AT_LEAST_FIVE` probe. A page length is not valid evidence. Therefore
a small client page limit cannot misclassify a larger candidate pool as low
supply. Indicatively-available counts use the same evidence contract. They are
`NOT_APPLICABLE` when no timing is supplied; otherwise they count only the
unambiguous AVAILABLE-only overlap after the other gates and do not assert
full-interval coverage, capacity, booking or guarantee.

`search_results_viewed` carries only search ID, rendered count bucket, sort mode
and analytics version. A target profile UUID is permitted only on the explicit
profile-open/CTA events; result lists and competitor sets have no catalog path.

## Shortlist outcome hook

`recordAppliedShortlistTransition` is a narrow post-commit hook. The R2-012
service calls it only for `status: APPLIED`, using the command UUID as the
stable event ID and the active membership count authored in the same serialized
transaction. `UNCHANGED`, `DEDUPLICATED`, denied and rolled-back commands emit
nothing.

Shortlist size uses `ZERO`, `ONE`, `TWO_TO_FOUR`, `FIVE_TO_NINE` or `TEN_PLUS`.
An ADD producing `ZERO` is rejected. The payload contains only this size bucket;
target profile IDs, search IDs, browser-authored source claims and shortlist
member lists are deliberately excluded. Search attribution stays deferred until
R2-011 provides a server-minted, verifiable context rather than an untrusted
POST property.

## Identity, environment and delivery

The first-party admission edge, not an untrusted browser payload, authors
`environment`, source, server receipt time, app/platform versions and exclusion
flags. Authenticated and anonymous contexts both carry trusted `is_internal`
and `is_test` flags. Anonymous/session IDs exist only under D27 cookie/consent
rules. Admin, internal, test and synthetic traffic is excluded from marketplace
KPIs; development/staging transports cannot write to production.

Search execution reuses a deterministic event UUID derived from the search UUID
and local event version, so a transport retry has the same identity. R2-012
reuses its command UUID. Provider/diagnostic failure resolves to a dropped
analytics result and cannot alter a search response, card order, navigation or
committed shortlist state.

## KPI denominators

The reporting layer uses distinct `search_id` values from successful first-page
`search_executed` events, filtered to production non-test/non-internal traffic:

- zero supply: `ZERO / all executed searches`;
- low supply: `ONE_TO_FOUR / all executed searches`;
- adequate alpha choice: `FIVE_PLUS / all executed searches`;
- result-view rate: searches with a viewed result state / executed searches;
- profile-open rate: searches with an explicit open / viewed searches;
- shortlist adoption: APPLIED adds and resulting size buckets for authenticated
  non-test customers. Search-to-shortlist attribution remains unavailable until
  a server-minted search context exists.

Profession and optional trusted district/region cohorts are aggregated only
through the privacy-reviewed reporting layer. No event or KPI feeds back into
ranking, search thresholds or public competitor analytics.

## Integration seams

- R2-011 must create/propagate a per-execution search UUID, server-authored
  result bucket, sort mode, local analytics version and displayed card position.
  Client wiring belongs at the explicit submit, visible list/zero state and
  navigation/CTA boundaries; no app route is changed by R2-013.
- R2-012 supplies the post-commit `APPLIED` state, command UUID and transaction-
  authored active shortlist size. It does not forward browser source/search
  claims. The capture call stays outside the business transaction; a future
  outbox adapter may provide durable delivery without changing event semantics.
- R2-009 exports no analytics/ranking version and no weights. `R2_SEARCH_V1` is
  local to the analytics catalog.

# R2 search security, privacy, and performance evidence

This note records the bounded automated evidence for R2-014. It does not set a
production latency SLO, choose an observability vendor, or alter search ranking.

## Enforced boundaries

- The authoritative database view admits only currently approved, owner-public,
  moderation-allowed profiles whose owner is ACTIVE and whose current publication
  requirements remain complete. Search composition cannot re-admit a row excluded
  by this view.
- Client input is a strict allowlist. Profession is required; page size is at most
  50, skill filters at most 20, the timing interval is bounded canonical UTC, and
  direct candidate/ranking/coordinate/private-calendar facts are rejected.
- The API admits public search through the shared database rate-limit store before
  executing search. It hashes the route plus server-observed IP, stores no raw IP,
  reuses the configured authentication rate window, and applies a documented
  read-heavy multiplier of 5 to the configured request count. Exhaustion returns
  429; missing or failed admission returns a uniform 503.
- API and web response boundaries rebuild an explicit card allowlist. The web
  boundary accepts at most 50 cards, 20 professions, 5 badges, and 5 reasons per
  card, requires canonical UUIDs, and fails closed on corrupt data. React performs
  final text escaping. Responses remain `no-store` and `noindex`.
- Precise coordinates, ranking metres, exact availability periods, contacts,
  addresses, storage metadata, credential evidence identifiers, customer data,
  raw result UUID lists, and raw identity queries are absent from public output and
  search analytics.

## Bounded-query evidence

`public-search-security-performance.test.ts` guards the repeatable-read/read-only
snapshot, 100-candidate server composition cap with a `limit + 1` probe, exact
profession prefilter, batched service-area and availability lookups, batched
qualification evaluation, the identity GIN index, and the municipality centroid
GiST index. These are structural regression checks, not latency claims.

The existing live PostgreSQL helpers cover publication hide, owner suspension,
credential revocation, service-area semantics, availability privacy, and omission
of private fields against real database constraints. Unit tests cover rejected
input fields, cardinality limits, rate-limit failure isolation, response corruption,
and output escaping.

## Operational verification still required

Before the D30 launch gate, run representative search fixtures in staging and
capture query plans and end-to-end latency through the existing route-level HTTP
metrics. Inspect candidate count, index usage, database/PostGIS time, and the
slowest query stage without logging raw queries, IP addresses, exact locations, or
result/profile identifier lists. Establish or change performance thresholds only
from that reviewed staging evidence; this ticket intentionally invents none.

Browser accessibility/usability validation, abuse-policy tuning from production-like
traffic, and any analytics area-code aggregation/suppression remain separate release
evidence. None may weaken publication, credential, service-area, or privacy gates.

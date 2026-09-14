# Service-area matching (R2-004)

Migration `0031_craftsman_service_area_matching.sql` adds a live,
`SECURITY INVOKER` classification function over the R2-001 eligible candidate
view and R2-003 PostGIS distance facts. It stores no duplicate search state and
does not recalculate coordinates.

## Deterministic match bands

For a governed origin municipality, a candidate is classified in this order:

1. `ADDITIONAL_SERVICE_AREA` — the origin is an explicitly declared current
   non-contiguous municipality; this is a strong service-area match.
2. `WITHIN_NORMAL_RADIUS` — approximate centroid distance is at or inside the
   profile-wide normal radius; this is also a strong match.
3. `WITHIN_MAXIMUM_RADIUS` — distance is outside normal but at or inside the
   optional maximum/exception radius. This is default-eligible below strong
   matches as “farther by agreement”.
4. `OUTSIDE_DECLARED_AREA` — distance is beyond maximum, or beyond normal when
   no maximum was declared. This band is excluded by default and appears only
   when the caller explicitly sets `includeOutsideDeclaredArea`.

Exact equality belongs to the enclosing band (`<= normal`, then `<= maximum`).
An additional municipality takes precedence even if it is geographically far
from the base circle. Strong bands share the first geo tier, followed by the
maximum band and explicitly broadened outside results. Ties use internal metre
distance and stable profile UUID.

When origin is omitted, all currently searchable profiles remain candidates as
`DISTANCE_UNAVAILABLE`. Distances are null and ordering falls back to profile
UUID. Lack of origin therefore provides no positive or negative geo signal.
Unknown, inactive, or malformed catalog origins fail closed.

## Privacy and product meaning

The SQL function returns only profile UUID, match band, server-only distance
metres, and rounded kilometres. It returns no centroid, coordinate, address,
owner id, travel-fee policy, or private location. The public serializer removes
metre precision.

Every band expresses a matching preference only. It does not promise that the
craftsman will accept the request, is available, has crew capacity, or will
travel without a fee. A binding travel price belongs in a Quote; alpha does not
auto-price it. Search explanations should use ordinary preference language such
as “normally within the area” or “farther by agreement”, never contractual
wording.

# Privacy-safe craftsman distance facts (R2-003)

Migration `0030_craftsman_distance_facts.sql` adds a live PostGIS distance
primitive over R2-001's `current_searchable_craftsman_profiles` projection. It
does not create a second search index or publication authority. A row can enter
the function only through the current, effectively public candidate view, which
already requires an approved/public/allowed profile and an ACTIVE owner.

## Query contract

The only location input is a nullable code from the governed Slovak municipality
catalog. Client latitude/longitude and exact addresses are not accepted. An
unknown, inactive or foreign/out-of-catalog code is rejected before candidate
data is read. A missing location remains valid: candidates are returned in
stable profile-ID order with both distance values null, because geo relevance is
unavailable rather than negative.

For a known origin, `ST_Distance` compares the origin municipality centroid with
the candidate's current base-municipality centroid. The result is rounded and
bounded to an integer `rankingDistanceMeters`, used only for internal ordering
and later ranking work. Ties use the craftsman profile UUID. Missing candidate
distance sorts last. Service radius, farther-by-agreement and exclusion rules
are intentionally absent; R2-004 owns those semantics.

The explicit public serializer copies only `craftsmanProfileId` and rounded
`approximateDistanceKm`. It cannot serialize metre precision, centroids,
coordinates, postal data, exact/home addresses or owner identity.

## Database safety

`public_craftsman_distance_facts(text)` is `STABLE`, `SECURITY INVOKER`, and has
a fixed `pg_catalog, public` search path. It therefore uses the caller's
underlying table/view privileges and cannot bypass them. The repository performs
the active-origin check and the distance query in one repeatable-read, read-only
snapshot. The migration does not revoke generic function execution because the
repository currently defines no separate runtime database role to grant back;
inventing a role here would make deployments fail. `SECURITY INVOKER` preserves
the existing least-privilege contract: PostgreSQL's default `EXECUTE` permission
on the function does not grant access to its underlying security-invoker views
or tables, and the production runtime must still connect through its
least-privilege database role.

The standalone helper exports
`runCraftsmanDistanceIntegrationAssertions(sql)` and exercises known, missing,
invalid/out-of-catalog, hidden and suspended cases plus deterministic ties and
raw SQL output/privacy constraints. It does not edit the shared migration
runner.

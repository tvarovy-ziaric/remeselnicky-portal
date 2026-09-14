# Craftsman base location and service area (R1-006)

R1-006 stores a craftsman profile's private base/work municipality and its
profile-wide travel preferences. It does not store a home address, an exact
owner coordinate, contact details, a profession-specific radius, or a public
profile projection.

## Governed location catalog

`location_regions -> location_districts -> location_municipalities` is the
normalized Slovakia hierarchy. Every row has a stable code plus source
reference/revision. Only municipalities have an approximate PostGIS
`geography(Point, 4326)` centroid. A wide Slovakia bounding-box check catches
swapped or obviously foreign coordinates; it is not a legal-boundary test.

Migration `0018` intentionally seeds no real municipality data. Production
ingestion needs a separately reviewed, authoritative Slovak dataset and
provenance. Until that content-source gate is completed, only synthetic test
rows are valid. Application service-area commands accept catalog codes only;
they never accept free-form municipality names or owner-supplied coordinates.
Catalog rows are append-only in this alpha baseline so corrections cannot
silently rewrite referenced history. A later governed catalog-release process
can add explicit supersession/versioning.

## Immutable service-area revisions

Each accepted owner command records:

- the profile and actor;
- expected and server-derived resulting revisions;
- a SHA-256 intent fingerprint for idempotent replay;
- base municipality, normal and optional maximum radius;
- ordered extra municipality codes;
- optional travel-fee policy text and optional distance threshold.

The database stores distances as integer metres, while the domain boundary
uses kilometres with at most two decimal places. This avoids silent database
rounding and gives canonical idempotency fingerprints. Radius values are
preferences used later by matching; they do not hard-reject a request outside
the radius and never calculate a binding travel price. Any binding amount
belongs in a Quote.

Current state is the latest immutable revision. Commands and revision effects
are linked by deferred database constraints, including the exact ordered extra
areas. `UNCHANGED` commands must match current state exactly. Commands,
revisions and extra-area rows cannot be updated or deleted.

Private drafts may be incomplete. Base municipality and normal radius become
required only in the later publication-readiness command from R1-010.

## Authorization and extensibility

Repository reads and writes require an ACTIVE owner of the target
`CraftsmanProfile`. The database repeats that check under row locks so account
suspension and writes serialize safely. Optimistic revisions prevent lost
updates, and a command UUID cannot be reused for a different intent.

The alpha UI guides users to at most about three extra non-contiguous
municipalities. This is presentation guidance, not a backend product cap. The
domain and normalized persistence accept up to a generous technical bound of
256, so later UI evolution does not require a schema redesign.

Travel policy text is normalized to LF newlines and cannot contain phone,
email or external-URL bypass content. It remains policy context, not an
automatic pricing formula.

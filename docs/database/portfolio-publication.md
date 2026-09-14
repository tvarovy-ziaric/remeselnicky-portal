# Portfolio publication and property-photo consent boundary

R1-018 keeps the editable PortfolioProject and its processed photo set private. A
public presentation is an independent append-only aggregate with explicit
`PUBLISH` and `HIDE` commands, optimistic revision checks and immutable full
photo snapshots.

Publishing copies each current private, metadata-stripped WebP thumbnail into
the `public-derivative` storage area. The database binds that derivative to the
exact project revision, photo-set revision, attachment, media asset and private
source object. Public URLs are HTTPS-only and are never part of the public
profile DTO; delivery resolves them through the server-only media route.

Only `SELF_DECLARED` projects can use this R1 path. This is intentional and
fail-closed: Job-linked photos require a purpose/version/actor/scope-bound
customer-consent workflow that does not exist until the R4 Job integration.
Completion, participation or a general privacy consent must never substitute
for that record.

Visibility is dynamic. A public project disappears if its owner/profile is no
longer effectively public, if the project or photo-set revision changes, if it
is archived/hidden, or if its public derivatives are revoked. `HIDE` commits
the database visibility change before storage cleanup. Failed storage/CDN
cleanup is observable and retryable; it cannot restore public eligibility.

The public projection excludes storage keys, hashes, EXIF capture time, exact
location, customer identity and consent internals. It exposes only the
allowlisted project fields and coarse municipality/district references.

## R4 completion contract

R4 must add a distinct Job-photo consent aggregate that stores the exact
optional-consent purpose, policy/text version, customer actor, timestamp and
approved media/project scope. New media outside that scope requires a new grant.
Withdrawal appends history and synchronously removes public delivery without
erasing retained private Job evidence. The final public profile intersection
must also apply collaborator acceptance and featured-project ordering without
letting either feature change visibility by itself.

# Private media delivery boundary (R0-020)

## Decision

Private object storage is never an authorization surface. A media UUID, storage
key, content hash or previously issued URL grants no durable access.

`@portal/media` exposes a server-only endpoint adapter for
`GET /v1/media/:mediaAssetId/download`. It receives only the authenticated
session user ID and requested media ID. Before it returns a short-lived redirect
it performs this sequence:

1. `@portal/db` reloads the current user, media asset and its linked
   `CANONICAL` storage object in one parameterized query.
2. The owning feature resolves current entity relations from its authoritative
   tables (invitation, Job participant, conversation, Quote, Change order,
   credential or dispute case). Request fields cannot create grants.
3. The deny-by-default policy requires an `ACTIVE` actor, `READY` asset,
   complete provenance, a non-revoked private canonical object, an allowlisted
   canonical content type and the exact role appropriate to the media purpose.
4. Storage issues a cross-origin HTTPS grant for at most 60 seconds with a
   server-selected safe content type and disposition.
5. The service repeats steps 1–3 and compares both snapshots before exposing
   the redirect. Account, relation, asset or object revocation racing issuance
   therefore fails closed. The small residual race after the final check is
   bounded by the grant TTL and must be covered by provider-side object
   revocation where immediate invalidation is required.

All authorization failures, missing objects, malformed IDs and private-file
IDOR attempts return the same `404 MEDIA_NOT_FOUND` envelope with
`Cache-Control: private, no-store`. Storage availability/signing failures use a
generic 503. Neither response nor the service has a logging hook for raw keys or
signed URLs; the shared observability redactor remains a second line of defense.

The initial PostgreSQL projection intentionally resolves only the actor, media
and storage object because R0 does not yet own the later feature relation
tables. Each feature must supply its narrow `MediaEntityAccessResolver` when it
adds those tables. An unrelated Job participant, invited provider on another
request, competitor, ordinary admin or incorrect contractual role receives no
grant.

## Safe response metadata

Private canonical delivery currently allows only `image/webp` and
`application/pdf`. Images use `inline`; documents use `attachment`. Storage
receives fixed server-selected filenames, never the uploaded display filename,
and must bind the response content type/disposition into its signed request.
Executable HTML/SVG/script content is not issued on the primary application
origin.

## Separate public portfolio path

`GET /v1/public/media/:mediaAssetId` is a separate resolver. It requires all of:

- a `READY` `PORTFOLIO_IMAGE`;
- explicit current `PUBLIC` publication state;
- a non-revoked `DETAIL` or `THUMBNAIL` object in the
  `public-derivative` area;
- canonical `image/webp` content and a safe HTTPS CDN URL.

There is deliberately no private-to-public promotion method in the delivery
service. Media processing and the portfolio publication command must create an
explicit public derivative and publication record first. Hide and moderation
commands re-read the non-public publication state, revoke the public object at
storage and conditionally persist revocation against the same publication
revision. Public responses have a short, revalidating cache policy; production
storage/CDN adapters must purge the derivative on revocation.

## Integration requirements for later tickets

- Register the two path constants in the API only with the corresponding
  private/public service; do not combine them into a generic media route.
- Derive `actorUserId` exclusively from the server session guard.
- Resolve entity grants from current database relations and include a revision
  that changes whenever access-bearing membership or visibility changes.
- Retry failed public CDN revocations; the application resolver already denies
  hidden/restricted publication independently of CDN state.
- Security telemetry may record opaque actor/asset IDs and a bounded outcome,
  but never storage keys, response `Location`, signed query parameters or file
  contents.

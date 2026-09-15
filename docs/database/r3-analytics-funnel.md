# R3 analytics persistence

Migration `0053_r3_analytics_funnel.sql` adds three separate append/history
boundaries:

- trusted traffic classification history (`REAL`, `INTERNAL`, `TEST`), with no
  marketplace-facing write API;
- privacy-minimal `r3.analytics.*` source effects in the existing durable
  outbox plus independent `r3_analytics_event_deliveries` leases;
- consent-gated first-view observation commands, whose actor, timestamp,
  subject class, Quote binding and bounded comparison count are authored or
  revalidated by PostgreSQL.

Source capture is atomic with the domain effect. Exact idempotency-key replay
must match event UUID when explicitly supplied, name, version, timestamp,
entity, payload and correlation; a mismatch aborts the transaction. Delivery
is a separate consumer effect and never changes global outbox state. Expired
leases can be reclaimed and always retain the same source UUID.

The observation guard shares the optional-consent advisory lock before reading
the latest consent. It also serializes on the request, current Quote and head so
withdraw/expiry cannot race a false view. `quote_revision_authoring_is_eligible`
provides the mode-exact structured/external intersection, including READY
private canonical PDF, provenance, hash and revocation checks. Comparison count
uses the same eligibility predicate and is clamped to the locked five-card UI
bound.

These tables contain no raw content, contact/address/coordinate data, amounts,
storage metadata or third-party identifiers. Provider retention and a real
transport remain later operational seams; disabled transport is explicit.

The authenticated UX route uses the existing auth rate-limit window and limit
as a route-level technical admission bound before repeated observation writes.
Invitation views require provider ownership and actual visible-page
observation. Chat attachment analytics is authored only on READY controlled
processing and exposes the bounded total/type bucket, never an asset ID or
filename.

The clean-PostgreSQL helper executes the current R3 command/effect seams,
version replay, both global-outbox/analytics-consumer orders, transient retry,
malformed terminal handling, exact invitation authorization, consent withdrawal
in both lock orders, and revoked external-PDF denial. It also runs a rolled-back
DECLINE effect probe without changing the shared fixture. The existing clean
fixture has no DB-clock-due invitation/request and no successful request
reactivation; therefore `invitation_expired`, `job_request_expired` and
`job_request_reactivated` are explicitly `NOT_EVALUATED` live in R3-021. Their
catalog/SQL branches are static-covered; a later clock-controlled lifecycle
fixture must add executable coverage without forging server timestamps.

# Transactional outbox and domain-event delivery

R0-022 implements the D25 reliability boundary with `@portal/outbox` and the
PostgreSQL adapter in `@portal/db`. A successful named command writes business
state and its domain events through the same database transaction. SMTP,
analytics vendors and other external delivery never execute inside that
business transaction and cannot roll it back.

## Event contract and privacy

Every producer defines a stable event name, positive schema version and exact
top-level payload-key allowlist with `defineDomainEvent`. Only events created by
such a definition can pass the command `OutboxWriter`. String values are limited
to privacy-safe machine values (opaque IDs, enums and ISO-like values) without
whitespace, email/URL separators or free-form content characters. Numeric,
boolean and null scalars plus bounded arrays of the same values are supported;
nested objects and common sensitive-content keys are rejected. PostgreSQL
independently enforces the same flat-value grammar and limits the event to at
most 64 keys and 8 KiB.

Event definitions must contain only the minimum opaque identifiers, enums,
booleans, counts or coarse buckets needed by registered consumers. Definitions
must never allow chat/message bodies, request descriptions, exact addresses or
coordinates, phone/email, filenames, document/review/dispute content,
credentials or tokens. A new key is a reviewed schema change, not an escape
hatch for serializing an entity. Domain events and D28 analytics events remain
different layers; an analytics consumer derives its explicit vendor-neutral
analytics schema from the domain event.

The durable envelope includes `event_id`, a producer idempotency key, stable
name/version, server timestamp, optional opaque entity reference, command name
and correlation ID. Idempotency, correlation and entity identifiers use the
same bounded safe-machine grammar; they cannot carry email addresses, bearer
tokens, prose or URLs around the payload allowlist. Neither an entity ID nor a
deep link grants authorization.

## Delivery state machine

Rows begin `PENDING`. A worker atomically claims one due row with
`FOR UPDATE SKIP LOCKED`, changes it to `PROCESSING`, increments the attempt and
sets a bounded lease. A crashed worker leaves an expiring lease; another worker
may reclaim it after expiration. Publish acknowledgement, retry and terminal
failure are compare-and-set updates requiring the current lease token, so a
stale worker cannot overwrite a newer attempt.

Publishing is intentionally **at least once**. The worker publishes before it
marks a row `PUBLISHED`; a crash between those operations causes another
delivery. Publishers pass both `event_id` and `idempotency_key` to transports
that support provider deduplication. Consumers use `createIdempotentConsumer`
with the PostgreSQL consumer-claim adapter: the `(consumer_name, event_id)`
claim and consumer database effect commit or roll back together. This prevents
duplicate database effects without pretending that arbitrary external side
effects can be exactly once.

Retry stores only a bounded safe error code. Exhausted or permanent failures
become `TERMINAL` and remain visible; payload or exception detail is never put
in operational telemetry. `snapshot()` exposes pending/processing backlog,
oldest backlog age and terminal count for R0-027 monitoring without
high-cardinality labels.

## Operational expectations

- Alert on sustained oldest-backlog age, expired leases and terminal delivery,
  with transactional delivery higher severity than best-effort analytics.
- Configure lease duration longer than the normal publish latency and use a
  bounded exponential retry policy in the worker composition root.
- Do not manually mutate delivery state. Diagnose the provider/consumer, then
  use an explicit audited replay tool in a later operations ticket.
- Retain events and consumer effects according to D27 purpose-specific policy;
  never cascade-delete the event history from a business entity.

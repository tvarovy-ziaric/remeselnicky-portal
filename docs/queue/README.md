# Queue and worker foundation

`@portal/queue` defines the provider-neutral queue contract, deterministic
retry processor, safe telemetry events, and an in-memory development/test
adapter. It does not define domain events, notifications, or a transactional
outbox; those are owned by later tickets.

## Delivery contract

Every producer supplies stable `jobId`, `eventId`, and `correlationId` values.
`jobId` is the enqueue idempotency key and stays unique after success or
terminal failure. Each delivery attempt receives a fresh `runId`. Handlers must
still use their stable event/job identity to make external side effects
idempotent: a queue provides at-least-once delivery, not magical exactly-once
effects. Domain/database state remains authoritative if delivery fails.

Jobs declare a finite `maxAttempts`. Retryable failures use bounded exponential
backoff. Non-retryable failures and exhausted retries move to a terminal state;
they are never silently retried forever. A durable adapter must atomically
implement `take`, `acknowledge`, `retry`, and `moveToTerminal` and retain the
same job-ID uniqueness guarantee.

## Privacy-safe observability

Telemetry events contain only job name, bounded error code, attempt/outcome,
timestamps, and stable job/run/event/correlation IDs. Payload and exception
message fields are deliberately absent. Queue snapshots expose depth, oldest
pending/in-flight age, successes, failed attempts, retry count, and terminal
failure count. Metrics exporters must not use high-cardinality IDs as labels;
those IDs belong only in structured logs/traces.

Alerts should cover growing depth/age, stuck in-flight work, retry spikes, and
every unexpected terminal failure. Terminal records intentionally omit payloads
and exception text; access to any provider-specific dead-letter payload store
must be protected and privacy-reviewed.

## Adapter boundary

`InMemoryQueue` is for deterministic tests and single-process development. It
must not back staging or production workloads. Media processing uses a durable
PostgreSQL adapter: asset creation and job creation share one transaction,
workers claim through bounded leases with `FOR UPDATE SKIP LOCKED`, and stale
attempts cannot acknowledge or rewrite a newer delivery. The adapter keeps
only opaque asset identity, kind and machine outcome metadata. Other queue
consumers may still adopt a different durable implementation without changing
the common handler contract; choosing or provisioning an external queue vendor
remains outside R0-021.

# Observability foundation

R0-026 establishes one provider-neutral error and logging boundary for the API,
web application and worker. It deliberately does not select an external vendor.
The `ErrorTrackerTransport` port can later forward the same minimized envelope to
an approved collector without changing domain code.

## Structured server records

`@portal/observability` is Node-only at its root export. Every JSON record has a
timestamp, level, event, service, environment and release revision. API records
also carry a request ID and a validated or server-generated correlation ID.
Queue telemetry retains its job, event, correlation and run IDs while using the
same logger. Telemetry destination failure is always best effort and must not
change a business outcome.

Arbitrary request bodies are never logged. Recursive redaction is a second line
of defense for credentials, tokens, cookies, database URLs, signed URLs,
email/phone values, exact-address keys and private content fields. Production
error reports omit messages and stack traces. Error responses contain only a
stable public code.

## Frontend errors

The explicit `@portal/observability/browser` entry has no server imports. Global
browser exceptions and the Next.js global render boundary emit only error class,
mechanism, a generated correlation ID, environment and web release. Messages,
stack traces, DOM, form values, URLs and user content are never captured.

Staging and production ingress route only the exact minimized frontend-error
path to the API. The browser sends no cookie credentials. The API schema rejects
extra fields, requires the exact configured application `Origin`, and fails
closed if its admission provider is unavailable. Production admission hashes the
route and transient source IP before using the shared PostgreSQL rate bucket; raw
IP is neither persisted in that bucket nor logged. Exceeding this telemetry-only
limit drops the signal without changing application behavior. The server attaches
its own deployment context before the central transport receives an admitted
signal.

## Metrics and health

R0-027 extends this boundary with bounded-cardinality HTTP, database and queue
metrics plus internal scrape/worker-health endpoints. The metric contract,
cluster resources, staging critical-channel procedure and runbook links are in
[`metrics-and-alerting.md`](metrics-and-alerting.md).

## Later integration

An external collector, retention settings, source-map upload and operational
access require infrastructure/provider configuration. Those can implement the
existing transport port; they must preserve the same minimization rules and keep
source maps private. Selecting an external alert receiver is likewise deferred
to the account/credential gate; R0-027 provides the provider-neutral staging
contract without committing a receiver URL.

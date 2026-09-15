# R3 demand-side HTTP security adapter

R3-022 Stage 2 verifies the existing R3 Fastify transport boundary. The adapter
runs the declarative actor, target-lineage and state matrix through a real
`buildApi` instance with the production session, CSRF, CORS, request-schema,
private-cache and error-normalization hooks enabled.

## Evidence boundary

The Fastify application is composed with actor-aware in-memory domain ports.
Those ports deliberately model exact-own, same-request competitor, foreign,
unknown and wrong-kind targets so the HTTP adapter cannot pass by switching on
actor role alone. They are not a substitute for repository authorization. The
Stage 1 live-PostgreSQL adapter remains the evidence for database object and
field authorization, private-media lineage and competitor isolation.

The current adapter evaluates 400 HTTP cases across these production routes:

- invitation detail;
- conversation identity and timeline;
- writable and terminal conversation message commands;
- current customer Quote comparison.

For each private response it checks `Cache-Control: no-store` and
`X-Robots-Tag: noindex, nofollow`. Denials must use the expected uniform
`NOT_FOUND`, `ACCOUNT_NOT_ACTIVE` or `CONVERSATION_READ_ONLY` shape without a
synthetic private canary. Each message command records effect counts and is
replayed without and with an invalid CSRF token, yielding no effect. Anonymous
probes use a valid anonymous CSRF session so commands reach the authentication
guard and return `AUTHENTICATION_REQUIRED`, rather than proving only an earlier
CSRF rejection. Credentialed CORS is checked for the configured origin and an
attacker origin.

A focused transport test covers Quote core and both authoring modes through the
production routes: exact provider/customer reads, provider-only draft creation,
structured and external-envelope saves, submission, competitor and suspended
account denial, writable-versus-terminal behavior, and missing/invalid CSRF
with unchanged effect counts. A second focused test covers Quote lifecycle
context, provider-only withdraw and reconfirm commands and the absence of a
public system-expiry route. Repository authorization remains Stage 1 evidence;
these focused tests prove the Fastify transport and composition boundary.

## Local composition now present

The API startup now composes private storage, purpose-bound JobRequest/chat/Quote
delivery, JobRequest/chat upload and Quote PDF upload. The worker composes the
durable image/document processor with a loopback-only active malware scanner.
Unit, static and real-session Fastify tests verify these local seams; this does
not substitute for a real S3-compatible provider, ClamAV signature update or
browser run.

## Explicitly not evaluated

The report retains this release seam as `NOT_EVALUATED`:

- browser/staging E2E.

The manual protected staging workflow and three-engine Playwright suite are
implemented but skip without explicit staging enablement, credentials and
synthetic fixture IDs. No paid staging stack exists, so no provider-backed
storage/scanner/network result or browser result is claimed.

R4 acceptance, Job creation, post-confirmation contact/address disclosure and
new lifecycle mutations remain outside R3-022.

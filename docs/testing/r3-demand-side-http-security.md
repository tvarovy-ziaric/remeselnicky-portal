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

A focused transport test also covers the already-existing Quote lifecycle
context, provider-only withdraw and reconfirm commands, suspended-provider
denial, CSRF no-effect behavior and the absence of a public system-expiry route.
It does not add or infer Quote authoring rules.

## Explicitly not evaluated

The report retains these production seams as `NOT_EVALUATED`:

- Quote core HTTP;
- platform-structured Quote authoring HTTP;
- external-PDF Quote authoring HTTP;
- production composition of private-media delivery;
- job-request private-media delivery;
- browser/staging E2E.

The repositories and media resolvers behind those boundaries have Stage 1
live-PostgreSQL coverage, but there are no corresponding composed production
HTTP endpoints for this adapter to exercise. The production API currently also
does not compose the existing private-media delivery port. Marking those rows as
passed would therefore be synthetic evidence. Browser and staging execution
remains follow-up work when those production seams and a browser fixture runner
exist.

R4 acceptance, Job creation, post-confirmation contact/address disclosure and
new lifecycle mutations remain outside R3-022.

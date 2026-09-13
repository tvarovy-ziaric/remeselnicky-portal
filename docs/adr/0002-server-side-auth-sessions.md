# ADR 0002: Server-side authentication sessions

- Status: Accepted
- Date: 2026-09-14
- Ticket: R0-009

## Context

The portal needs an invitation-only authentication baseline that can revoke access immediately when an account is suspended, deactivated, logged out, or password-reset. D02 and D26 require server authority, secure cookie handling, anti-enumeration controls, and mature password primitives.

## Decision

Authentication uses opaque, server-generated session identifiers in an HttpOnly cookie. PostgreSQL stores only the SHA-256 digest of the identifier and the minimal session payload (`_csrf` and the authenticated user ID). It is the authority for expiry and revocation; the client does not hold authorization claims.

The API uses Fastify 5 with `@fastify/cookie`, `@fastify/session`, `@fastify/csrf-protection`, `@fastify/cors`, and `@fastify/rate-limit`. Passwords use the maintained `argon2` package in Argon2id mode. Password-reset secrets are random 256-bit values; PostgreSQL stores only their SHA-256 digests.

Cookie policy is reconstructed from current runtime configuration whenever a session is restored. Persisted JSON cannot override HttpOnly, Secure, SameSite=Lax, Path=/, or add Domain. Production uses `__Host-portal.sid`; staging and production require Secure. Registration and login regenerate the session ID. Logout and password reset revoke server-side sessions.

Every active-only authorization check reloads current account state. A session payload must match its canonical persisted user ID or restoration fails closed.

Credentialed CORS accepts exactly `APP_ORIGIN`. Cookie-authenticated state-changing endpoints require a session-bound CSRF token. Shared PostgreSQL rate-limit buckets apply a wider IP ceiling and a narrower endpoint-plus-identity digest limit, avoiding plaintext identifiers and reducing shared-network harm.

## Operational boundaries

Registration eligibility is an injected port. The production bootstrap intentionally provides no eligibility adapter and therefore denies registration until the invitation workflow in R4-033 supplies one. Tests prove registration with an explicit allow adapter; no provisional invitation-token format is introduced.

Password-reset delivery is also injected. The production bootstrap returns a uniform 503 for reset requests until a durable delivery/outbox adapter is wired; it does not create undeliverable reset tokens. A delivery adapter must acknowledge only durable enqueueing, not wait for remote network delivery.

Known and unknown login failures use the same response and both run password verification. Reset requests use the same public response, a common Argon2 workload, a minimum response-time floor, and layered rate limiting. Logs, errors, rate-limit keys, cookies, reset tokens, passwords, and normalized email plaintext are kept outside persistence/log payloads except where credential lookup necessarily stores normalized email.

## Consequences

- Revocation and current account-state enforcement require a PostgreSQL read, prioritizing correct authority over stateless throughput.
- Multi-replica API deployments share session and rate-limit state without vendor-specific infrastructure.
- Availability of registration and password-reset delivery remains explicitly fail-closed until their later adapters are configured.
- Changing session-cookie security policy applies on the next restored response because stored payload cannot preserve stale flags.

# Authentication baseline

R0-009 exposes these versioned endpoints:

| Method | Path                              | Purpose                                                                                    |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------ |
| GET    | `/v1/auth/csrf`                   | Establish a pre-auth session and return its CSRF token.                                    |
| POST   | `/v1/auth/register`               | Register an explicitly eligible adult and regenerate the session.                          |
| POST   | `/v1/auth/login`                  | Authenticate and regenerate the session.                                                   |
| GET    | `/v1/auth/session`                | Resolve the session against current account state.                                         |
| POST   | `/v1/auth/logout`                 | Revoke the server session.                                                                 |
| POST   | `/v1/auth/password-reset-request` | Return a generic accepted response when delivery is configured.                            |
| POST   | `/v1/auth/password-reset`         | Atomically consume a reset token, replace the password hash, and revoke all user sessions. |

All POST endpoints require `x-csrf-token` bound to the submitted session cookie. Browser requests with credentials are accepted only from the exact configured application origin.

## Persistence and secrets

- Passwords are bounded before Argon2id work and are never stored or returned in plaintext.
- Session IDs and rate-limit identities are SHA-256 digests before PostgreSQL persistence.
- Reset tokens contain 256 random bits; only a digest is stored. Consumption is atomic and single-use. Issuance serializes per account so only the newest unconsumed token remains live.
- Password-reset consumption and revocation of all sessions occur in one database transaction.
- Authentication responses and thrown errors contain stable codes, never passwords, tokens, cookies, database URLs, or email plaintext.

## Account state and deployment defaults

An authenticated session is not evidence of a currently active account. Active-only use reloads the user and returns 403 for `SUSPENDED` or `DEACTIVATED` accounts; a missing, expired, revoked, or corrupt session returns 401.

The checked-in server bootstrap deliberately has no invitation eligibility implementation and denies registration. This preserves D01 until R4-033 wires the real invitation workflow. Tests inject an explicit allow adapter to exercise the successful registration path.

The checked-in bootstrap also has no password-reset delivery provider. Reset requests uniformly fail with 503 and persist no token until a durable delivery/outbox adapter is supplied. This avoids a misleading success for a token that a user could never receive.

## Cookie policy

- development: `portal.sid`, HttpOnly, SameSite=Lax, Path=/
- staging: `portal.sid` plus Secure
- production: `__Host-portal.sid` plus Secure
- no Domain attribute in any environment

Cookie security fields are rebuilt from runtime configuration and the canonical database expiry. Values embedded in a corrupt or stale JSON payload are ignored.

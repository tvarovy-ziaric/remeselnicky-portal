# Email verification security boundary

R0-010 implements email verification as a server-authoritative credential fact,
not as a client or session flag. `auth_credentials.email_verified_at` remains
nullable until a valid challenge is consumed. Authenticated session responses
derive `emailVerified` from that database value on every guarded request, so an
old browser tab cannot grant itself verified capabilities.

## Challenge lifecycle

- A challenge contains 32 cryptographically random bytes encoded as base64url.
- Only its SHA-256 digest crosses the persistence boundary and is stored in
  `email_verification_tokens`; plaintext is passed only to the delivery port.
- Issuing a replacement serializes on the credential row, invalidates the prior
  live challenge and inserts one new challenge in the same transaction.
- Consumption is an atomic conditional update. Expired, consumed, superseded,
  unknown and non-active-account challenges all return the same invalid result.
- A successful consume writes the DB timestamp and exactly one concurrent
  consumer can succeed. Challenges and verification history are not hard
  deleted by normal application behavior.

## HTTP boundary

`POST /v1/auth/email-verification` accepts the opaque token. It is CSRF
protected, receives the shared IP-oriented auth limit, and returns the same
bounded error for invalid, expired, replayed and valid-shape tampered tokens.

`POST /v1/auth/email-verification/resend` requires an authenticated `ACTIVE`
user, CSRF protection and both the shared auth/IP limit and a database-backed
per-account limit. It always returns the same accepted response for eligible
unverified and already-verified accounts. The alpha defaults are three resends
per 15 minutes and a 24-hour token lifetime; these are internal, reversible
abuse-control values because D26 defers exact thresholds to implementation
tuning.

The delivery adapter must durably accept a message before resolving. Delivery
is not domain authority: only consuming the DB challenge verifies an email. If
no adapter is wired, resend fails closed before creating an undeliverable token.
R0-021/R0-022 may later connect this port to the durable notification path
without changing verification semantics.

Logs, errors, analytics and responses must never contain the plaintext token or
normalized email. Delivery failure telemetry belongs to the adapter and must
use bounded identifiers rather than payload content.

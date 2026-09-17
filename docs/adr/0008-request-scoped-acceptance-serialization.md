# ADR 0008 — Request-scoped serialization for Quote acceptance

Status: Accepted (R4-002 foundation, 2026-09-16)

## Context

The invitation and request command paths already serialize writes for a
`JobRequest` with `pg_advisory_xact_lock(hashtextextended(jobRequestId::text,
41007))`. Quote core/lifecycle writes previously locked actor, invitation and
Quote rows without taking that request lock. A future `acceptQuote` transaction
must race safely against submission, withdrawal, expiry, cancellation and
competing acceptance without taking those locks in the opposite order.

## Decision

Every new Quote core/lifecycle state command takes the request-scoped advisory
lock before actor/invitation/conversation/Quote row locks. Application command
paths take it explicitly; migration `0056` also places an early database
trigger before the existing command guards, so direct SQL follows the same
order. The expiry sweeper selects bounded candidates without pre-locking an
invitation row and then serializes each transition under the request lock.
The internal acceptance transaction takes the same lock before rechecking
authorization, exact revision, validity, provider qualification and snapshot
preconditions. It writes the Job, immutable agreement snapshot, accepted and
losing Quote events, losing invitation revisions and neutral outbox messages
inside one database transaction. A failed closeout rolls the entire attempt
back. Same-command retries return the accepted Job; command-ID intent reuse
conflicts. The guarded HTTP handler is registered for the isolated synthetic
Web Alpha; it requires an ACTIVE session, CSRF, exact revisions and explicit
confirmation, and rate-limits private no-store responses.

The `jobs.job_request_id` unique constraint is the independent final database
barrier against two primary Jobs, even if application locking is bypassed.
The route is exercised only with synthetic identities through the temporary
Basic-Auth-protected Quick Tunnel; this does not authorize real-user rollout.

## Consequences and verification

Commands on one request serialize, while independent requests remain
concurrent. A stalled transaction may increase latency for one request;
bounded command timeouts and retry handling belong in the completed R4-002
transport. Clean PostGIS migrations `0000`–`0062`, repeat migration, current
R0–R3 integration scenarios, immutable Job/Quote/PDF/qualification effects,
the explicit immutable acceptance audit event, forced mid-closeout rollback
and a concurrent request-lock timeout passed in an isolated disposable
database. A separate committed-winner test proved that a second connection
waits on the advisory lock, then sees the committed Job and cannot create a
second one; exactly one acceptance audit event and agreement/qualification
snapshot persisted. Separate two-connection tests proved that a provider
suspension and a newly required credential policy committed while acceptance
waited on their respective locks both block Job creation. An approved
credential was also revoked by the MFA-backed review command while acceptance
waited on its claim row; acceptance then rejected it. That test exposed a
deadlock: `FOR UPDATE` on the provider profile blocked the revocation
command's foreign-key `KEY SHARE` lock after it held the claim row. The
acceptance profile lock is now `FOR NO KEY UPDATE`, preserving serialization
against profile mutation without conflicting with that reference lock.
The handler's validation, session actor, CSRF, rate-limit, private response and
error-mapping tests pass. Clean PostGIS through migration `0066` and public
Chromium acceptance proved one Job, idempotent replay, competitor closeout,
primary-party-only contact unlock and winning-conversation continuity. The
owner-only recap control requires a separate explicit click. Material
post-confirm location changes remain outside this decision and need a
separate auditable workflow before real-user launch.

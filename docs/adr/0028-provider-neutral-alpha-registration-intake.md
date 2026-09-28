# ADR 0028: Provider-neutral invitation-only Alpha registration intake

- Status: Accepted locally; production operation is human-gated
- Date: 2026-09-28
- Ticket: R4-033 production invite-only rollout controls

## Context

D01 makes account creation and marketplace participation invitation-only while
keeping public profiles and search anonymous. D30 requires invite issuance to
act as an operational throttle and requires new-user intake to pause without
breaking existing accounts or Jobs. Production launch, the first real cohort,
provider accounts, credentials and real administrator MFA remain HUMAN GATES.

The existing registration eligibility seam was sufficient for a signed local
synthetic fixture, but a precheck followed by a separate user insert could not
provide a one-time production admission invariant. It also had no durable,
auditable global `OPEN`/`PAUSED` state or provider-neutral issuance history.

## Decision

Registration admission is a single server-side port. The PostgreSQL adapter
atomically performs all of the following in one transaction:

1. serializes against the current global intake state;
2. requires the state to be `OPEN`;
3. locks one matching, unexpired, unrevoked and unclaimed invitation;
4. creates the user and credential; and
5. writes the immutable one-time invitation claim.

Any failure rolls back both account creation and the claim. Duplicate email,
missing invitation, expired/revoked/claimed invitation and paused intake do
not expose invitation existence through the public registration result.

Invitation history stores a domain-separated HMAC-SHA-256 digest of the
normalized email, never the plaintext email or a reusable bearer token. The
key is a dedicated 256-bit runtime secret. Delivery remains a separate provider
port: this decision neither selects a vendor nor authorizes real delivery.

The intake state, invitation, revocation and claim tables are append-only. The
initial migration state is `PAUSED`, so configuration or provider absence
cannot accidentally open registration. Pausing affects only new account
creation; it does not suspend users, terminate sessions or mutate existing
Jobs.

Provider-neutral administrative routes support status read, state change,
invitation issuance and revocation. Every route requires an ACTIVE portal
session, `admin.users.manage`, recent MFA and private no-store responses;
mutations also require CSRF protection and idempotent command IDs. Issuance
normalizes the email server-side and returns only invitation ID, expiry and
command status. It never returns the email, its digest or the HMAC key.

The routes are optional dependencies of the authentication module. The current
production start path does not provide a real admin-access service, enrolled
administrator or intake operations, so the routes remain unregistered and
fail closed until the corresponding HUMAN GATES are satisfied.

## Concurrency and recovery properties

- A transaction-scoped advisory lock serializes intake state change, issuance
  and registration admission around the current state.
- Row locks and unique claim constraints make an invitation single-use under
  concurrent registration attempts.
- Command IDs are payload-bound; an exact replay is deduplicated while reuse
  with different input is rejected.
- Append-only history supports audit and rollback/forward-fix analysis. A
  release rollback must not delete issuance or claim history.
- The pause command is the safe containment action for new-user intake. It is
  not a general platform kill switch and does not alter existing work.

## Verification and boundaries

A clean tmpfs PostgreSQL/PostGIS database applied and replayed all 116
migrations. Integration coverage verifies fail-closed initial state,
open/pause transitions, idempotent issuance, one-time claim, revocation,
duplicate-email rollback, append-only storage and absence of plaintext email
columns. API tests cover recent-MFA authorization, CSRF, strict bodies,
normalization, privacy-safe output, stale state and idempotency conflict.

This evidence is local and synthetic. It does not prove provider-managed
staging, real MFA enrollment, real invitation delivery, production smoke,
rollback execution, operating ownership or D30 go/no-go. Those remain explicit
HUMAN GATES, and the production decision remains `NO-GO`.

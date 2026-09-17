# ADR 0011: Primary Job-party contact projection after confirmation

- Status: Accepted for R4-004 synthetic Web Alpha
- Date: 2026-09-16
- Ticket: R4-004

## Context

D02/D07/D16 hide phone, email and exact work location before Job creation,
then allow the customer and primary provider to use them for confirmed-Job
execution. D26 requires object and field authorization on the server, not a
frontend visibility switch. Later Job participants do not automatically gain
bilateral contact access.

## Decision

The contact read model requires an existing `CONFIRMED` Job, its acceptance
event and immutable agreement snapshot, an ACTIVE viewing User, and exact
ownership of either the Job's CustomerProfile or primary CraftsmanProfile.
It reads current verified contact credentials for both primary parties and
the current immutable Job-location revision. Its initial revision is captured
from the accepted request snapshot in the Job-creation transaction.
Missing/malformed location data fails closed. Competitors, unrelated customers
and generic Job participants have no access through this projection.

The accepted snapshot is never rewritten when execution location changes.
Migration `0065` creates the initial history row and two immutable,
privacy-minimal Job system events (`JOB_CONFIRMED` and
`CONTACT_ADDRESS_UNLOCKED`) atomically with acceptance. Direct inserts and
history mutations are denied. A separate material-change workflow remains
before real-user rollout; the acceptance UI is enabled only for synthetic
Web Alpha testing. A read-only, session-guarded
`GET /v1/me/jobs/:jobId/contacts` endpoint exposes this projection only to
the two primary parties after the committed unlock event. It rate-limits
requests, sends no-store/no-index responses and returns the same 404 for
unknown and unauthorized Jobs. Sensitive values must not appear in timeline
events, notifications, public projections or logs.

Migration `0066` adds an immutable, customer-authorized clarification command
for missing private work-location details. It checks an ACTIVE, verified
customer owner, the confirmed Job and unlock event, the exact current location
revision, and the accepted municipality in one transaction. Only null details
may be filled; already present address, map pin and clarification cannot be
silently replaced. Every successful command records the actor, reason,
server-generated time and a new location revision; a command ID can be
replayed only for the identical intent. A customer who needs to change an
existing location or municipality must use a separately agreed, auditable
material-change workflow, not this clarification command. The HTTP POST
derives its actor from the session and requires CSRF, rate limiting and strict
nested-field validation. The contact read includes the location revision for
safe optimistic concurrency.

The same additive clarification command can run as a nested savepoint inside
the final Quote-acceptance transaction when the customer supplies an exact
address at final confirmation. It takes the accepted request municipality
from the generated initial Job location, never from a client-supplied
municipality, and leaves the agreement snapshot untouched. A conflicting
pre-existing exact address aborts the whole acceptance. The optional address
is part of the acceptance idempotency fingerprint. The guarded acceptance
control is now exposed on the temporary synthetic-only Quick Tunnel.

## Verification

Pure parsing/SQL-boundary tests and clean PostGIS integration through `0065`
cover both primary parties, competitor denial, unknown Job denial,
suspended-viewer denial, the accepted initial address, two exact system events,
and rejected direct location/event mutations. The HTTP route has unit tests
for session derivation, inactive/anonymous denial, uniform 404, malformed IDs,
private cache headers and error redaction. Migration `0065` is also applied
on the synthetic Quick Tunnel alpha; the public browser regression passed 23
cases with four intentional skips.
The read-only route is deployed to the synthetic alpha. Public smoke confirms
the Basic Auth and portal-session gates; the existing PostGIS integration
continues to cover positive primary-party reads and competitor denial.
Clean PostGIS integration through `0066` proves additive revision creation,
accepted-snapshot preservation, primary-party projection, provider and direct
SQL denial, immutable command/history rows, stale-revision rejection,
idempotent replay and a committed two-connection race. Focused HTTP tests
cover CSRF, inactive/anonymous denial, extra nested fields and redacted errors.
The synthetic alpha applied `0066` after an isolated backup/restore rehearsal;
public smoke and the full 23-pass/four-intentional-skip browser suite remain
green. The public contact GET and clarification POST both deny a Basic-Auth
visitor without a portal session (401, no-store). A public positive confirmed-
Job E2E subsequently passed: customer and winning provider read the exact
address, a competitor received 404, and the accepted agreement stayed fixed.

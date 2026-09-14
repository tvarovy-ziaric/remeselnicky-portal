# JobRequest core (R3-001)

Migration `0036_job_request_core.sql` introduces the private, customer-owned
`JobRequest` identity and immutable state history. The only initialized state is
`DRAFT`; the explicit forward transition is `DRAFT -> ACTIVE`. State, revision,
activation time, and change time are server-authored and projected through
`current_job_requests`. Normal operation cannot update or delete identity,
command, or revision history.

Draft creation is an explicit idempotent command. The repository locks and
rechecks the active authenticated actor and their private `CustomerProfile`
before replaying a command. A command UUID reused for different authority or
intent is a collision, while an exact retry returns its original revision.
Concurrent retries serialize on the command UUID.

Activation is deliberately fail-closed in R3-001. The database function
`job_request_missing_submission_requirements(request_id, revision)` currently
returns `PRIMARY_PROFESSION`, `DESCRIPTION`, and `MUNICIPALITY` for every draft.
R3-004 must replace that body with validation over its authoritative,
revisioned content. Both repository and database trigger require an empty result
for the exact draft revision; no browser/client readiness flag or token exists.
This prevents an empty draft from becoming active while keeping the state
machine ready for later content work.

R3-001 does not add autosave, anonymous/auth-boundary draft transfer, request
content fields, media attachments, active-request limits, expiry, invitations,
or public projections. Those remain owned by their sequenced R3 tickets.

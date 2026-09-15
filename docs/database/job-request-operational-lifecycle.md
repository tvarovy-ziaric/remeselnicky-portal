# JobRequest operational lifecycle

R3-006 extends the immutable JobRequest command/revision ledger with explicit
`EXTEND`, system `EXPIRE`, `REACTIVATE`, and owner `CANCEL` commands. A request
is never deleted or rewritten when it becomes inactive. Cancellation stores
only a bounded reason enum; invitation and quote closure will be implemented by
their own later state machines and must reference this authoritative event.

## Runtime policy

`job_request_runtime_policy` is a singleton, offline-operated policy record. It
defaults to five simultaneous `ACTIVE` requests per customer and 30 days of
inactivity, with a seven-day warning lead. All values are reversible
operational configuration, not client input. There is no owner or public
mutation API for the policy.

The active limit is serialized with a customer-scoped advisory transaction
lock and checked again by PostgreSQL. Drafts, expired requests, and cancelled
requests do not consume the limit. The application performs the same check to
return `ACTIVE_LIMIT_REACHED` without translating a database exception into a
generic failure.

Expiry is calculated from authoritative lifecycle/content activity. A worker
calls the server-only `expireInactive()` port; clients cannot author system
expiry commands. Extension is allowed only before expiry. Reactivation requires
the latest active content to remain submission-ready and consumes an active
slot again.

## Duplication

Duplication loads only the current normalized content snapshot of an owned
request and writes a new independent `DRAFT` identity through the existing
draft command/revision ledger. It does not copy command history, lifecycle
history, media references, invitation IDs, quotes, conversations, or future
transactional state. Media must be uploaded again so its private provenance is
bound to the new request identity.
The outward endpoint returns only the new draft ID, revision, and command
status; copied private content is recovered through the existing owner-only
draft endpoint.

All owner commands require an active authenticated account, exact ownership,
CSRF protection at HTTP boundaries, command-ID idempotency, and optimistic
revision checks. Responses are `no-store` and `noindex`.

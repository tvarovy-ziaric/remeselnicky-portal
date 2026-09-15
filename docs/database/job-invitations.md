# Job invitation lifecycle

R3-007 introduces one immutable `JobInvitation` lineage for each
`JobRequest + CraftsmanProfile` pair. It is a private, customer-selected
relationship, never a public job-board application or a broadcast.

## Authoritative invariants

- A send pins the current immutable request content revision and customer-visible
  version. Later material edits do not rewrite that provenance.
- The target must currently be an effectively public, approved profile owned by
  another active user. Every current `REQUIRED` qualification policy for the
  request's primary profession must have matching approved, non-expired public
  credential evidence.
- A request may have at most five simultaneous `PENDING + ENGAGED` invitations.
  The value lives in a singleton server policy row and is serialized per request;
  shortlist size is unrelated.
- The `(job_request_id, craftsman_profile_id)` identity is globally unique, so a
  declined, expired or withdrawn provider cannot be repeatedly invited again.
- Craftsman engagement, decline and withdrawal require the invited profile's
  active owner with both email and phone verified. Customer commands require the
  active verified request owner. IDs alone never authorize a command.
- `PENDING` may become `ENGAGED`, `DECLINED`, `EXPIRED` or customer-withdrawn.
  `ENGAGED` may become customer-not-selected or craftsman-withdrawn. A request
  cancellation/expiry closes every still-active invitation as `WITHDRAWN` in the
  same transaction. Quote acceptance will use the reserved system `NOT_SELECT`
  command in its own ticket.
- Decline context is optional, bounded and rejects contact/URL-shaped content.
  A decline is a normal outcome and this model exposes no reputation mutation.

Commands and revisions are append-only. Every command has exactly one revision
effect, optimistic expected revision and a SHA-256 intent fingerprint. Exact
retries return the original historical result; command-ID reuse for another
intent fails closed.

## Runtime work

`expirePending()` claims at most 100 due invitations with row locks and appends
system-only `EXPIRE` commands. The deployed worker schedules this operation;
opening/view telemetry remains an event, not a business state. R3-008 owns
candidate-list selection and the customer invitation API, and R3-010 owns
participant-facing lifecycle UX.

No invitation read model exposes competitor identities or counts. Later private
request/conversation serializers must resolve one concrete invitation and apply
the pre-confirmation exact-address/contact boundary again.

## Customer selection boundary

R3-008 exposes one authenticated command at
`POST /v1/me/job-requests/:jobRequestId/invitations`. Its body contains only a
client-generated command UUID and the explicitly selected public
`CraftsmanProfile` UUID. Search rank, badges, qualification claims, distance and
other card facts are never accepted as command authority.

The route is CSRF protected, rate limited and private/no-store. The repository
revalidates the active verified customer, ownership and current active request,
then rechecks the target's PUBLIC/approved/non-suspended state, exact regulated
qualification and simultaneous-active limit in the write transaction. Unknown,
hidden and newly ineligible targets share the same outward `404` response. The
candidate page only renders this action when it carries a canonical active
request identifier; it never auto-invites a result or turns search into a public
job board.

## Transactional notifications and reminders

Migration `0043_job_invitation_notifications.sql` captures a privacy-minimal
outbox event in the same transaction as every `SEND` and `EXPIRE` revision.
`SEND` maps to an `IMPORTANT` in-app + email notification for the invited
craftsman. `EXPIRE` maps to a non-urgent in-app notification for the customer.
Notification delivery never controls or rolls back invitation state.

The worker periodically calls `enqueueDueReminders()`. PostgreSQL selects only
current `PENDING` invitations whose deadline is inside the offline-configured
`job_invitation_runtime_policy.warning_lead_days` window. A stable outbox
idempotency key allows at most one expiry reminder for an invitation even when
workers overlap or restart. Setting the warning lead to zero disables reminders;
the timing is operational policy rather than a domain constant.

Outbox payloads contain only the recipient UUID, invitation revision and, for
reminder validation, a canonical UTC expiry timestamp. Rendered notification
payloads omit the timestamp and contain no request description, exact address,
contact, decline note, competing provider or commercial data. The deep link is
an opaque invitation path and must re-run current authorization when R3-010
renders it.

The PostgreSQL outbox worker creates the canonical in-app record plus an
idempotent queued email delivery. Until a production email provider/account is
selected, the delivery row remains queued; it is not silently discarded or
falsely marked delivered. Provider selection and credentials remain an explicit
production HUMAN GATE.

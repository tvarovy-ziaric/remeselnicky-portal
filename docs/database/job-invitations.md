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
system-only `EXPIRE` commands. R3-009 will schedule this worker and deliver
reminders/notifications; opening/view telemetry remains an event, not a business
state. R3-008 owns candidate-list selection and the customer invitation API, and
R3-010 owns participant-facing lifecycle UX.

No invitation read model exposes competitor identities or counts. Later private
request/conversation serializers must resolve one concrete invitation and apply
the pre-confirmation exact-address/contact boundary again.

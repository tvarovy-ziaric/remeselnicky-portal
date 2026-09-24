# ADR 0024: Audited named admin dispute and Job exception commands

- Status: Accepted for the Web Alpha implementation
- Tickets: R4-022
- Locked references: D22, D23, D26, D30

## Context

Administrators need to operate a private dispute case, inspect its relevant Job
conversation, and exceptionally close a Job. Those operations touch private
communications and durable marketplace history. A generic status editor or a
normal user session would erase important provenance and could turn an
operational intervention into apparent party consent.

The real MFA provider and first enrolled administrator remain external-access
gates under ADR 0005. The application and persistence boundary must still be
complete and testable before that gate is opened.

## Decision

Implement only named commands: start review, request information, add a private
internal note, record an operational outcome, close and reopen a dispute, plus
separate force-complete and force-cancel Job commands. There is no generic
`set status` operation. Each command carries an idempotency identity, exact
expected state, recent MFA-backed privileged session, safe internal reason and
a matching immutable audit event in the same transaction.

User-facing request and outcome text is stored separately from the audit
reason and private internal note. Outcome categories avoid fault or liability
labels. A dispute transition never changes a Job, accepted Quote, approved
Change order, payment fact, review or reputation. Force-complete never becomes
customer acceptance, and force-cancel has its own administrative provenance
and user-facing reason.

The capability-filtered admin shell marks only the implemented dispute and Job
modules as operational. Its dispute work surface requires a stated access
purpose before detail retrieval and exposes named action forms. Its Job work
surface presents force-complete and force-cancel as separate confirmed forms
with exact expected-state comparison; there is no arbitrary state selector.
All response payloads are parsed against bounded allowlists in the browser.

Reading the relevant winning Job conversation is a distinct sensitive access:
the caller supplies an access identity and safe reason in a POST body, the
backend reauthorizes `admin.disputes.manage` with recent MFA, and an immutable
`DISPUTE_INVESTIGATION` audit record is written before private messages and
attachments are returned. There is no all-chat browsing endpoint. User case
detail projects only requests addressed to that viewer and the operational
outcome; internal notes and audit reasons are never included.

Routes remain dependency-injected and unregistered by the production startup
until an authorized real MFA adapter and enrolled admin exist. Test adapters
exercise the same ports without weakening that gate.

## Consequences

- Retries are deterministic and stale state is rejected rather than silently
  reinterpreted.
- Reopening preserves the previous outcome and full transition history.
- A missed reply deadline remains only a process fact.
- Significant actions emit privacy-minimal notifications without request,
  outcome, note, conversation or audit text in the outbox payload.
- Real admin enrollment, production credential selection and first real-user
  use remain explicit human gates; the local capability is not a launch
  authorization.

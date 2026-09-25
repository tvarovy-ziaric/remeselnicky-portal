# Privacy and compliance scaffolding

R0-030 provides server-only primitives for the D27 privacy architecture. It is
not a legal-policy decision and it deliberately does not automate an export,
erasure, account deletion, or retention cleanup.

## Data classification

Every server-owned field starts as `PRIVATE`. A bounded `field` code (at most
64 characters) and `purposeCode` (at most 96 characters) must be registered
with one of these classifications:

| Classification          | Convention                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `PUBLIC`                | Explicit allowlisted projection intended for unauthenticated display. `publicProjection` must be true. |
| `INTERNAL`              | Operational data exposed only to an authorized internal workflow.                                      |
| `PRIVATE`               | Default for account, job, message, media, contact, and location data.                                  |
| `SENSITIVE_OPERATIONAL` | Credentials, security signals, moderation evidence, and comparable restricted operations data.         |

A public API/view must select only registered `PUBLIC` projection fields. A
table, object-storage key, asset UUID, or a field's presence in an internal DTO
does not make it public. Derived public media remains governed by its explicit
publication/moderation state; private originals are not promoted implicitly.

## Policies and optional consent

`privacy_policy_versions` is append-only and stores a version label, content
SHA-256, review state, effective timestamp, and predecessor. Content itself
belongs in the reviewed policy-document system rather than this ledger.
`OPTIONAL_CONSENT_TEXT` is bound to exactly one optional purpose. A consent
event is accepted only against an approved, effective policy for that exact
purpose.

The only consent purposes in this scaffold are portfolio property-photo
publication, non-essential analytics, and marketing email. Contract
performance, account operation, security, fraud prevention, and legitimate
interests must be represented in the purpose/legal-basis register and must
never be relabelled as consent. Consent history is append-only: revision 1 is a
grant, later revisions are contiguous alternating grant/withdrawal events, and
withdrawal never overwrites the earlier grant.

## Retention policy gate

All D27 retention categories are seeded at version 1 with no duration,
`UNRESOLVED` legal review, and `BLOCKED` launch state. This is the production
default. Versions form one serialized, contiguous chain per category; a new
version must supersede the current head. `requireExecutableRetentionPolicy`
fails closed until a later reviewed version contains a concrete duration,
legal approval, and explicit launch readiness.

No worker may substitute an application default when this gate rejects. Exact
durations, trigger dates, litigation/security holds, backup propagation,
processor deletion, and category-specific exceptions remain launch/legal
inputs. They must be reviewed before any cleanup automation is added.

## Privacy-request cases and account closure

Cases represent access, rectification, erasure, restriction, portability,
objection, and account-closure workflows. Their append-only events support
identity verification, review, action, completion, and rejection states with
server timestamps and optimistic revisions. Action codes are bounded metadata;
request bodies, identity documents, exported personal data, and evidence must
not be stored in this ledger or logged.

`ACCOUNT_CLOSURE` is a case type, not a cascade delete. Existing account state
can be changed to `DEACTIVATED` while the stable User row and required
transactional/audit provenance remain referenced. A future reviewed workflow
must evaluate erasure, anonymisation, restriction, retention, disputes,
security evidence, backups, and third-party propagation category by category.
There is intentionally no raw database-dump export or generic delete API.

## Audit projection and retries

The privacy tables are the authoritative business ledger. The audit port is a
minimized secondary projection invoked after the privacy transaction commits;
it is not an atomic participant and it is never a second authority for consent
or request state. Projection payloads contain stable IDs and bounded outcome
codes, not request content or evidence.

If audit projection is unavailable, the service returns a retryable failure
after the authoritative append. Retrying the same command with the same event
ID deduplicates the privacy append and retries the audit projection. Audit
adapters must therefore be idempotent by event ID; a durable outbox adapter may
be introduced without changing this contract. Operators must never repair an
audit outage by rewriting or deleting privacy history.

## R4-026 disposition orchestration

Migration `0111_privacy_disposition_jobs.sql` advances the scaffold without
inventing legal policy. A reviewed `DELETE` or `ANONYMIZE` category decision
atomically creates an immutable recovery tombstone and a lease-based job with
the exact same identity. Existing current `READY` heads are backfilled during
upgrade; an obsolete historical decision is never reactivated.

The queue remains fail-closed until a provider-neutral independent recovery
ledger returns a receipt for the tombstone. Only the receipt digest and bounded
ledger code are stored locally. Claims, retryable failures, terminal failures
and completion append category disposition events atomically. Leases are
bounded, stale acknowledgements fail, and an expired last attempt becomes an
explicit `LEASE_EXPIRED` terminal result instead of an indefinitely ambiguous
processing state.

Migration `0112_privacy_notification_delivery_disposition.sql` adds the first
dedicated executor. For an exact receipt-gated `NOTIFICATION_DELIVERY` job it
deletes only provider-delivery metadata owned by the subject, preserves the
canonical in-app notification, and records an immutable execution receipt with
counts and a deterministic digest but no message content, recipient address or
provider reference. A committed receipt makes retry after a crash before queue
acknowledgement idempotent; the lease reaper completes the exact job instead of
executing it twice.

Every other category still needs a reviewed policy and an idempotent dedicated
executor; unsupported categories terminate explicitly as non-executable. The
independent ledger adapter, credentials and production recovery reapplicator
remain external provisioning HUMAN GATES. See
[ADR 0026](../adr/0026-privacy-disposition-jobs-and-recovery-tombstones.md).

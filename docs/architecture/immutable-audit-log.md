# Immutable admin and security audit log

Status: R0-024 foundation. Product authority remains locked D23, D26 and D27.

## Boundary

`@portal/audit` is server-only. It accepts a current `PrivilegedActor` produced
by the MFA-backed admin authorization service and checks that the exact audited
capability is present before constructing authenticated actor provenance.
Client DTOs, email-domain claims and frontend role flags are not audit actors.

The package exposes three append commands, not generic CRUD:

- privileged command (reason required, optional safe state diff),
- sensitive access (reason, fixed purpose and stable case/context required),
- minimized security event (authenticated admin or stable system actor).

There is deliberately no ordinary edit/delete API and no generic admin audit
export/list surface. Later investigation UI must add its own capability and
field-level projection rather than treating audit storage as permission to see
all internal data.

## Minimized event envelope

Every record carries stable event and correlation UUIDs, actor, dotted action
taxonomy, target type/reference and a database-owned timestamp. Privileged and
sensitive events require a trimmed reason. Reasons are bounded and reject
obvious email, phone, URL and bearer-token material; operators should cite a
stable case reference instead of copying chat, contact, address, document or
credential content.

Before/after changes are limited in TypeScript and PostgreSQL to a small fixed
field allowlist. Values can only be null, boolean, a bounded integer or an
uppercase symbolic state. Arbitrary keys, nested structures and free text are
rejected. Expanding the allowlist requires a reviewed schema and migration
change; a caller cannot opt a field in dynamically.

Sensitive access additionally records one fixed operational purpose and a
stable context reference. It does not copy the accessed value. This is distinct
from debug/application logging as required by D26.

## Immutability, transactions and deduplication

`audit_events.event_id` is the idempotency identity. Concurrent repeats with
the same semantic envelope return the original database timestamp; reuse of an
event ID for different content fails closed. PostgreSQL overrides any supplied
`occurred_at` during insert and rejects every ordinary `UPDATE` or `DELETE` via
an append-only trigger. Database ownership/backup controls remain necessary;
UI immutability is not a recovery mechanism.

The R0-012 `admin_role_change_events` table remains the authoritative role
change ledger. Migration `0011` installs an `AFTER INSERT` trigger that mirrors
each role event into `audit_events` with the same event ID and a unique source
foreign key. The role mutation, source event and unified audit row therefore
commit or roll back together; application code does not perform ambiguous dual
writes. Existing role events are backfilled with their original DB timestamp;
if a legacy reason fails the new minimization rule, the unified row records a
safe withholding marker and retains a source reference rather than copying that
content. Because R0-012 predates the stricter minimized-reason rule, a new
unsafe role-change reason currently surfaces as a generic persistence failure
and the entire grant/revocation is rolled back. A later admin command UI may
validate the same rule earlier for friendlier UX, but it must not weaken
fail-closed DB enforcement.

Other admin domain repositories can bind `createAuditRepository` to their
database transaction and append before commit. They must only return success
after the business mutation and audit append both succeed.

## D27 lifecycle

Actor, target and context are stable references rather than copied identity or
content. Account closure must not cascade-delete audit provenance. This is
retention/anonymization-ready, not a claim of perpetual retention or of
completed erasure semantics. Concrete audit/security retention periods, lawful
basis, anonymization/tombstone transformation and authorized export are owned
by the D27 policy workflow and require the pre-production legal review. Backups
must reapply later deletion/anonymization state during restore.

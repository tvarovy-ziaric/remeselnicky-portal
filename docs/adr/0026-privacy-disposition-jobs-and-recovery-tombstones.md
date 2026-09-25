# ADR 0026: Per-category privacy disposition jobs and recovery tombstones

- Status: Accepted
- Date: 2026-09-25
- Locked references: D27.82–96, D27.106–136, D27.184–202
- Implementation: migrations `0111_privacy_disposition_jobs.sql`,
  `0112_privacy_notification_delivery_disposition.sql` and
  `0113_privacy_restore_reapplication.sql`

## Context

D27 requires account closure and erasure to evaluate every data category
independently. Deletion and anonymization must be resumable and idempotent,
partial failure must remain explicit, and a disaster restore must not resurrect
data that was already deleted or anonymized. The exact retention periods,
lawful bases and category-specific legal exceptions are launch inputs that the
product specification deliberately leaves to legal review.

A generic cascade delete, an in-memory queue, or a tombstone stored only in the
same database cannot satisfy those requirements. A database restore could lose
the local deletion state together with the data it governs. Conversely, a
worker must not execute an unreviewed retention decision merely because a job
row exists.

## Decision

1. A recent-MFA administrator first records an immutable, category-specific
   disposition against an approved, launch-ready retention-policy version.
   `DELETE` and `ANONYMIZE` decisions enter `READY`; `RETAIN` and `NO_DATA`
   complete without a destructive job.
2. Each destructive `READY` event atomically creates one immutable recovery
   tombstone and one durable job. Job ID, source event ID and tombstone ID are
   identical. Database guards verify the exact case, subject, category,
   disposition and policy on insertion; current pre-0111 `READY` heads are
   backfilled during upgrade, while obsolete historical revisions are not.
3. The job is not claimable until an independent recovery ledger has persisted
   the tombstone and returned an acknowledgement. The application stores only
   a bounded ledger code and SHA-256 receipt digest. It does not store the raw
   external receipt and the runtime never self-acknowledges a tombstone.
4. Execution is one category at a time through a bounded lease. Claims,
   retries, terminal failures and completion append system-authored disposition
   events in the same transaction as the job transition. A stale lease cannot
   acknowledge work. An expired final-attempt lease is terminalized explicitly
   as `LEASE_EXPIRED`; attempts cannot grow beyond the configured maximum.
5. Category executors implement a provider-neutral interface and must be
   idempotent for the exact job ID. Migration 0111 supplies orchestration and
   recovery safety, not category transformations. A category remains
   non-executable until its reviewed policy and dedicated executor exist.
6. Production-class restore remains isolated until an independently sourced,
   digest-approved normalized ledger is supplied. The canonical reapplicator
   validates an exact bounded JSONL schema, applies every tombstone in one
   database transaction and accepts only category transformations implemented
   in the restored schema. Unsupported categories roll back rather than being
   silently skipped.
7. Reapplication uses a global immutable tombstone receipt plus per-run
   `APPLIED / ALREADY_APPLIED` outcomes. Completion requires exactly one outcome
   for every ledger record. The restore verifier accepts success only when the
   hook attestation and a second database query agree exactly. Runtime database
   roles are denied access; only the owner of the newly isolated restore
   database can mutate this evidence.

## Consequences

- Partial failure is visible and retryable instead of producing an ambiguous
  half-deleted account.
- Repeated delivery or process death cannot duplicate the disposition command
  or exceed the attempt bound.
- The operational database alone is insufficient to authorize a destructive
  job after a disaster, which preserves the intended recovery boundary.
- Selecting and provisioning the independent ledger/provider, its credentials
  and production retention is a HUMAN GATE. No vendor, account or billing
  commitment is made by this ADR.
- The first restore effect is intentionally narrow: subject-owned notification
  delivery metadata can be deleted without deleting the canonical in-app
  notification. The architecture does not claim broader erasure coverage.
- Exact retention values, legal holds, third-party propagation and the concrete
  transformation for each category still require reviewed implementation. The
  queue foundation must not be described as completed erasure by itself.

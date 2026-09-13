# Database migrations and persistence conventions

This document defines the R0 database baseline. It applies to every migration
and table added after `0000_enable_postgis.sql`.

## Running migrations

Set `DATABASE_URL` to a PostgreSQL/PostGIS database and run:

```bash
pnpm --filter @portal/db migrate
```

The runner discovers `packages/db/migrations/*.sql`, validates the complete
set, takes a session-level PostgreSQL advisory lock, and applies pending files
in order. It creates `portal_schema_migrations` as its infrastructure ledger.
The ledger records the version, name, SHA-256 checksum and a database-generated
`timestamptz` for each applied migration.

Migration filenames have the form `NNNN_snake_case.sql`, begin at `0000`, and
are contiguous. SQL files are normalized to LF before hashing so a checkout's
line-ending setting cannot create a false mismatch. Once applied, a migration
is immutable: edit mistakes by adding a new roll-forward migration, never by
rewriting history. A checksum mismatch, gap, renamed migration, missing applied
migration or unknown database migration is a hard failure before pending SQL is
executed.

Every migration and its ledger row are one database transaction. Existing SQL
files may retain an outer `BEGIN; ... COMMIT;` wrapper; the runner removes that
single wrapper and supplies the transaction itself. Migration authors must not
use transaction control inside the body. PostgreSQL operations that cannot run
inside a transaction require a reviewed runner enhancement and recovery plan,
not an ad-hoc manual step.

The normal release path is roll-forward only. Before merge, migrations must run
from an empty PostGIS database and again on a current schema to prove both clean
installation and idempotent runner behavior. Production execution must use a
database role that can change the application schema but is not the runtime
application role.

## Identifiers and timestamps

- Persisted business entity IDs are opaque PostgreSQL `uuid` values with
  `DEFAULT gen_random_uuid()`. IDs must not encode a role, tenant, timestamp,
  sequence, address or other business meaning. External APIs treat them as
  unguessable identifiers but still authorize every lookup; opacity is not an
  authorization control.
- Database rows use `timestamptz`, never `timestamp without time zone`, for
  instants. Canonical creation columns are
  `created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`.
- Canonical mutable rows also have
  `updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`. Every update
  command sets `updated_at = CURRENT_TIMESTAMP` in the same SQL transaction.
  Clients never supply authoritative audit timestamps.
- Business-effective dates or local wall-clock values are separate, explicitly
  named fields. They are not substituted for audit timestamps.
- Application display converts stored instants to a requested time zone; the
  database session should remain UTC.

## History and deletion

Important business entities and transactional records are history-preserving.
They are not hard-deleted and generic CRUD endpoints must not expose a delete
operation for them.

- If an entity can be withdrawn without a dedicated domain state, use
  `deleted_at timestamptz NULL` plus, where required by the domain,
  `deleted_by uuid NULL` and a non-sensitive reason code. Setting or clearing
  these fields is an explicit authorized command, not a generic patch.
- Queries default to `deleted_at IS NULL`; administrative/history views opt in
  explicitly. Uniqueness rules must state whether deleted records participate,
  normally through a reviewed partial unique index.
- State transitions, accepted commercial snapshots, messages, audit events and
  other append/history-bearing records are never soft-delete substitutes. They
  remain append-only or use their specified state machine and immutable
  snapshots.
- Physical erasure is limited to an approved privacy/retention workflow. That
  workflow must preserve required non-personal audit evidence and follow its
  own reviewed migration or operational recovery plan.
- Exact addresses live in a separately authorized table from coarse discovery
  location and public profiles. Foreign keys and logs must not leak exact
  address fields into broadly readable records.

## Query and schema rules

- Use postgres-js tagged templates or Drizzle query builders for dynamic values.
  Never concatenate user or request data into SQL. `unsafe()` is reserved for
  static, repository-owned migration SQL and other reviewed identifiers/DDL.
- Foreign keys, `NOT NULL`, `CHECK` constraints and unique indexes enforce
  durable invariants in the database in addition to server-side validation.
- Prefer explicit domain commands and compare-and-set/state predicates for
  race-sensitive writes. Use transactions and row locks where an invariant
  spans rows.
- Store timestamps and IDs using database defaults, and obtain committed values
  with `RETURNING`; do not manufacture authoritative values in a client.

## Roll-forward, rollback and recovery

Schema rollback is not automatic. The default recovery for a bad migration is:

1. stop the affected rollout and retain the failed logs without secrets or row
   contents;
2. determine whether the transaction committed by checking
   `portal_schema_migrations` and the schema, without editing the ledger;
3. if it did not commit, correct the unapplied file and rerun;
4. if it committed, add and review the next contiguous compensating migration;
5. restore from a verified backup or point-in-time recovery only when a
   compensating migration cannot safely recover the data.

Destructive or difficult-to-reverse changes use an expand/migrate/contract
sequence across releases. Before the contract step, verify backfill counts,
application compatibility, backup/PITR readiness and a written recovery query.
Production data restoration, mass deletion, ledger editing, and manual rollback
are human-gated operations. Never delete a row from
`portal_schema_migrations` to force a rerun.

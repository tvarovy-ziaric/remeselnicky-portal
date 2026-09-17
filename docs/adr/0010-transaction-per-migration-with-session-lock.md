# ADR 0010: Commit each schema migration under one session advisory lock

- Status: Accepted
- Date: 2026-09-16
- Tickets: R4-002/R4-003 staging integration

## Context

The original migrator held all pending SQL files and their ledger entries in a
single transaction under a transaction-scoped advisory lock. PostgreSQL does
not permit a newly added enum value to be used until the transaction adding it
commits. Migration `0058` adds `job_request_state.CONVERTED`; migration `0059`
uses it in the operational projection. The first alpha update therefore failed
with `55P04` and rolled the entire pending batch back.

## Decision

Reserve one PostgreSQL connection and hold a session advisory lock across
discovery of the applied ledger and the whole pending sequence. Apply each SQL
file and its checksum-ledger insertion in its own transaction. A failed file
rolls back its own schema and ledger changes; already committed files remain
applied and a retry validates the same immutable prefix before continuing.
Release the advisory lock and connection in `finally`.

## Consequences

Migration batches are no longer all-or-nothing, but every individual file is
atomic, serialized and resumable. Schema files that depend on an enum value
added by an earlier file can now use it after that file commits. Rollback of a
release still requires a reviewed forward or recovery migration; the runtime
image rollback does not reverse committed schema changes.

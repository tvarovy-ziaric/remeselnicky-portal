# ADR 0006: Isolate PostgreSQL clients by query layer

- Status: Accepted
- Date: 2026-09-16
- Ticket: R3-022 staging verification

## Context

The database module exposes Drizzle queries and repositories using native
postgres.js tagged SQL. Drizzle configures serializers on the postgres.js
client it receives. When both query layers share one client, native repository
inserts bind `Date` and JSON parameters with Drizzle's serializers, which
produce values unsuitable for postgres.js text-protocol binding. The first
live staging symptom was failure to persist a CSRF session.

## Decision

`createDatabase` opens separate postgres.js clients for Drizzle and native
repository SQL. Drizzle configures only its own client. Each client retains
the same TLS connection string and bounded connection settings; `close()`
closes both. Native repositories keep the parameterized `sql.json` and `Date`
bindings rather than substituting ad-hoc string casts throughout the codebase.

## Consequences

- The configured pool maximum applies to each client, so a process may use up
  to twice that many database connections. Deployment sizing must account for
  both pools.
- Query-layer serializer behavior is isolated, including when the two layers
  operate concurrently.
- Live database integration and staging HTTP tests exercise the native
  session path through the combined database module.

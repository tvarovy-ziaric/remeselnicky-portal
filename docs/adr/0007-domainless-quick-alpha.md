# ADR 0007: Domainless Quick Tunnel for synthetic alpha access

- Status: Accepted for synthetic testing only
- Date: 2026-09-16
- Ticket: R3-022 staging access

## Context

The operator has no Cloudflare-managed DNS zone and requested access through
Cloudflare's free Quick Tunnel. Quick Tunnel issues random public hostnames
without an account, but those hostnames cannot be protected by the planned
Cloudflare Access application policies. A URL is not an authorization boundary.

## Decision

Run two independent Quick Tunnel connectors with no restart policy. The app
connector reaches only Nginx port 8082, where a generated high-entropy Basic
Auth password gates app/API traffic before the portal's own authentication.
The object connector reaches only Nginx port 8081, which has no app route and
permits only exact opaque private-object paths with signed GET/HEAD requests.
Neither port is published on the host. Connector startup discovers the random
hostnames and updates only ignored local alpha configuration before restarting
the app origin consumers. Gate credentials remain in ignored local secret
files; no credential is placed in the URL or repository.

## Boundaries and consequences

- This target is for synthetic internal testing only. Basic Auth is a shared
  gate, not individual tester identity or Cloudflare Access. Portal-level
  authorization remains authoritative for all private entities.
- Both URLs change on connector restart. A stopped connector remains stopped
  until deliberately started again; stale origin configuration fails closed.
- Quick Tunnel has no uptime guarantee, a concurrent-request cap and no SSE.
  It is not a production endpoint or a substitute for D30 staging E2E and
  explicit real-user go/no-go requirements.
- Public smoke probes must cover unauthenticated app denial, authenticated
  app/CSRF access, object-route denial and one signed-object roundtrip without
  logging the signature or leaving the probe object behind.

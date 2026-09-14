# R1 supply-side authorization and privacy matrix

R1-019 adds a reusable `@portal/testing` contract and a real PostgreSQL adapter
for the D26, D27 and D30 supply-side release gates. The suite is deliberately
action-specific: profile owners may use owner reads and owner commands, while
profile and credential review is allowed only to a live MFA-backed privileged
session with the exact capability. An `ADMIN` or `SUPER_ADMIN` role by itself is
never treated as private-data or review authority.

## Covered boundaries

`verifyR1SupplySideMatrix` requires evidence for all of these intersections:

- the approved and intentionally public profile is readable, non-cacheable and
  indexable;
- draft, owner-hidden, moderation-hidden, suspended and unknown profiles all
  produce the same non-cacheable, noindex 404 representation;
- all 13 R1 owner surfaces allow the owner and deny a foreign user, role-only
  admin, role-only superadmin and suspended actor for both reads and commands;
- profile and credential review allow the exact MFA/capability actor and deny
  every role-only or owner actor;
- portfolio delivery succeeds only at the exact public-profile, public-project,
  matching-source and live-public-object intersection; profile hide, project
  hide, source mismatch and object revocation all fail closed;
- competing revision commands have one applied effect and one stale result;
  identical idempotent commands have one effect and deterministic replay.

Owner-command success is not inferred from “anything other than denial”. Each
surface declares its accepted real repository outcome. Commands deliberately
change fixture state and require `APPLIED` (or `UPDATED` for the profile), except
the one-photo reorder and already-public visibility commands, whose only valid
fixture result is the documented `UNCHANGED`. Stale, invalid and unknown
statuses fail the suite.

The public payload is checked against the explicit R1 profile field allowlist.
Actual public/portfolio DTOs and denial DTOs are scanned for fixture markers and
forbidden field families, including email, phone, home/exact address or
coordinates, storage keys, content hashes, credential evidence, session
provenance and internal review/risk metadata. Authorized owner/admin DTOs remain
server-private and are not incorrectly required to satisfy a public allowlist;
their probes return only the real bounded repository/authorizer status needed as
evidence.

Here, `SUSPENDED` is not an unrelated suspended account. Owner probes suspend
the actual profile owner around the operation and restore it in `finally`;
privileged probes do the same to the actual MFA/capability reviewer while
reusing that reviewer's real privileged session. This proves that account-state
revocation overrides authority which would otherwise be valid.

Positive review probes call the real DB-backed admin authorizer with a recent
MFA session and the exact profile- or credential-review capability. Role-only
fixtures intentionally have no privileged session and therefore expect
`AUTHENTICATION_REQUIRED`, not a fabricated capability result. The current role
model grants both review capabilities together to `ADMIN`, so it cannot create
a live admin session missing only one of those two review capabilities.

Both race axes release exactly two operations through
`runConcurrentAttempts`' synchronized barrier. The evidence type is a two-item
tuple and the verifier also rejects malformed runtime adapters whose result
length is not exactly two.

## PostgreSQL adapter

`packages/db/test/r1-supply-side-integration-helper.ts` exports exactly:

```ts
runR1SupplySideIntegrationAssertions(sql: Sql): Promise<void>
```

It consumes an already migrated isolated database with active synthetic
taxonomy and location fixtures. The helper creates unique test-owned rows,
drives the real repositories and public read model, and does not expose an HTTP
route or modify the shared migration runner. The root integration suite may call
it after the R1 profile, credential and portfolio fixtures/migrations are
available. It intentionally does not create a migration or permanently alter a
canonical taxonomy/location catalog.

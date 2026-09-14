# Authorization, integration and E2E harness

R0-032 provides reusable, provider-neutral test primitives for the D26/D30
negative permission and transactional release gates. It is infrastructure for
R1–R4 tests; it does not claim that future marketplace flows already pass.

## Isolated PostgreSQL runs

`withIsolatedPostgresDatabase` creates a uniquely named `portal_it_*` database,
passes an open `postgres` client to the test, and removes only that generated
database in `finally`. Test/development use is restricted to a loopback
connection whose base database is explicitly named `*_test` or `*_dev`.
Staging requires a staging-named database and may not disable TLS remotely.
Production is rejected at runtime. The helper sets `portal.environment` on the
isolated connection so the R0-031 synthetic seed guard remains effective.

CI runs `@portal/testing test:integration` before the existing clean migration
suite. Those two suites run serially and do not mutate the same isolated DB.

## Authenticated and negative permission requests

`createAuthenticatedTestClients` builds clients for customer, individual/company
craftsman, combined, admin, superadmin and suspended fixtures. A session cookie
is enclosed in each client and is excluded from its public fields and JSON.
Callers cannot override `Cookie` or `Authorization`, and transport exceptions
are replaced with a credential-free error.

`assertAuthorizationDenied` covers ordinary `401`/`403`/`404` boundaries.
`assertUniformNotFound` is the stricter private-object assertion: every attacker
must receive the same non-cacheable 404, with no redirect and no configured
private marker in headers/body.

`createPrivateFileIdorFixture` reserves deterministic synthetic IDs for a
customer-owned private request file and an invited provider. The accompanying
runner checks anonymous, unrelated, privileged-without-case-access and suspended
actors. Tests which seed it must grant access only to the owner and the explicit
invited-provider fixture.

## Race and idempotency evidence

`runConcurrentAttempts` releases 2–32 operations from one barrier using the same
machine-safe idempotency key. `verifyExactlyOnceCommand` then requires exactly
one persisted business effect and repeats the command with the same key to prove
that retry does not duplicate it. Future Quote acceptance, Change-order approval
and completion tests supply their real command handler, result classifier and a
database count query; an in-memory counter is not release evidence.

These helpers never log raw session credentials, request payloads, exact
addresses, file contents or storage grants.

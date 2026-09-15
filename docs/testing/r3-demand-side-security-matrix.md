# R3 demand-side authorization and IDOR matrix

R3-022 Stage 1 adds a declarative `@portal/testing` contract and a standalone
PostgreSQL adapter for the D26/D30 request, invitation, conversation, Quote and
private-media boundaries. It is release-evidence infrastructure, not a claim
that the still-missing HTTP and browser paths have passed.

## Declarative contract

The matrix is not actor-only. Every case binds all of these dimensions:

- an actor class, including both marketplace roles, a same-request competing
  provider, unrelated/combined actors, role-only admins and suspended owners;
- a target lineage: exact own, competitor on the same request, foreign request,
  unknown UUID or a valid UUID belonging to the wrong entity kind;
- a relevant state: writable or terminal conversation, provider-private Quote
  draft, submitted/historical Quote, or current submitted comparison;
- a concrete read, command or private-download surface and its exact allowed or
  uniform-not-found outcome.

This distinction prevents an adapter which merely switches on the actor role
from passing. In particular, customer access to submitted/historical Quote
content does not imply access to a provider draft, a writable conversation does
not imply terminal write access, and a provider authorized on one invitation
cannot read the other provider's conversation, Quote, revision, price or PDF.

The verifier also requires effect-count evidence for every evaluated denied
command, rejects private fixture markers in denial payloads, checks
cross-provider markers on positive provider reads, and rejects storage keys,
hash/scan metadata, exact address/coordinates and normalized contact fields in
returned evidence.

## PostgreSQL adapter and evidence honesty

`packages/db/test/r3-demand-side-security-integration-helper.ts` exports:

```ts
runR3DemandSideSecurityIntegrationAssertions(
  sql: Sql,
): Promise<R3StageOneSecurityReport>
```

It drives the actual invitation, conversation/chat, Quote structured/external,
comparison and private-media delivery repositories against a disposable live
PostgreSQL database. It seeds a second provider on an existing active request,
creates a real bilateral conversation, canonical chat image, structured Quote
history and a replaced/current external PDF pair. IDs and text canaries are
synthetic. Repository-owned transactions mean the append-only fixture is not
rollback-clean; the helper must run only in an isolated database which is
dropped after the suite.

The report distinguishes `VERIFIED` from `PARTIALLY_VERIFIED` at the database
level. A case without a genuine foreign, terminal or provider-draft fixture is
listed by ID as `NOT_EVALUATED`; it is never converted into a pass by returning
the expected answer. Existing focused R3 repository/live helpers remain the
source of race, idempotency and terminal-transition evidence until this adapter
gets those independent fixtures.

HTTP authoring, production private-media composition and browser E2E remain
explicit `NOT_EVALUATED` seams. Stage 2 must exercise real authenticated API
transport (including cache/CORS/CSRF/error normalization) and browser navigation
before D30 release evidence can be marked complete. R4 acceptance, Job creation,
post-confirm contact/address access and later lifecycle states are deliberately
outside R3-022 Stage 1.

## Minimum release follow-up

Before the R3/D30 security gate is complete, retain the declarative matrix and
add evidence for:

- real foreign-request and terminal-lineage fixtures, including denied-command
  no-effect assertions;
- provider-private structured and external-PDF drafts alongside customer-visible
  submitted history;
- authenticated API ID substitution and uniform non-cacheable denial behavior;
- browser journeys for customer, exact provider, competing provider, combined,
  suspended and role-only admin actors;
- deterministic revoke/read and state-change/read races through production
  composition, without substituting mocked success for a real authorization
  decision.

# PLATFORM_STRUCTURED Quote authoring

R3-016 implements the D14 structured authoring envelope on top of the Quote
identity and state machine from R3-015. It does not define acceptance, job
creation, payment, or `EXTERNAL_PDF` authoring.

## Authoritative model

`quote_structured_content_revisions` is an append-only, relational projection
bound to one exact `(quote_id, quote_revision)`. Each successful save appends one
server-numbered content revision through an immutable authoring command. The
schema stores no generic content JSON.

The envelope records:

- labor, material, transport, and other category amounts/descriptions;
- fixed, estimate, or range pricing, its explicit basis, EUR/VAT treatment;
- included and excluded scope;
- inspection conditions, start date, duration, validity, and warranty;
- material responsibility and informational deposit mode/amount/percentage;
- bounded provider notes.

EUR values are integer cents and percentages are integer basis points. Category
amounts are explanatory and are deliberately not required to sum to the stated
commercial total. Dates use strict ISO date-only values; validity is an absolute
UTC instant.

## Authorization, privacy, and submit eligibility

Every save and read rechecks an ACTIVE account and the exact Quote ownership and
invitation/conversation lineage. Customer reads expose only a SUBMITTED
revision; provider DRAFT content remains private. Text validation uses the same
authoritative pre-confirmation contact/address detector as conversation chat,
with bounded, canonical text and arrays. Invalid persisted projections fail
closed when deserialized through the domain normalizer.

R3-016 replaces only the `PLATFORM_STRUCTURED` branch of
`quote_revision_authoring_is_eligible`. A revision is eligible when current
structured content exists and its optional validity is later than the real DB
clock. `EXTERNAL_PDF` remains fail-closed for R3-017.

## Concurrency and idempotency

Save commands lock in the Quote-core order: actor, invitation, conversation,
then Quote. The trigger locks the exact revision head and reads current
structured content only after those locks. Trigger functions are VOLATILE and
run at READ COMMITTED, so each post-lock SPI statement sees the winner of a
blocked concurrent transaction. The standalone PostgreSQL helper verifies both
decisive orders:

- an expired SAVE that commits first makes the blocked SUBMIT return
  `AUTHORING_NOT_READY`;
- a SUBMIT that commits first makes the blocked SAVE return `READ_ONLY`.

Content CAS is based on the current server-derived revision. Exact command
replays are deduplicated only after current ACTIVE owner/lineage authorization;
reusing a command id for another intent is rejected. Deferred foreign keys
require every command to produce its exact content effect before commit, while
server triggers derive timestamps and resulting revision numbers.

The live helper is intentionally standalone in
`packages/db/test/quote-structured-integration-helper.ts`; the root migration
runner owns its final wiring.

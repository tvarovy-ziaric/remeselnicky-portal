# Quote core and revision lifecycle

R3-015 stores a Quote as one immutable lineage for one exact
`JobInvitation`/`Conversation`. The lineage is separate from chat and carries
immutable revision provenance back to `job_request_active_content_revisions`.

## Revision visibility

A provider may have at most one private `DRAFT` while one earlier
customer-visible `SUBMITTED` revision remains active. Creating the draft has no
effect on that submitted offer. Submitting the new draft appends two effects in
one transaction: the old submission becomes `SUPERSEDED` and the new revision
becomes `SUBMITTED`. Customers never receive a draft row; both participants can
still read the historical submitted/terminal revisions in their own lineage.

R3-015 implements only `CREATE_DRAFT`, `CREATE_REVISION`, `SUBMIT`, and
customer `REJECT`. The schema reserves the locked terminal states, while
withdrawal/expiry belong to R3-019 and acceptance/not-selected/Job creation
belong to R4. No R3-015 command can create a Job or an accepted snapshot.

## Authoring boundary

The core stores authoring mode and exact request-version provenance, but no
generic content JSON. `quote_revision_authoring_is_eligible` deliberately
returns false in migration `0048`; R3-016 and R3-017 must replace that hook with
checks over their validated structured-content or immutable-PDF schemas.
Clients cannot submit a readiness boolean.

## Integrity and authorization

- Commands re-check an `ACTIVE` exact owner and the `ENGAGED`/writable
  invitation-conversation under locks.
- Provider commands belong only to the invitation's primary craftsman; reject
  belongs only to the owning customer. An ID is never authority.
- Command IDs are advisory-locked and payload-fingerprinted. Repository retries
  return the original effect; reuse with another intent fails.
- Expected state revisions provide compare-and-swap protection.
- Server triggers derive Quote IDs, revision numbers, state revisions, and
  timestamps.
- Command-to-Quote, command-to-revision, primary state effect, and conditional
  prior supersession FKs are `DEFERRABLE INITIALLY DEFERRED`, so a command
  cannot commit without its exact effects.
- State history is append-only. Event-derived heads have partial unique indexes
  enforcing at most one `DRAFT` and one `SUBMITTED` revision per lineage.

The standalone `quote-integration-helper.ts` exercises all four command/effect
contracts inside a rollback transaction, including raw-SQL orphan-command
rejection, competitor isolation, account suspension, CAS, idempotency, and the
draft/submitted coexistence rule. It is intentionally not wired into the shared
migration runner by this isolated ticket.

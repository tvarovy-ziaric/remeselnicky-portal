# Craftsman profile private-draft foundation

R1-003 adds one `craftsman_profiles` record as an optional capability of the
existing `User`. A `User` can still own a `customer_profiles` row at the same
time: there is no exclusive account role or dashboard mode. The unique
`owner_user_id` enforces at most one craftsman profile per User, while its
restrictive foreign key gives every profile exactly one owner.

## Private draft boundary

This slice stores only owner-scoped draft data. It deliberately introduces no
public/indexable flag, public query, publication transition, contact field,
profession, location or public serializer. Identity, About text and company
registration data may all remain incomplete. R1-010 owns publication readiness
and the approval/visibility state machine; R1-011 owns the explicit public
projection.

The model discriminates `INDIVIDUAL` and `COMPANY` profiles. Individual rows
may hold the real first name, real surname and optional nickname. Company rows
may hold the official company name and optional eight-digit Slovak registration
number (IČO). `about` is optional while the profile is a draft. The database
rejects fields from the opposite profile shape. The current contract has no
generic profile-type mutation. The locked product rules do not establish a
permanent conversion prohibition, so any later conversion must be introduced
as an explicit, reviewed, history-preserving command rather than inferred from
this foundation.

## Authorization and concurrency

`createPrivateDraft` has one identity source: `actorUserId` from the
authenticated server session. Persistence derives `owner_user_id` from that
same value; callers cannot select a different owner. Creation and replacement
lock the owner `users` row and require its current `account_state` to be
`ACTIVE`. Insert and update triggers enforce the same rule for direct writes.
This serializes draft creation or editing with suspension/deactivation and does
not delete a profile after a later account-state change.

Creation is idempotent for an identical retry and reports a conflict when the
same owner already has a different draft. Replacement is an explicit full
draft command with an expected revision. The row and owner are locked, a
compare-and-set revision prevents lost updates, and a retry of the already
committed representation returns `UNCHANGED`. Owner-scoped lookup and mutation
return the same not-found result for a missing or foreign profile. Profile rows
cannot be hard-deleted or reassigned in place.

## Verification provenance

The table reserves nullable, paired timestamp/reference fields for verified
real identity/company identity and company-registration evidence required by
later approval and presentation work. Creation always clears these fields, and
no R1-003 owner command can grant verification. Editing the identity or
registration data clears the corresponding prior verification. A future
authorized verification capability introduced with the R1-009 verification
work must supply a non-sensitive stable reference and remain separate from
ordinary draft editing.

All IDs, revisions and timestamps are database-authored. Text is trimmed,
bounded and rejects unsafe control characters; normalized line feeds remain
valid inside the multiline About field. The repository uses parameterized
queries only and exposes no public projection.

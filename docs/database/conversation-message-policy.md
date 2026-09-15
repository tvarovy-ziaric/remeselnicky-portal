# Conversation message contact/address policy

R3-014 adds a defense-in-depth policy for plain-text conversation messages.
Before a Job is confirmed, an obvious phone number, email address, direct
contact scheme, social-contact handoff, postal address, or coordinate pair is
blocked. A rejected message is not written to the command or timeline tables;
the sender keeps the draft locally and receives a generic accessible warning.

This detector is not the underlying privacy boundary. Stored phone, email and
exact-address fields remain unavailable before confirmation regardless of what
a user types, as required by D02/D26. The detector reduces obvious manual
circumvention without claiming perfect natural-language classification.

## Authoritative stage and history

`conversation_message_policy_stage(conversation_id)` is the database-owned
stage seam. It currently returns `PRE_CONFIRM` for an existing conversation,
because the confirmed `Job` authority does not exist yet. Missing or unknown
state fails closed. A later Job-confirmation migration must replace the
function with an authoritative state join; a browser-supplied stage is never
accepted.

The repository resolves the stage after locking the ACTIVE actor, invitation
identity and conversation. Exact command replay is checked before applying a
newer policy so an accepted immutable message remains idempotently replayable.
The database trigger re-resolves the same stage and mirrors the detector, which
protects raw-SQL and race paths. For an accepted message the trigger overwrites
`policy_stage` and `policy_version`; both fields are immutable with the command.

Rows accepted before R3-014 are explicitly backfilled as
`LEGACY_PRE_CONFIRM` version `0`. This records their provenance without falsely
claiming that the version-1 detector evaluated them.

## Version 1 rules

The bounded deterministic detector recognizes:

- direct and commonly spaced/labelled email addresses;
- phone-like digit sequences and labelled telephone/mobile numbers;
- `mailto:`, `tel:` and the exact `wa.me` contact host;
- direct social handles and profile/contact links on exact known hosts;
- Slovak postal codes and explicitly labelled street/house addresses;
- decimal coordinate pairs and obvious degree/minute/second coordinates.

Ordinary `http://` and `https://` links remain valid. Contact-host matching is
anchored to an exact host and profile/contact path; a host-name substring is
not enough. Technical fractions, dimensions, dates, times, voltages and normal
job reference numbers are regression-tested to avoid broad numeric blocking.

The API returns only HTTP 422 with `CONTACT_SHARING_NOT_AVAILABLE`. It does not
return the detected category or the submitted body. Normal request logging is
metadata-only and does not record chat text.

## Verification

Unit/static tests cover the TypeScript detector, DB query order, fail-closed
stage handling, historical replay, generic API response and accessible web
copy. The migration integration helper exercises the same allow/block corpus,
non-retention of rejected text, raw-SQL bypass attempts, server overwrite of a
spoofed stage/version, append-only provenance and a transactionally rolled-back
unknown-stage simulation. It runs only when `TEST_DATABASE_URL` is configured.

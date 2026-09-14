# Featured portfolio projects

R1-017 stores one owner-controlled ordered list of at most three portfolio
project IDs per craftsman profile. Featuring is presentation preference only:
it does not publish a profile, project, photo, derivative, location, or customer
property and it creates no consent or verification claim.

`PIN` appends an owned current `DRAFT` project, `UNPIN` removes an existing
reference, and `REORDER` accepts the complete current permutation. Hidden,
archived, unknown, and non-owned projects cannot be newly pinned or reordered.
An unavailable historical item can still be unpinned without rewriting the
project or earlier featured history.

## Commands and history

Commands require the ACTIVE profile owner and an expected featured-set revision.
The database locks the owner and set before the relevant project rows, then
rechecks ownership and current draft state. A concurrent third/fourth pin cannot
cross the hard maximum of three. Every applied command writes a complete unique
ordered UUID-array snapshot, and a deferred constraint requires the command,
current set and immutable revision to agree exactly.

Commands and revisions are append-only. Exact retries reauthorize the current
owner before loading the original resulting revision. The private read overlays
current object availability: a still-owned draft may include its allowlisted
title, while a hidden, archived or otherwise unavailable historical reference
keeps only its recorded ID/order and `UNAVAILABLE` state.

## Fail-closed public contract

`current_featured_project_candidates` is deliberately a private candidate view
containing only profile ID, set revision, ordered project ID and position. It is
not a public projection or an eligibility decision.

A future public consumer must explicitly intersect candidates with all current
authoritative requirements: effectively public profile, public project state,
at least one eligible photo/media derivative, and any required current customer
property-photo consent. R1-017 exposes no public read method because R1-018
consent is not implemented. Later publication/consent work must add the complete
intersection in its public projection; it must not reinterpret candidate
presence as permission.

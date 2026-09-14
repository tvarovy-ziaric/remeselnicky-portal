# Portfolio project core persistence

R1-013 stores an older or off-platform realization as a private craftsman-owned
portfolio draft. Every project starts and remains `SELF_DECLARED` and
`UNVERIFIED` in this ticket. There is no public projection, media state,
verification transition or arbitrary Job identifier. R1-015 can add verified
provenance only together with real Job and JobParticipant foreign keys.

The immutable author is the ACTIVE owner of the craftsman profile. A project
requires a title, short description and at least one owned profession. Optional
owned skill and specialization tags must be relevant to one of the selected
professions. New tags must be active; a later text-only edit may retain an
already attached inactive tag so history is not silently rewritten.

Optional structured context comprises contribution, materials and technologies,
problem and solution, bounded duration value plus unit, and a non-contractual
EUR min/max range in integer cents. Approximate location stores only governed
municipality and district codes and verifies that the municipality belongs to
the district. Exact address and customer identity fields do not exist.

## Privacy boundary

All project text passes matching domain and database guards. Contact details,
URLs and domains, social handles, address labels, explicit customer identity
wording, control characters and secret-like values are rejected. Legitimate
trade notation such as `1/2` and `230/400 V` remains accepted. These guards
protect content that may become publishable later even though R1-013 itself
exposes only the private owner read model.

## Commands, history and visibility state

Create, edit, hide, archive and restore-to-draft are explicit commands. The
repository locks the profile and ACTIVE owner before replay, authorization and
mutation, uses expected revisions for compare-and-swap, and returns the exact
immutable revision produced by an idempotent command replay. A reused command
UUID with different intent is rejected.

Each applied command has one full immutable snapshot. Deferred constraints
require the command, current row and snapshot to form one exact effect, while
database triggers reject direct content/state mutation and history deletion.
`DRAFT`, `HIDDEN` and `ARCHIVED` are private record states only; none creates a
public or verified representation before the later publication workflow.

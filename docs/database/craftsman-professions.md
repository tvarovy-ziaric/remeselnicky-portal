# Craftsman profession relationships

R1-004 represents each profession as a profile-scoped relationship, not as a
single global level on the user or profile. A profile may therefore have many
active professions, while the partial unique index permits only one active
relationship for the same canonical profession code.

## Taxonomy authority

New assignments must reference an `ACTIVE` profession from the currently
activated, human-approved canonical taxonomy release. The relationship stores
only the immutable `(taxonomy_release_id, profession_code)` foreign key. It
does not copy labels or create a second taxonomy authority. A later taxonomy
activation does not rewrite old assignments; their original governed
provenance remains inspectable. Re-assigning after deactivation uses the then
current canonical release.

## Declared and supported proficiency

The owner selects one of the shared `BEGINNER / ADVANCED / MASTER` labels per
profession. Declared changes append a contiguous revision to
`craftsman_profession_declared_level_events`; upward and downward moves are
both allowed, but a no-op or stale expected revision is rejected.

Evidence-supported proficiency is deliberately a separate nullable projection
in `current_craftsman_professions`. R1-004 exposes no owner write path, numeric
threshold, rating-derived promotion, or evidence adjudication command. A later
explicit evidence workflow can populate its own history without changing or
rewriting the declaration history.

## Commands, authorization and retention

Assignment, declared-level change and deactivation are explicit transactional
commands. Each command has a UUID and a canonical payload fingerprint. An
exact retry is deduplicated; reusing an ID for different intent fails closed.
Mutations lock the current `CraftsmanProfile` and its owner and require the
owner `User` to remain `ACTIVE`. Missing profiles, non-owners and inactive
owners receive the same unavailable result at the repository boundary.

Deactivation is the only removal operation in R1-004. It requires matching
`DEACTIVATE` command provenance and retains the relationship, commands and all
level events. Database triggers reject hard deletion, history mutation,
invalid state transitions, incomplete assignments without an initial declared
level, and commands committed without their effect.

The live PostgreSQL assertion helper covers current/stale/deprecated taxonomy,
multiple professions, non-owner access, direct-SQL bypass attempts, exact
idempotent retries, optimistic revision races, deactivation and retained
history. It is intentionally invoked by the repository's single clean-schema
integration runner only when that runner advances its migration manifest.

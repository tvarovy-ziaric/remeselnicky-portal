# Craftsman experience persistence

R1-008 stores one optional profile-wide `working_since_year`. It is explicitly
self-declared context and remains separate from profession proficiency,
evidence, reviews, ranking and reputation. The model never stores a manually
maintained `years of experience` counter; consumers may later present elapsed
time from the stored year and their server/UI clock without rewriting history.

The accepted technical year range begins at 1800. This is a broad data-sanity
boundary, not a product experience threshold. PostgreSQL authoritatively rejects
a future year against its own `CURRENT_DATE`; the client cannot supply the
comparison clock.

## Commands and history

The private owner command uses an expected revision and command UUID. The
profile and ACTIVE owner User are locked before CAS, replay and mutation. Exact
retries return the original allowlisted immutable revision; command-ID reuse
with a different intent fails.

An initial `null` is deterministically `UNCHANGED`: the idempotency command is
retained with resulting revision zero, but no fake state revision is created.
Setting a year creates revision one. Replacing it or clearing it back to `null`
creates another immutable revision, so a real clear never erases prior context.
Commands and revisions are append-only and their effects are verified by a
deferred database constraint trigger.

R1-008 exposes only an ACTIVE-owner repository/read model. Public profile
projection and publication behavior belong to later tickets.

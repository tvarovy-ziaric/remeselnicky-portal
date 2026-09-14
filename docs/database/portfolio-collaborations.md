# Portfolio collaborator attribution boundary (R1-016)

Migration `0026_portfolio_collaborations.sql` models an explicit invitation and
confirmation workflow for attributing another existing `CraftsmanProfile` to a
portfolio project.

## Separate state axes

- `state` records the invitation lifecycle: `PENDING`, `ACCEPTED`, `DECLINED`,
  `AUTHOR_WITHDRAWN`, or `COLLABORATOR_WITHDRAWN`.
- `visibility` is the project author's current preference for an accepted
  attribution: `VISIBLE` or `HIDDEN`.
- A partial unique index permits only one current pending or accepted invitation
  for a project/collaborator pair. Terminal history remains append-only and a new
  later invitation receives a new identity.

The author proposes a bounded public role and contribution. Only the invited
profile owner can accept that exact current revision. The author cannot accept,
decline, or withdraw on behalf of the collaborator; the collaborator cannot edit
the proposed attribution. Author hiding and collaborator withdrawal only remove
current public eligibility and never rewrite the accepted snapshot or its
provenance.

## Authorization and history

Every command locks the project, both profile rows, and their owners. The
relevant owner must still be `ACTIVE` before idempotent replay is disclosed.
Commands use expected revisions and payload fingerprints. Server-authored
command timestamps determine revision and acceptance/terminal timestamps.
Deferred constraints require every stored command to have an exact head and
revision effect. Command and revision rows are append-only, and the mutable head
cannot be updated or deleted without a matching command.

Role and contribution reject contact details, addresses, URLs, customer names,
control characters, and secret-like text using the portfolio public-text guard.
There is deliberately no source, employer, free-text identity, external person,
job, or suggestion field in this boundary. An off-platform/self-declared project
does not become a `JobParticipant` or acquire verified Job provenance through a
collaboration invitation. Future R1-015/R4 participant suggestions must connect
through a separately reviewed command.

## Public boundary

`current_portfolio_collaboration_candidates` is a privacy-minimized candidate
view, not a complete public-eligibility decision.
It returns only an accepted, currently visible attribution when both the author
and collaborator profiles pass the authoritative effective-public boundary. It
contains only project/profile identifiers, role, contribution, and acceptance
time.

The view never publishes a portfolio project. The R1-018/R1-011 final project
projection must independently verify project publication/moderation, media
eligibility, consent, and any other applicable public rules before joining these candidates. Exact
invitation state, declined/withdrawn history, command actors, fingerprints, and
private account state are never part of this view.

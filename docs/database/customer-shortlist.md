# Private customer shortlist (R2-012)

The shortlist is one private, owner-scoped set of craftsman profile references
per `CustomerProfile`. It is reusable across future requests and is not an
invitation, an authorization grant, or a snapshot of search ranking. D12's
five-item limit applies only to simultaneously active invitations; the schema
deliberately has no five-item shortlist constraint.

`customer_shortlist_entries` is the mutable current head. Explicit `ADD` and
`REMOVE` commands use a caller-generated UUID for exact retry identity, while
the database derives the current revision after locking the pair. Applied
transitions append immutable bounded-field effects and advance the head;
same-state commands are recorded as `UNCHANGED`. Reusing a command UUID for a
different actor, target, or action fails closed. No query, public-card, ranking,
distance, availability-block, contact, address, or profile-content snapshot is
stored.

Every mutation derives the `CustomerProfile` from the authenticated User; a
client never selects its customer/owner identity. The actor is rechecked as
ACTIVE before replay. `ADD` locks the target profile before both involved User
rows in stable UUID order, then evaluates the live approved PUBLIC discovery
projection. This linearizes add-versus-hide and avoids reciprocal-shortlist
deadlocks. `REMOVE` does not require the target to remain public. Existing
entries whose target later leaves discovery hydrate only as an owner-visible,
content-free unavailable tombstone.

The API uses `GET /v1/me/shortlist` and CSRF-protected explicit POST commands at
`/v1/me/shortlist/add` and `/v1/me/shortlist/remove`. Responses are private,
`no-store`, and `noindex`. R3 may read the active profile IDs as a convenience,
but its invitation transaction must independently recheck request ownership,
current target eligibility, self-invite prohibition, qualification, anti-spam,
and the five-active-invitation invariant. Removing an entry never changes an
existing invitation.

Applied results include the transactionally derived active shortlist size for
R2-013 to bucket after integration. R2-012 itself emits no analytics/outbox
event. Command/effect retention remains subject to D27 category-specific
retention and deletion/anonymization policy; this is not permanent commercial
history.

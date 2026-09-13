# User identity persistence

R0-008 introduces one private `users` record per portal account. Its UUID is a
stable, opaque internal identifier. Customer and craftsman capabilities are not
roles on this record: later tickets attach an optional `CustomerProfile` and an
optional `CraftsmanProfile` to the same User. Consequently the schema has no
exclusive role, public-profile, email, password, phone, or authentication
columns.

## Account state

`account_state` is constrained to `ACTIVE`, `SUSPENDED`, or `DEACTIVATED` and
defaults to `ACTIVE`. Suspension and deactivation retain the User row and its
stable ID; normal application operation must not hard-delete it. This migration
does not define state transitions or expose a generic status setter. Later
authorized commands must implement the locked transition and audit rules and
must never accept privileged state directly from a client payload.

`account_state_changed_at`, `created_at`, and `updated_at` are authoritative
database `timestamptz` values. A new row obtains all three from
`CURRENT_TIMESTAMP`. Constraints prevent a state-change time before creation or
an update time before the current state-change time. An eventual explicit state
command must set `account_state`, `account_state_changed_at`, and `updated_at`
together in its server-side transaction.

State history beyond the current state is intentionally not invented here. A
future ticket that defines account-state transitions may add append-only audit
history without changing the stable User identity.

## Exposure boundary

The table is server-side persistence, not a public projection. It introduces no
public endpoint or serializer. In particular, there is no public
`CustomerProfile`; public craftsman data will later use an explicitly approved,
field-limited projection rather than exposing the User row.

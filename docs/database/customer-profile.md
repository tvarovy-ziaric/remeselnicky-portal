# CustomerProfile lazy creation

R1-002 adds the private customer-side capability defined by D02/D03. A
`CustomerProfile` is not a second account or an exclusive account role. Its
`owner_user_id` is unique, so one `User` can own at most one customer profile;
the same User may independently own the optional craftsman profile introduced
by R1-003.

## First customer-side use

An authenticated customer command calls
`CustomerProfileService.ensureForCustomerUse` with the session actor's User ID.
There is intentionally no separate client-selected owner field. The persistence
operation locks the owning `users` row, checks that its current state is
`ACTIVE`, and inserts the profile with `ON CONFLICT DO NOTHING`. The owner lock
serializes simultaneous first-use calls, so exactly one returns `CREATED` and
the rest return the same row as `EXISTING`. It also serializes profile creation
against account suspension/deactivation. A database `BEFORE INSERT` trigger
repeats the locked active-owner check, so direct SQL cannot bypass it.

Missing, suspended, and deactivated accounts all produce the same fail-closed
`ACCOUNT_NOT_ACTIVE` persistence outcome; the domain service exposes the safe
`CUSTOMER_PROFILE_ACCOUNT_NOT_ACTIVE` error. No profile row is created in those
cases.

The operation is a foundation for later customer commands. It does not create a
job request, introduce a generic customer-profile CRUD endpoint, or authorize
any marketplace action by itself.

## Privacy boundary

`customer_profiles` defaults both `is_public` and `is_indexable` to `false`,
and database checks reject either flag becoming true. The domain model maps
those invariants to the literal values `PRIVATE` and `DISALLOWED`. The table has
no slug, public display route, contact fields, exact address, or public
serializer.

Customer trust/identity data shown to an invited provider must be implemented
later as a field-limited, invitation/Job-context-authorized projection. It must
not become a generic public `CustomerProfile` endpoint. Physical erasure remains
reserved for the approved privacy/retention workflow. A fail-closed
`BEFORE DELETE` trigger prevents ordinary physical deletion; a future approved
D27 erasure workflow must introduce an explicit, reviewed, auditable mechanism
rather than silently bypassing history preservation.

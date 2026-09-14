# Lightweight craftsman availability (R1-012)

R1-012 stores private, profile-owned calendar markings with three explicit
states: `AVAILABLE`, `BUSY`, and `UNAVAILABLE`. A marking is context supplied
by the craftsman for work from any source. It is not a booking, capacity
allocation, crew schedule, dispatch plan, contractual promise, or guarantee
that a future request will be accepted.

## Commands and immutable history

Owners use explicit `ADD`, `REPLACE`, and `ARCHIVE` commands. Every command is
bound to the authenticated actor and target `CraftsmanProfile`, carries a
SHA-256 intent fingerprint, and uses an expected revision. PostgreSQL locks
the profile and ACTIVE owner, derives result revisions and timestamps, and
requires an exact immutable revision effect for every applied command.

An exact command retry is deduplicated. Reusing a command UUID for another
actor, profile, block, command kind, range, state, or revision fails closed.
Commands and revisions are append-only. Archiving carries the last marking
into a new `ARCHIVED` revision rather than deleting it.

## Range and overlap semantics

The domain accepts real UTC instants represented by JavaScript `Date`; the
database stores `timestamptz`. Both layers reject non-finite/reversed periods
and enforce broad technical bounds from year 2000 through 2200 with a maximum
single-block duration of 3,660 days. These are abuse/storage safeguards, not
marketplace duration policy or calendar granularity.

Overlapping active markings are intentionally allowed. They remain separate
statements with no implicit precedence, merge, conflict resolution, or
effective booking state. Consumers must not infer capacity or a promise from
one block, nor assume that `UNAVAILABLE` automatically overrides `AVAILABLE`
(or vice versa). A later UI/read-model ticket may define presentation without
rewriting these source facts.

## Privacy and scope

Precise periods are available only through ACTIVE-owner repository reads.
R1-012 adds no public projection or web/API endpoint. Any future public or
search availability projection requires a separate privacy-reviewed,
coarsened design.

The model deliberately has no customer/job booking reference, source or
employer field, free-text note, recurrence rule, external calendar identifier,
contact data, capacity, crew assignment, or scheduling guarantee.

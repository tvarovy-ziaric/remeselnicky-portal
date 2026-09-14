# Craftsman availability matching (R2-007)

R2-007 adds a server-side, categorical search signal over the private
availability calendar. Migration `0033_craftsman_availability_matching.sql`
does not create a second mutable search authority: it derives every result from
the live R2-001 candidate view and current ACTIVE availability revisions.

## Boundary

`craftsman_availability_match_facts(starts_at, ends_at,
filter_indicatively_available)` is a `STABLE`, `SECURITY INVOKER` function. It
returns only:

- the public candidate profile id;
- one categorical overlap kind;
- whether the result is an unambiguous AVAILABLE-only overlap.

It never returns the requested or stored timestamps, number of blocks, source
of work, employer, capacity, booking state, contact data, or calendar contents.
The composed relevance fact retains the originating public profile UUID so a
soft-positive fact cannot be detached and applied to another candidate.
The underlying exact periods remain private. Candidate eligibility is inherited
from `current_searchable_craftsman_profiles`, so hidden, restricted, unapproved,
not-ready, and non-ACTIVE-owner profiles fail closed.

## Deterministic overlap

Timing is either omitted entirely or supplied as a paired, bounded UTC instant
interval. The bounds match the lightweight calendar's technical limits
(`2000-01-01` through `2200-01-01`, at most 3660 days). Overlap is half-open:

```text
stored.start < query.end AND stored.end > query.start
```

Touching endpoints therefore do not overlap. Omitted timing produces
`TIMING_NOT_SUPPLIED` for every candidate and is neutral.

All current overlapping markings are considered without precedence or
auto-merge:

- only AVAILABLE -> `AVAILABLE_OVERLAP`;
- only BUSY -> `BUSY_OVERLAP`;
- only UNAVAILABLE -> `UNAVAILABLE_OVERLAP`;
- more than one declared state -> `MIXED_OVERLAP`;
- none -> `NO_OVERLAPPING_DECLARATION`.

An AVAILABLE-only overlap is a soft positive. Every other category is neutral,
not a negative ranking signal. In particular, UNAVAILABLE never excludes a
profile from ordinary search, and MIXED never lets an AVAILABLE marking override
a simultaneous BUSY or UNAVAILABLE marking.

## Explicit indicative filter

The `filterIndicativelyAvailable` option is valid only with a timing interval.
When enabled, it retains only `AVAILABLE_OVERLAP`. `MIXED_OVERLAP` fails closed.
This means only that an explicit AVAILABLE marking intersects some portion of
the requested interval. It does not mean full-interval coverage and is never a
promise of availability, crew capacity, acceptance, dispatch, or booking.

R2-009 owns any future cross-signal ranking weights. This boundary exposes only
the categorical `SOFT_POSITIVE`/`NEUTRAL` input and does not invent a score.

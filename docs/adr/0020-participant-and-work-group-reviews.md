# ADR 0020: Verified participant and historical work-group reviews

- Status: Accepted for R4-018 implementation
- Date: 2026-09-24
- Tickets: R4-018, with R4-019–R4-020 extensions

## Context

D05/D21 let the historical Job customer optionally review a verified
`JobParticipant` who actually worked on a completed Job and, separately, a
concrete `JobWorkGroup` that actually worked as a team. These are secondary
customer-review signals. They are not the bilateral customer/provider review,
not reusable-Crew reputation and not the supervisor-evaluation source defined
for R4-019.

Invitation, reusable Crew membership, a current profile claim or a raw role
assignment is insufficient evidence. R4-016 already derives accepted
participant intervals that positively overlap Job execution, exact
participant-confirmed professions and operational roles, and customer-accepted
completion provenance. Existing work-group assignment history also retains the
concrete Job, group, participant and interval needed to derive historical team
composition.

## Decision

An ordinary participant or work-group review opportunity exists only after a
normal customer-accepted completion. Administrative force-completion remains a
separate D22/D23 policy case and does not implicitly grant an ordinary R4-018
right. The author is the active, email- and phone-verified owner of the
historical CustomerProfile. Self-review is denied by account ownership.

A participant target is one concrete `JobParticipant`, including its exact
accepted participation interval. Eligibility comes from
`verified_individual_completed_job_participation`, which requires a
positive-duration overlap with actual Job execution. A later reinvitation is a
new target and is not collapsed by profile identity. Profession context comes
only from `verified_completed_job_capabilities`; role context comes only from
`verified_completed_job_roles`. A participant with verified work but no
confirmed profession remains reviewable, but the platform must not invent or
retroactively attach a profession.

A work-group target is one concrete `JobWorkGroup`. Its authoritative roster is
the set of explicit Job-work-group assignment intervals that positively
overlap verified completed participant work. At least one such interval is
required. Current or later reusable Crew membership has no effect. Every
qualifying assignment interval is snapshotted as provenance so later group,
participant or Crew changes cannot rewrite the review context.

Store participant and work-group reviews in a dedicated append-only stream.
Each logical review has exactly one target kind and retains Job, customer,
completion and concrete-target provenance. Each submission or edit is a
command-identified monotonically versioned revision. The Job is locked and
the active verified author is rechecked before writing, so concurrent first
submissions or edits serialize. Exact command replay deduplicates; reuse for a
different target, version or content is an idempotency conflict. UPDATE and
DELETE are rejected for review and provenance history.

The ordinary submission deadline is the same Bratislava-local wall-clock time
14 calendar days after `completed_at`. The first submission starts a maximum
60-minute author edit window, capped by the fixed deadline. Unlike the main
customer/provider pair, these reviews are not bilateral and never require the
target to submit first. Main-provider review remains the recommended UX first
step, but its existence is not an extra server-side eligibility rule.

Participant reviews use the seven customer-to-provider dimensions from D21.
Work-group reviews use a distinct six-dimension set: result quality,
coordination, timing, communication, cleanliness/order and problem solving.
Every dimension is exactly 1–5 or N/A, and an all-N/A review is invalid.
Optional comments are bounded and remain out of logs, analytics, audit and
notification payloads.

Work-group scores remain separate team evidence and are never copied to
members. R4-018 does not introduce a public Crew/work-group page or ranking.
Participant reviews may become public individual evidence only after their
edit lock and the Job's main bilateral seal have opened. Any public projection
must omit Job, customer/author, work-group member and exact timestamp
identifiers. Cross-target weighting is not defined by the locked specification,
so participant scores do not silently alter the existing main-provider
headline average in this ticket.

## Consequences

The platform can show every eligible participant and historical work group in
an optional secondary customer flow without review swarm, off-Job reviews or
Crew-roster leakage. Evidence remains traceable to exact completed work and
confirmed professional context. R4-019 supervisor evaluations must use a
separate source, dimensions, authorization and visibility model. R4-020 may
moderate or exclude evidence through append-only actions, but cannot silently
rewrite these historical revisions or provenance snapshots.

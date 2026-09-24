# ADR 0021: Job-context supervisor evaluation evidence

- Status: Accepted for R4-019 implementation
- Date: 2026-09-24
- Tickets: R4-019, with R4-020 moderation extensions

## Context

D05/D21 define supervisor evaluation as a technical evidence source distinct
from customer reviews. It targets one concrete verified `JobParticipant` after
a completed platform Job. A main contractor or a participant with a confirmed
lead, coordinator or site-manager role may evaluate only people they actually
supervised or coordinated. Merely appearing on the same historical Job, being
a reusable Crew founder/member or holding an unconfirmed role cannot create a
rating right.

Raw dimensions and the optional technical comment are private to the
evaluator, evaluated participant and authorized admin. Public reputation may
show profession-aware aggregated evidence, but D05 deliberately leaves the
weighting/scoring formula open and forbids false precision.

## Decision

Derive evaluator/target opportunities only from customer-accepted completed
Jobs and verified accepted participant intervals. The primary contractual
provider may evaluate any other verified participant whose work positively
overlapped execution. A confirmed site manager or coordinator may evaluate a
different participant only where their role interval positively overlaps that
participant's work. A confirmed lead additionally requires positive overlap
between both participants' assignments to the same concrete historical
`JobWorkGroup`. Account ownership equality is denied, covering every
controlled-profile relation represented by the alpha data model.

If several legitimate relationships exist for one evaluator/target/Job, retain
one deterministic opportunity in this order: primary contractor, site
manager, coordinator, lead. The chosen relationship, exact overlap, target,
customer completion decision and deadline are copied into an immutable logical
evaluation record. Target professions and roles are snapshotted only from
participant-confirmed completed-Job evidence. A target with no confirmed
profession remains privately evaluable, but their evaluation contributes to no
public profession count; the platform never invents a profession.

The ordinary deadline is the Bratislava-local wall-clock time 14 calendar days
after completion. Evaluation is non-bilateral and visible immediately to its
target; it has no reciprocal submission or sealed unlock. The evaluator may
append revisions for at most 60 minutes after first submission, capped by the
ordinary deadline. Seven exact dimensions accept 1–5 or N/A, with at least one
substantive answer: competence/quality, reliability, independence,
productivity, collaboration, problem solving and willingness to take the
person into a crew again. The optional comment is bounded.

Each command and logical evaluator/target/Job tuple is unique. Transactions
lock the Job, re-evaluate exact eligibility and current version, and atomically
append the header, provenance snapshots, first revision and notification
intent. Exact replay deduplicates; conflicting command reuse fails; concurrent
writers cannot create duplicate evaluations or silently overwrite a revision.
All evaluation, revision and snapshot rows reject update/delete.

The first revision creates one privacy-minimal outbox intent to the evaluated
participant. Its payload contains only recipient, Job and evaluation
identifiers, never ratings, comment, evaluator identity, contact details or
address. Subsequent edits do not create another visibility notification.

Public trust projections expose only the count of stable, edit-locked
supervisor evaluations that carry a confirmed profession snapshot. Counts are
kept separate from customer-review counts and are scoped per profession. The
public projection carries no Job/evaluation/evaluator identifier, dimension or
comment. `supervisor_quality_available` remains false and no numeric
supervisor score is calculated until a later governed aggregation/weighting
decision. Confidence remains explicitly insufficient for alpha samples.

## Consequences

Authorized supervisors receive a concise, server-derived list instead of
choosing arbitrary profiles. Participants can inspect received technical
feedback and its evaluator display name without exposing account contact
fields. Historical relationships and profession attribution remain auditable
after later role, group or profile changes. R4-020 can add challenge/report and
moderation records against the stable evaluation identifier without rewriting
the evidence history.

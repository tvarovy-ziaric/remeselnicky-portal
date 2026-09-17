# ADR 0016: Optional operational Job milestones

- Status: Accepted for R4-011 implementation
- Date: 2026-09-17
- Ticket: R4-011

## Context

D18 makes milestones optional execution checkpoints. They can describe stages of
work, including a stage already written in the accepted Quote/PDF, but cannot
change the immutable agreement, create a payment obligation, certify payment,
complete the Job, or create a separate review opportunity. Operational dates,
responsibility, order, status and provenance must retain history. D19 remains
the only route for material commercial changes.

The current structured Quote schema has no structured stage/amount rows. An
external PDF may contain stages, but the portal cannot safely infer an amount
or obligation from its text. Therefore a milestone cannot expose an editable
commercial amount. An accepted-Quote stage can be _referenced_ with a bounded
human stage label and the exact pinned accepted Quote identity/PDF; the UI must
describe that mapping as provider-authored and show the original accepted
source. It does not normalize or approve new commercial terms. Approved
Change-order stage provenance will be added by R4-012/013, rather than being
fabricated here.

## Decision

Each milestone has a stable identity and append-only server-timestamped
events. A private current projection is derived from those events. Creation,
text/operational-date changes, state changes, reordering and responsibility
changes preserve their actor, command identity, prior value and time. A Job
row lock serializes conflicting commands and makes exact-command replay
idempotent. Milestones can be created on confirmed active Jobs, are visible on
the central Job dashboard, and remain readable after cancellation. The
`PLANNED / IN_PROGRESS / DONE / SKIPPED` state is independent of the D04 Job
state. Even the last `DONE` milestone never requests or accepts completion.

The primary provider and an explicitly accepted, currently active responsible
Job role may create and update execution planning. Only the primary provider
may mark an execution milestone `DONE` or `SKIPPED`; customer input is a
separate proposal/comment/acknowledgment, never an authoritative edit to the
provider plan. Acknowledgment is informational, not handover, commercial
approval or verified individual work evidence. Assignments may name only
existing Job participants/work groups and retain their history; assignment
alone does not create work evidence.

Attachments link only to already READY, exact-Job privately authorized central
documentation. Original upload/capture provenance and double-checked private
download authorization stay with the media; milestones do not copy bytes or
storage keys. Milestone media must also appear in the central Job documentation
view. Dates are always labelled as the _current operational plan_, never as an
amendment to the accepted schedule. The UI keeps the accepted schedule visible
and directs material changes to D19. No payment ledger, progress percentage,
Gantt/dependency graph, nested tasks or small product count cap is introduced.

## Verification

Clean/replayable PostGIS migration, direct-SQL immutability and exact-Job
authorization negatives, concurrent/idempotent command tests, HTTP/session/
CSRF/IDOR checks, Web parser/accessibility tests, and synthetic public browser
flow before R4-011 is marked DONE. Deployment remains synthetic-only until a
separate D30 real-user go/no-go decision.

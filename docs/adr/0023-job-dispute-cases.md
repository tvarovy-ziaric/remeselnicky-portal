# ADR 0023: Private Job dispute cases and evidence boundary

- Status: Accepted for R4-021 implementation
- Date: 2026-09-24
- Tickets: R4-021, with R4-022 administrative workflow extensions

## Context

D22 requires a customer or the primary provider to be able to open a dispute
about an accepted Job, including after completion or cancellation. A dispute is
not a Job lifecycle state, a payment or escrow instruction, a reputation fact,
a legal judgment or a moderation verdict. Both contractual parties need the
same private case history, the accepted commercial baseline, approved changes,
the Job timeline and case evidence. Ordinary Job participants must not gain
access merely because they worked on the Job.

The alpha does not yet have an authorized live administrator enrollment because
the MFA provider adapter remains a human gate. The contractual-party case and
evidence path can still be completed without granting ordinary sessions an
administrative resolution capability.

## Decision

A `dispute_cases` identity binds to exactly one accepted Job and records the
opening party, governed category, bounded description and requested resolution.
The current case state is derived from append-only state events. R4-021 creates
the initial `OPEN` event only; `WAITING_FOR_PARTY`, `UNDER_REVIEW`, `RESOLVED`
and `CLOSED` transitions and audited administrative actions remain R4-022.
Opening a case never mutates the Job, accepted agreement, payment, review,
reputation or moderation records.

Only an ACTIVE, fully verified owner of the Job's customer profile or primary
craftsman profile may list, read, open or append to a case. Job participants,
Crew members and unrelated profiles receive the same not-found boundary. Party
statements and addenda are separate immutable records; corrections are another
append-only record rather than an overwrite.

Evidence uses the central private `MediaAsset` pipeline. A new upload is
purpose-bound to `DISPUTE_EVIDENCE` and exact `DISPUTE_CASE` provenance, remains
unattachable until canonical processing succeeds, and must be owned and uploaded
by the submitting party. Existing evidence may be referenced only when it is a
READY private photo or clean PDF already proven to belong to the same Job's
winning conversation. Download authorization is case-based and rechecks that
the viewer is one of the two contractual parties; a Job participant relationship
alone never grants case-media access.

Case detail returns immutable accepted request/quote identifiers, an authorized
accepted-PDF link when present, approved change revisions and the Job system
timeline. It does not copy or alter those records. The open-case outbox event
contains only recipient, Job and case identifiers. Its notification mapper
creates one private in-app action; description, requested resolution, evidence,
contacts and addresses never enter the event or notification payload.

## Consequences

Either contractual party can preserve and share its case record without
changing commercial or reputational truth. Closed/resolved history can remain
readable while content mutation is denied. R4-022 can add state transitions,
party requests and exceptional audited Job operations through the existing
capability- and MFA-gated admin boundary without retrofitting an unsafe ordinary
user control or rewriting the original case history.

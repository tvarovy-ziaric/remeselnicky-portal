# ADR 0014: Job participation and work-group identity

- Status: Accepted for R4-008 implementation
- Date: 2026-09-16
- Tickets: R4-008/R4-009

## Context

D03/D17 distinguish the primary contractual provider, a reusable Crew, a
specific person's accepted Job participation and a concrete JobWorkGroup.
Crew membership is non-exclusive and does not imply participation in every
Job. People may join after work starts, leave, later rejoin, perform multiple
roles/professions, or work in multiple groups. Reviews and verified work
evidence must point to the historical JobParticipant/group composition, not
to today's Crew roster or the primary company's owner.

## Decision

`crews` identifies a reusable relationship. `job_participants` identifies
one invited participation interval for an INDIVIDUAL CraftsmanProfile on one
Job; a later rejoin uses a new ID rather than reopening an old interval.
`job_work_groups` identifies a concrete group on one Job, optionally linked
to a Crew. The optional Crew link never auto-imports standing members into
the Job group. A participant may be assigned to multiple groups or none.

Identity rows are immutable. Append-only events record participant and Crew
acceptance/departure, concrete group membership intervals and additional
job-specific roles; `MEMBER` derives from accepted Job participation. R4-009
will expose guarded lifecycle commands and add participant-confirmed
profession/skill assignments. An invitation alone must never appear as
verified participation or generate individual work evidence. A primary
provider's ownership/contract never automatically creates a JobParticipant.
Customer and participant reads will be authorized against the Job and current
verified state, not simply a shared Crew ID. Operational group membership
remains separate from the bilateral winning conversation; alpha adds no
group chat.

The first migrations provide the identity/history foundation with strict
server/DB actor and Job checks. The private roster read projection and Web
display are implemented locally, but no public mutation or deployment is
enabled until lifecycle commands pass their negative tests.

## Verification to date

Migrations `0069`–`0073` applied and replayed in fresh isolated PostGIS
integration runs. Tests inserted an authorized Crew, Crew membership,
JobParticipant invitation/acceptance/departure, overlapping job-specific
roles, a JobWorkGroup and two explicit membership intervals. They rejected
wrong-party creation/actions, unaccepted participation as verified work,
implicit Crew-to-Job membership, skipped sequences, duplicate active group
assignment, event/identity mutation and post-cancellation creation or
acceptance. The public Alpha database was not migrated for this incomplete
ticket.

R4-008 subsequently added the customer/provider-only roster read projection,
cursor API and Job-page display. Pending/declined invitees are provider-only
and never verified evidence. Clean PostGIS migration/replay, repository/API/Web
negative tests and the full workspace check passed. Public synthetic deployment
is deferred to R4-009 command integration; no real-user rollout is implied.

R4-009 uses the immutable invitation command ID on `JobParticipant` and the
participation event ID as the decision command ID. Job-row locking plus a
database duplicate-current guard serialize concurrent invitations. Only an
explicit accepted participation is added to the Job-wide timeline; a pending
or declined invitation remains private to the primary provider and invitee.
Participant departure reasons stay in append-only history but are not copied
to the customer-visible system timeline. The initial HTTP/Web flow and these
invariants passed clean PostGIS and full workspace checks locally; synthetic
deployment remains pending the rest of R4-009.

Additional operational roles are separate append-only role events, not changes
to the `JobParticipant` identity. `MEMBER` remains derived from an accepted,
currently active participation; it cannot be assigned or revoked through a
role command. The primary provider's assignment/revocation command locks the
Job and participant, requires accepted participation on a non-cancelled Job,
and uses the role-event ID as its idempotency key. A repeated assignment or a
revoke without an active interval is a stale-state response. Customer roster
reads can see the role history, but only the primary provider sees the edit
controls. Clean PostGIS and full workspace checks passed for this locally;
it has not been deployed to the synthetic Alpha.

Concrete JobWorkGroups can be created only by the active primary provider on
an active confirmed Job. The group identity may be empty; a bounded private
primary-party list makes such groups discoverable without exposing any reusable
Crew roster. Assignments require an already accepted JobParticipant and are
new immutable intervals; LEAVE by the participant and REMOVE by the provider
append a departure event. The assignment ID, not merely group/member IDs,
identifies the interval to end. The create/assign identity UUID and departure
event UUID serve as stable command IDs. Private roster and Web controls retain
the historical intervals and never imply that a Crew member worked on a Job.
The Job group commands passed clean PostGIS and workspace checks locally;
synthetic public deployment remains pending.

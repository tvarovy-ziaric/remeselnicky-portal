# ADR 0015: Operational progress and Issue history

- Status: Accepted for R4-010 implementation
- Date: 2026-09-17
- Ticket: R4-010

## Context

D17 permits lightweight progress updates, customer reading/acknowledgment and
operational Issue markers on an accepted Job. These records must not rewrite
the accepted agreement, open a dispute automatically, create a `PAUSED` Job
state, or become a construction diary. D25 calls for in-app notice of ordinary
progress, with higher attention for explicit Issues, while keeping messages
privacy-minimal.

## Decision

Progress updates and Issues are private, append-only Job records with server
timestamps, explicit author provenance and stable command identities. A
primary provider can post progress; either primary party can record an Issue.
Customer acknowledgment of an update is an independent read/UX fact and is
never acceptance of work, a commercial change or completion. Either primary
party may append a comment to an Issue, preserving disagreement rather than
editing the original text. An Issue is an operational marker, not a dispute
case, and its kind (`PROBLEM`, `DELAY`, `WAITING`) does not alter the D04 Job
state. Records remain readable after cancellation; new records require an
active confirmed Job. Every read and write is server-authorized against the
exact Job and ACTIVE account.

The records emit transactional, privacy-minimal outbox events for in-app
notices: ordinary progress is INFO and an explicit Issue is IMPORTANT. Both
link to an exact privately authorized record; neither event contains the body,
address, contact detail or media key. A record may link at creation to up to
five already READY, private Job-conversation media assets from the exact
winning conversation: photos for progress, photos/PDFs for Issues. Links are
immutable and only valid inside the record's creation transaction. The
original media retains uploader, capture/upload time and private delivery
authorization; no bytes or storage keys are copied into operational records.
Neither progress nor an Issue is an accepted-scope/price mutation; material changes
must use D19 Change orders. No progress acknowledgment is required for D20
completion.

## Verification plan

Fresh PostGIS migration/replay and direct-SQL authorization/immutability
checks; repository, HTTP and Web negative tests for wrong party, suspended
account, cancelled Job, malformed/stale/idempotent commands, pagination and
field leakage; synthetic public E2E after the full R4-010 slice is wired.

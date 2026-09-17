# ADR 0012: Append-only Job execution lifecycle

- Status: Accepted and implemented for R4-006 synthetic Web Alpha
- Date: 2026-09-16
- Ticket: R4-006

## Context

D04/D17 require an explicit provider-authored start, cancellability from
`CONFIRMED` and `IN_PROGRESS`, immutable server-side timestamps/actors, a
reasoned cancellation and preserved history. The accepted `jobs` identity and
commercial agreement are already immutable. Updating `jobs.initial_state`
would conflate the accepted historical state with current execution state.

## Decision

Keep `jobs.initial_state = CONFIRMED` immutable. Authorized commands append
one `START` and at most one `CANCEL` record per Job. A current-state view
derives `CONFIRMED`, `IN_PROGRESS` or `CANCELLED` from those records. The
command trigger locks the Job row, active/verified actor and credentials,
checks exact primary-party ownership and expected state, and stamps the time
on the server. Only the primary provider may start; either primary party may
cancel with a reason. Replays use an exact command ID and payload fingerprint;
a changed intent cannot reuse an ID. A cancellation never deletes agreement,
participant evidence, documents, or conversation.

The lifecycle command is the source of chronological system events. An
outbox event notifies the other primary party on start/cancellation using a
privacy-minimal payload; reason stays inside the authorized Job view and is
not copied into notification payloads, analytics or logs. A planned date
never advances state automatically. Main `PAUSED` state is not introduced.

The Postgres `job_state` enum is extended in its own migration because a new
enum label cannot be used in the same transaction that adds it. The following
migration creates commands/current-state projections. Session/CSRF-guarded
HTTP commands and role-aware Web controls are enabled only in the isolated
synthetic alpha.

## Verification

Clean PostGIS migrations `0000`–`0068` applied and replayed. Integration
exercised actual confirmed Jobs, rejected a customer start and stale state,
verified provider start/customer cancellation and identical-command replay,
preserved accepted scope and Quote, denied event mutation and confirmed
privacy-minimal outbox payloads. Focused API/Web/notification tests and the
full workspace check passed. The synthetic Quick Tunnel update succeeded
after backup; public browser E2E verified both actions, competitor denial,
reasoned timeline and agreement preservation. The existing acceptance path
passed its Chromium regression suite. No real-user rollout is approved.

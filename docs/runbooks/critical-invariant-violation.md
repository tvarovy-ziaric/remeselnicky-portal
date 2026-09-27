# Critical invariant violation

## Meaning

The read-only D29 checker found an impossible commercial, privacy or privileged-audit state, or the checker itself has not completed successfully for 15 minutes. The checker never repairs data and its metrics contain only a bounded invariant name and aggregate count.

## First diagnostics

1. Confirm the alert environment and `release_revision`; do not use identifiers from another environment.
2. Check `portal_invariant_check_success`, `portal_invariant_last_check_timestamp_seconds` and the non-zero `portal_invariant_violations{invariant=...}` series.
3. Review worker errors for `operational_invariant_violation` or the checker exception. Logs must not be expanded with bodies, addresses, contact data, review text or dispute evidence.
4. If the checker failed, verify PostgreSQL readiness and migration alignment before interpreting the absence of findings as healthy.
5. In an approved operator session, run only the matching read-only diagnostic query from the repository implementation and retain the minimum opaque IDs needed for the incident timeline.

## Safe mitigation

- Stop a rollout when the alert first appears after a release and keep the prior release available for rollback.
- If a privacy boundary may be affected, disable only the implicated public projection or feature through an existing reversible deployment control.
- Preserve database, audit and application evidence. Do not delete, rewrite or manually “fix” commercial history.
- Any correction must use an existing audited D23 exceptional command or a separately reviewed recovery plan.

## Escalation

Treat a confirmed violation as critical. Assign the named incident owner, record detection/start timestamps, affected invariant and release, and involve security/privacy ownership when the finding concerns public fields, sealed reviews or privileged audit. A real-data correction or scope change is a HUMAN GATE.

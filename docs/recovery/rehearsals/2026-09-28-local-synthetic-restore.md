# R4-029 local synthetic restore rehearsal — 2026-09-28

Status: **PASS for isolated local synthetic database recovery only**.

This run did not use a provider backup, production data, existing staging
database, persistent Docker volume, external account or paid service. It does
not satisfy the provider/staging/production D30 gates by itself.

## Bounded evidence

- Run ID: `local-synthetic-restore-20260928-a33f8d3d`
- Canonical verifier status: `passed`
- Started: `2026-09-27T22:31:38.763Z`
- Completed: `2026-09-27T22:31:42.318Z`
- Environment marker: `staging` inside a disposable local network
- Data class: `synthetic`
- Archive SHA-256:
  `2af2ef3edcc25170a997da9206913acbac2de924b43cfd18ec7cc20b326a1e27`
- Restore target: a newly created generated `portal_restore_verify_*` database
- PostGIS: present
- Migration ledger: present; latest version `114` (`0114`)
- Core `users` table: present
- Synthetic marker: restored exactly once
- D29 operational invariants: seven checked, zero violations
- Privacy tombstone reapplication: correctly not required for synthetic input
- Credentials or personal data in evidence: none
- Existing staging touched: no
- Temporary container/network: removed after the run
- Persistent Docker volume: none created

## Procedure exercised

The helper `infra/postgres/recovery/rehearse-local-synthetic-restore.ps1`
created a generated Docker network and tmpfs PostGIS database, applied the
current migration set, inserted one fixed synthetic marker, produced a
custom-format archive and invoked the canonical fail-closed restore verifier.
The verifier created a new target, restored in one transaction and emitted its
append-only credential-free JSON evidence. A separate read-only check confirmed
the marker and all bounded operational invariants before cleanup.

The first wrapper attempt produced a valid canonical restore PASS but failed a
later helper-only invariant connection because `createDatabase` received the
wrong argument shape. The generated container/network were still removed. The
wrapper was corrected and the complete run above passed. This was a tooling
defect, not a restore or data-integrity defect.

## Open D30 gates

- provider-created staging backup and dedicated audited recovery credential;
- automatic production backup monitoring and tested alert receiver;
- concrete private/public media recovery mapping and object inventory check;
- approved retention mapping and complete production privacy transformations;
- named incident owner/reviewer and staging rehearsal sign-off.

Until those gates are resolved, R4-029 is locally implemented and rehearsed but
provider staging/production recovery remains unverified.

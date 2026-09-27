# Backup and recovery operational-readiness checklist

Use this checklist for every restore rehearsal and before any real-user alpha
go/no-go. A checked local item is not evidence that a provider backup, staging
environment or production recovery path has been verified.

## Authorization and isolation

- [ ] Name the accountable operator, incident owner and reviewer.
- [ ] Classify the source as `synthetic`, `anonymized` or `production`.
- [ ] Confirm the destination environment marker independently of shell input.
- [ ] Use a dedicated audited recovery principal, never the application role.
- [ ] Create a new `portal_restore_verify_*` database; never overwrite or
      promote an existing application database during verification.
- [ ] Confirm that staging and production networks, credentials, databases,
      buckets and provider/test configuration are isolated.
- [ ] Record the exact destructive-action acknowledgement required by the
      canonical verifier. Cleanup is a later, separately reviewed action.

## Backup and restore inputs

- [ ] Record the non-secret provider backup-job reference and recovery point.
- [ ] Verify custom-format archive readability and SHA-256 against the provider
      manifest before mutation.
- [ ] Confirm automatic backup success, age and schedule adherence monitoring.
- [ ] Confirm the expected migration version from the backup manifest.
- [ ] For production-class data, supply the independently approved normalized
      privacy tombstone ledger and its reviewed digest.
- [ ] Confirm critical private-object recovery scope, versioning/snapshot
      behavior, encryption, lifecycle/expiry and integrity evidence.

## Verification before any traffic

- [ ] Run `infra/postgres/recovery/verify-restore.mjs` and retain its
      credential-free append-only evidence.
- [ ] Verify PostgreSQL, PostGIS, migration ledger/version and core schema.
- [ ] Verify representative synthetic/anonymized records and run all bounded
      D29 operational invariant checks read-only.
- [ ] Compare database media references with the protected object inventory;
      investigate missing objects and orphaned references without rewriting
      immutable history.
- [ ] Re-evaluate public derivative visibility from current authorization and
      consent state rather than blindly restoring publication.
- [ ] For production-class data, require matching reapplicator and database
      attestations before traffic, indexing, notifications or media delivery.
- [ ] Exercise a second verification or reviewed spot-check sufficient to
      detect archive/restore drift.

## Evidence, defects and cleanup

- [ ] Complete `restore-evidence.template.md` without URLs, credentials, object
      keys, filenames, row contents or personal data.
- [ ] Record PASS/FAIL, severity, owner and due date for every defect.
- [ ] Treat failed restore, missing backup, broken tombstone reapplication or
      critical media loss as a serious operational problem and launch no-go.
- [ ] Keep the isolated target unreachable by application traffic.
- [ ] Delete only the exact reviewed verification target after evidence review;
      never use wildcard cleanup.
- [ ] Schedule the next rehearsal and verify that alert recovery/resolution is
      observable.

## R4-029 evidence status — 2026-09-28

| Gate                                           | Status             | Evidence / remaining requirement                                                                                                                                                       |
| ---------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local isolated synthetic PostgreSQL restore    | PASS               | `2026-09-28-local-synthetic-restore.md`; canonical verifier, migration `0114`, one exact marker and seven zero-violation invariant checks passed.                                      |
| Existing staging safety                        | PASS for local run | The helper used a generated network, tmpfs database and generated names; no existing staging container, network or volume was addressed.                                               |
| Provider-created staging backup restore        | NOT VERIFIED       | Requires an approved staging provider/account, dedicated recovery credential and real provider backup-job reference.                                                                   |
| Automated production DB backups and monitoring | NOT PROVISIONED    | External provider/account, retention mapping and alert receiver remain HUMAN GATES.                                                                                                    |
| Critical media/object recovery                 | POLICY ONLY        | Provider-neutral policy exists; concrete bucket/versioning/inventory/integrity mapping and rehearsal remain unverified.                                                                |
| Production deletion-state reapplication        | PARTIAL / BLOCKED  | Canonical fail-closed hook exists for reviewed `NOTIFICATION_DELIVERY + DELETE`; independent ledger and remaining reviewed transformations are not authorized for real-user operation. |
| Incident ownership and critical alert channel  | NOT PROVISIONED    | Named owner/escalation path and tested receiver require a human/account decision.                                                                                                      |

The current state supports synthetic local engineering verification only. It is
not a staging provider rehearsal, production-readiness claim or D30 go/no-go.

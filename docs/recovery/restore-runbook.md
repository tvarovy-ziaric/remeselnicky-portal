# Isolated PostgreSQL restore verification runbook

Use this runbook to prove that a backup can be restored. The verifier only
creates a new database named `portal_restore_verify_*`; it never overwrites or
drops a database and never promotes a restored database into service.

## Preconditions

1. Use a dedicated, audited recovery principal. Do not use the application
   runtime login. It needs only connect/read-system-catalog/create-database and
   the privileges needed to restore the archive into the new target.
2. On the isolated staging or recovery principal, configure a server-side marker
   such as `ALTER ROLE <dedicated_role> SET portal.environment = 'staging';`
   (use `recovery` for an isolated production-data recovery environment), then
   reconnect and verify it. Never set this marker on a production application
   role.
3. Fetch a provider-created PostgreSQL custom-format archive through the
   provider's audited recovery path. Do not paste credentials into the shell
   history or evidence.
4. Use synthetic/anonymized data in staging. Production-class data is permitted
   only in a separately marked `recovery` environment. The canonical
   reapplicator is implemented, but the normalized ledger must come from the
   separately authorized independent ledger and must be approved by digest.
5. Determine the expected latest migration version from the backup manifest,
   not by guessing from the current checkout.

## Execute

Set all values through the approved secret/runtime mechanism. The URLs are read
by the process and translated into libpq environment variables so passwords are
not placed in child-process arguments.

```powershell
$env:RECOVERY_EXPECTED_ENVIRONMENT = "staging"
$env:RECOVERY_DATA_CLASS = "synthetic"
$env:RECOVERY_RUN_ID = "restore-20260914-a"
$env:RECOVERY_ACKNOWLEDGEMENT = "CREATE_NEW_ISOLATED_DATABASE_ONLY"
$env:RECOVERY_SOURCE_ARCHIVE = "C:\secure-recovery\staging.dump"
$env:RECOVERY_EVIDENCE_DIRECTORY = "C:\secure-recovery\evidence"
$env:RECOVERY_EXPECTED_MIGRATION_VERSION = "2"
$env:RECOVERY_TARGET_DATABASE = "portal_restore_verify_20260914_a"
$env:RECOVERY_ADMIN_DATABASE_URL = "postgresql://recovery_user:REDACTED@staging-db.internal:5432/postgres?sslmode=verify-full"
$env:RECOVERY_TARGET_DATABASE_URL = "postgresql://recovery_user:REDACTED@staging-db.internal:5432/portal_restore_verify_20260914_a?sslmode=verify-full"
node infra/postgres/recovery/verify-restore.mjs
```

The verifier checks the archive format before mutation, validates the
server-side environment marker, rejects an existing target, creates the new
isolated database, restores in one transaction, and verifies PostGIS, the
migration ledger, exact migration version and core schema. It creates a
credential-free JSON evidence record with restrictive file permissions where
supported. Evidence files are append-only by run ID.

For production-class input, additionally supply the canonical reapplicator,
the normalized independent ledger and its approved SHA-256 digest:

```powershell
$env:RECOVERY_TOMBSTONE_REAPPLICATOR = "infra/postgres/recovery/reapply-privacy-tombstones.mjs"
$env:RECOVERY_TOMBSTONE_LEDGER = "C:\secure-recovery\normalized-privacy-ledger.jsonl"
$env:RECOVERY_TOMBSTONE_LEDGER_SHA256 = "<64 lowercase hex characters>"
```

The UTF-8 JSONL ledger has exactly one header followed by its declared number
of records. The header schema is
`PORTAL_PRIVACY_RECOVERY_LEDGER` version 1. Each exact tombstone contains only
its IDs, subject ID, category, disposition, policy-version ID, independent
receipt digest and source timestamp. Duplicate IDs, extra fields, malformed
records, an incorrect digest, unsupported category transformations or an
incomplete record count fail the entire database transaction.

The verifier runs the reapplicator after restore and before schema evidence is
marked passed. It requires matching content-free attestations from the hook and
the restored database. The reapplicator receives target libpq settings, ledger
path, digest and run ID through the environment, never command-line secrets.
At this checkpoint only reviewed `NOTIFICATION_DELIVERY + DELETE` tombstones
are executable; they delete subject-owned provider-delivery metadata while
preserving canonical notifications. Any other category intentionally blocks
the restore until a dedicated reviewed transformation exists.

## Review and cleanup

1. Compare the JSON evidence with
   `docs/recovery/restore-evidence.template.md`; attach provider backup-job and
   monitoring references without copying secrets or personal data.
2. In a restricted session, perform read-only consistency checks and the media
   inventory comparison. Do not auto-repair immutable commercial history.
3. For a production-class recovery, verify that the attested read/applied/
   already-applied counts exactly match the approved ledger, then independently
   confirm deletion, anonymization, profile deindexing and withdrawn
   public-media state before any traffic can reach the database.
4. Record the rehearsal outcome and follow-ups. Restore failure is a serious
   operational problem.
5. Cleanup is intentionally not automated. After evidence review, an authorized
   operator may drop only the exact `portal_restore_verify_*` database under a
   separate, reviewed change. Never copy a wildcard cleanup command from this
   runbook.

Actual staging execution, provider backup activation, alert-channel wiring,
media-provider mapping and any real production recovery are outside this local
scaffold. They require the appropriate environment/account access; provider or
paid-service selection is a HUMAN GATE and the first-user go/no-go remains D30.

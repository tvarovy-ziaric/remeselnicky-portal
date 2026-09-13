# Backup and media recovery policy

Status: provider-neutral R0 baseline; provider activation remains required.

This policy implements the D26/D27/D29/D30 recovery boundary without selecting
or contacting an infrastructure vendor. `infra/postgres/recovery/backup-contract.example.yaml`
is the machine-readable provisioning contract. A staging and a production
mapping of that contract must be reviewed before real-user alpha.

## Database backups

- Staging and production use separate, provider-managed automatic backups.
- Daily recovery points are the minimum plan. Point-in-time recovery is enabled
  when the selected PostgreSQL provider supports it.
- Backup success, backup age and schedule adherence must be monitored. A missed
  production backup is an operational incident, not a dashboard-only warning.
- Database and backup storage use provider-managed encryption at rest and TLS in
  transit. Backup credentials are separate from the application runtime role,
  least-privileged, rotatable and audited.
- The selected retention duration comes from the D27 retention matrix and legal
  review. It must not be guessed in infrastructure code. Provider rotation and
  expiry must implement that value once approved.
- Staging restore rehearsals use synthetic or anonymized data. Production
  personal data is never copied to staging merely to test recovery.

## Media recovery

The storage provider is deliberately unselected. Selecting a vendor, account,
paid service, credentials or new personal-data flow is a HUMAN GATE. Whichever
provider is approved must map these outcomes to concrete controls:

| Data class                                                                   | Required recovery outcome                                                                                                                             |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private canonical Job/chat/dispute/credential objects still inside retention | Encrypted, non-public recovery copy or provider version; restore preserves private access and object identity.                                        |
| Immutable commercial PDF/document attachments still inside retention         | Recoverable with integrity evidence; never reconstructed from mutable application state.                                                              |
| Public derivatives                                                           | Prefer rebuilding from an authorized private canonical object; otherwise protect a recoverable copy. Public visibility is re-evaluated after restore. |
| Discarded upload originals and expired quarantine                            | Not backed up as a long-term archive and not restored after policy expiry.                                                                            |
| Deleted, anonymized or consent-withdrawn objects                             | Normal rotation expires old copies; restore never republishes or reactivates them.                                                                    |

Provider mapping must record automatic versioning/snapshot support, cross-account
or failure-domain isolation where available, encryption/key ownership, lifecycle
and expiry behavior, object inventory, checksum/integrity evidence, deletion
propagation, monitoring, restricted recovery access and the tested restore
procedure. Database references and media objects may be recovered to different
points in time, so the rehearsal must also detect missing objects and orphaned
references. It must not silently invent or delete business history to repair
them.

## Deletion/anonymization continuity

D27 permits deleted or anonymized data to remain transiently in backups only
until normal rotation. Every privacy deletion/anonymization workflow implemented
later in R4-026 must therefore emit an append-oriented recovery ledger outside
the recoverable application snapshot. The ledger needs the subject/object
locator necessary for reapplication, action (`DELETE`, `ANONYMIZE`, `HIDE`, or
`REVOKE_PUBLIC_MEDIA`), effective time, policy version and integrity evidence;
it must contain no more personal data than necessary for that purpose.

After any production-class restore and before traffic, exports, indexing,
notifications or media publication are enabled, an idempotent reapplicator must
apply all ledger entries effective after the backup recovery point. It must
cover database rows, search indexes/caches, public object delivery and derived
media. The reapplication result is evidence-reviewed by the incident/privacy
owner. `verify-restore.mjs` fails closed for production-class input unless that
future reapplicator and ledger are supplied and the hook succeeds.

This R0 baseline does not claim that R4-026 exists, that a provider is active,
or that a staging rehearsal has passed. Those are explicit pre-alpha gates.

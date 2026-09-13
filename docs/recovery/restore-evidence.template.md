# Restore rehearsal evidence

Do not include database URLs, credentials, object keys, signed URLs, personal
data, row contents or uploaded filenames.

- Run ID:
- Environment (`staging` or isolated `recovery`):
- Data class (`synthetic`, `anonymized`, or `production`):
- Operator / accountable incident owner:
- Started / completed (UTC):
- Source backup job reference (non-secret):
- Backup recovery point (UTC):
- Backup schedule/age alert state:
- Verifier JSON evidence path/reference:
- Archive SHA-256 matches provider manifest: yes/no
- Restored database is newly created and isolated: yes/no
- PostgreSQL/PostGIS and migration-version checks passed: yes/no
- Read-only consistency checks passed: yes/no
- Critical private-media inventory/integrity check passed: yes/no/not in scope
- Public derivative visibility re-evaluated: yes/no/not in scope
- Tombstone deletion/anonymization state reapplied: yes/no/not required
- No production personal data copied to staging: yes/no
- Restore target remained unreachable by application traffic: yes/no
- Cleanup change/reference:
- Overall result (`PASS` / `FAIL`):
- Defects, severity, owner and due date:
- Reviewer/sign-off:

A `PASS` is not a production launch approval. Before real-user alpha, the
provider mapping, automatic production backup monitoring, successful staging
restore evidence, D27 retention/legal review, R4-026 tombstone workflow and D30
go/no-go must all be complete.

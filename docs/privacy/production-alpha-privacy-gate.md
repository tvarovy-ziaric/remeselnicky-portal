# Production Alpha privacy HUMAN GATE

Status: `SHORTLIST PREPARED — BLOCKED PENDING REVIEWER/PROVIDER SELECTION`

This gate applies before the first real-user production Alpha. It does not
block synthetic development or CI, and it does not authorize a vendor, account,
credential, data transfer, legal conclusion or spend.

The human authorized option 1 on 2026-09-25: prepare a named legal/privacy
review and independent-ledger shortlist only. The resulting no-spend research,
prices, account requirements, credential boundaries and comparison are recorded
in [Legal and recovery-ledger shortlist](./legal-and-recovery-ledger-shortlist.md).
No firm was contacted and no provider account or resource was created.

## Technical baseline already implemented

- explicit public/private projections and deny-by-default authorization;
- versioned optional-consent and policy evidence;
- recent-MFA privacy-request and account-closure operations;
- immediate account/profile deactivation and deindex behavior without cascade
  deletion of shared marketplace history;
- separate, withdrawable Job-property-photo publication consent;
- category-specific reviewed disposition decisions, receipt-gated resumable
  jobs and immutable execution evidence;
- one narrow executor for `NOTIFICATION_DELIVERY + DELETE`;
- verified subject-only access/portability base bundle with explicit assisted
  supplements and no raw credential, storage or other-person message leakage;
- provider-neutral, atomic and idempotent restore tombstone reapplication with
  independent-ledger digest and database attestation.

These controls prove the architecture, not legal readiness or complete erasure
coverage. Unsupported disposition categories fail closed.

## Decisions and external inputs required

| Gate input             | Required decision/evidence                                                                                                                            | Why code cannot choose it                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Controller identity    | Legal entity, controller contact and named internal privacy owner                                                                                     | This identifies accountable people/entities.                       |
| Slovak/EU review       | Named qualified reviewer and approval record                                                                                                          | D27 forbids guessed legal bases, periods and wording.              |
| Purpose/basis register | Approved purpose, data categories, data subjects, lawful basis, recipients and balancing/obligation reference per purpose                             | A generic basis per table is insufficient.                         |
| Retention matrix       | Exact trigger, period, disposition, exceptions/holds, processor propagation and backup maximum for every seeded category                              | These values determine destructive behavior.                       |
| Rights handling        | Reviewed rules for shared Job/chat/commercial exports, third-party redaction, correction annotations, objections and lawful non-deletion explanations | Other people's rights and legal obligations require case review.   |
| Legal documents        | Approved separate Privacy Notice and Terms plus only the optional consent text actually used                                                          | Registration cannot become blanket consent.                        |
| Processors/transfers   | Selected production vendors, DPA/subprocessor evidence, region and transfer mechanism where applicable                                                | No production provider or geography is authorized yet.             |
| Recovery ledger        | Independent append-only ledger service/account, retention, recovery access and incident owner                                                         | A tombstone kept only in the restored database is not independent. |
| Incident readiness     | Named escalation roles, supervisory-authority/user decision workflow and DPIA screening approval                                                      | Notification/DPIA decisions require accountable human review.      |
| Launch decision        | D30 production go/no-go and initial invite cohort                                                                                                     | Real-user rollout is an explicit human gate.                       |

## Required accounts and credentials

No new account or credential is required for the current local/CI baseline.
Before production, the approved operators must provision through the selected
secret manager:

1. an independent-ledger append identity used only by the privacy disposition
   publisher;
2. a separate read/recovery identity usable only in the isolated recovery
   environment;
3. named, individual privileged administrator identities with the approved MFA
   provider and no shared account;
4. processor-specific credentials scoped to the minimum production purpose;
5. an audited legal/privacy evidence location for approvals, processor records
   and signed policy versions.

Secrets, raw ledger receipts, exported personal data and legal evidence do not
belong in Git, CI logs, application logs or the ordinary application database.

## Security boundaries for the independent ledger

- The application can append one normalized tombstone and receive a bounded
  opaque receipt; it cannot list, rewrite or delete the ledger.
- Recovery read credentials are unavailable to the application runtime and to
  the normal deployment pipeline.
- Records contain only exact tombstone/subject/policy identities, category,
  disposition, timestamp and receipt evidence—never request bodies, addresses,
  messages, documents or provider secrets.
- At-rest/in-transit encryption, append immutability, access audit, EU/EEA
  region preference and an approved finite retention are mandatory.
- Restore occurs in a new isolated database owned by the recovery principal.
  Unsupported transformations or mismatched counts/digests roll back the whole
  replay; no traffic promotion follows automatically.
- Backup rotation does not replace the independent tombstone ledger, and the
  ledger does not replace category executors or legal review.

## Provisioning plan after approval

1. Legal/privacy reviewer approves the controller model, purpose/basis register,
   retention matrix, shared-record rights rules, incident/DPIA screening and
   document wording.
2. Human selects and authorizes the production providers, contracts, regions,
   subprocessor/transfer posture and maximum monthly spend.
3. Operators create named accounts and least-privilege credentials; no shared
   admin or application access to recovery reads is permitted.
4. Engineering implements only the approved category transformations and maps
   every processor deletion/retention action to the reviewed matrix.
5. Security verifies append-only ledger behavior, credential separation,
   rotation/revocation, auditability and failure isolation with synthetic data.
6. A production-class restore rehearsal replays an approved synthetic ledger
   and produces matching hook/database evidence. Real personal data is not used
   for the rehearsal unless separately authorized.
7. Privacy/admin UAT exercises access, rectification, erasure, restriction,
   portability, objection, closure, lawful retention explanation, photo-consent
   withdrawal and incident escalation.
8. D30 go/no-go reviews the evidence and explicitly authorizes—or rejects—the
   first real invite cohort.

## Cost boundary

Current incremental cost is **EUR 0**: local code and CI use synthetic data and
no new service has been provisioned. Production cost is intentionally
`NOT AUTHORIZED`. The research shortlist records public usage-based pricing and
where a quote/calculator export is still required, but no binding estimate is
possible until the human chooses the reviewer candidates, provider, region,
durability/immutability tier, retention, traffic and support level. Any quote
or free-tier claim must be revalidated against current official pricing before
approval.

## Exact human decision requested

Choose which shortlisted legal firms may be contacted for fixed-scope quotes,
which ledger options may receive a non-binding calculator/design comparison,
the proposed internal privacy/incident owner, and legal/monthly-ledger budget
ceilings. This authorizes requests and planning only. Engagement, provider
selection, contract acceptance, account creation, credentials, provisioning and
real-user rollout each remain separately gated.

Until then, keep production disposition jobs, production-class restore and
real-user rollout disabled. Do not weaken the fail-closed policy to advance the
schedule.

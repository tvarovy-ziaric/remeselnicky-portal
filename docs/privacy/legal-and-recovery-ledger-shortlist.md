# Production Alpha legal and recovery-ledger shortlist

Status: `RESEARCH ONLY — NO ACCOUNT, ENGAGEMENT OR SPEND AUTHORIZED`

Checked: 2026-09-25

This package records the shortlist authorized by the human selection of option
1 in the [Production Alpha privacy HUMAN GATE](./production-alpha-privacy-gate.md).
It is not legal advice, a vendor approval, an instruction to contact a firm, or
authorization to accept terms, create an account, provision a resource, upload
data or incur cost.

## Recommendation

Request the same fixed-scope written proposal from **Kinstellar Slovakia** and
**CMS Slovakia**. Keep **Dentons Bratislava** as the third comparison. Do not
select solely on hourly rate: the deliverable must include a signed-off
purpose/basis register, retention matrix, shared-record rights rules, processor
and transfer review, launch documents, DPIA screening and incident workflow.

For the independent recovery ledger, carry **AWS S3 Object Lock in a separate
AWS account and EU region** as the technical front-runner. It has the strongest
documented compliance-mode boundary: a protected version cannot be deleted by
any user, including the account root, during retention. Carry **Azure immutable
Blob Storage** as the enterprise alternative and **Backblaze B2 Object Lock in
EU Central** as the cost-sensitive S3-compatible alternative. Backblaze needs
an additional answer for immutable access-log custody because its bucket access
logs must be written to a non-Object-Lock bucket in the same account.

No provider may be chosen until the legal reviewer approves the ledger data
fields, lawful purpose, finite retention and transfer posture.

## Legal/privacy reviewer shortlist

All three candidates have a Bratislava presence and publicly identify relevant
data-protection work. None publishes a rate card for this scope; price is
therefore **quote required**. A conflict check, exact contracting entity,
professional-liability terms, confidentiality terms, named lead and Slovak-law
coverage must be confirmed before engagement.

| Priority | Candidate                                                                                                                      | Publicly verifiable fit                                                                                                                                                                                                                                               | Required proposal                                                                                                         | Price                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1        | [Kinstellar Slovakia — Lukáš A. Mrázik](https://www.kinstellar.com/locations/people/detail/bratislava-slovakia/mrazik-lukas-a) | Bratislava counsel and co-head of Data & Cybersecurity; the published profile covers GDPR programmes, DPIAs, transfer-impact assessments, DPAs, breach response and policies.                                                                                         | Fixed scope, named reviewer, redline and approval record for every launch deliverable.                                    | Quote required; no public rate found. |
| 2        | [CMS Slovakia — Martina Šímová](https://cms.law/en/svk/people/martina-simova)                                                  | Bratislava senior associate whose published practice includes data-protection compliance audits and GDPR implementation; CMS also publishes a current [Slovakia GDPR enforcement guide](https://cms.law/en/svk/publication/gdpr-enforcement-tracker-report/slovakia). | Same fixed scope and output format so proposals remain comparable.                                                        | Quote required; no public rate found. |
| 3        | [Dentons Bratislava — Peter Panek](https://www.dentons.com/en/peter-panek)                                                     | Bratislava counsel with data-protection law and Privacy & Cybersecurity listed in the public profile.                                                                                                                                                                 | Confirm that a dedicated Slovak/EU privacy lead, rather than a general commercial team, will own and sign off the review. | Quote required; no public rate found. |

The shortlist is capability evidence, not a claim that any firm is independent
of all project parties or available. Conflict and availability checks remain
mandatory.

### Mandatory legal-review deliverables

The proposal must price and name an accountable reviewer for one bounded Alpha
package:

1. confirm the controller model, controller contact and whether a formal DPO is
   required;
2. approve a RoPA-ready purpose/basis register covering categories, subjects,
   recipients, processors, transfers and legitimate-interest references;
3. approve an exact retention matrix for every seeded category, including the
   trigger, period, disposition, hold/claim exceptions, processor propagation,
   backup maximum and independent-ledger period;
4. decide access, portability, rectification, restriction, objection, erasure
   and anonymization rules for shared Job, chat, Quote, review, dispute, audit
   and commercial records, including third-party redaction;
5. review the separate Privacy Notice, Terms and the optional Job-property-photo
   consent text, without converting core processing into blanket consent;
6. review the production processor/subprocessor inventory, DPAs, regions and
   any SCC/transfer-impact requirements;
7. approve DPIA screening and state whether a full DPIA is required before the
   first invite;
8. approve the breach workflow, regulator/user notification decision record and
   the 72-hour escalation path; and
9. provide a dated written approval, list of unresolved risks and conditions
   that must be re-reviewed when a purpose, public field, provider or high-risk
   feature changes.

The engagement must explicitly cover Slovak Act No. 18/2018 Coll. and applicable
EU rules at the review date. The reviewer must not be asked to approve guessed
retention periods after code has already made them irreversible.

## Independent recovery-ledger shortlist

The ledger stores only the normalized, content-minimized tombstone contract
already accepted by the restore hook: identifiers for tombstone, subject,
source event and policy, category, disposition, source timestamp and receipt
evidence. It must never receive request narratives, addresses, messages,
documents, exports, credentials or provider secrets.

### Option A — AWS S3 Object Lock (recommended technical baseline)

- **Component:** a private, versioned S3 bucket with Object Lock default
  retention in `COMPLIANCE` mode in an approved EU region, preferably Frankfurt
  (`eu-central-1`); CloudTrail data events retained independently; encryption
  at rest and TLS in transit.
- **Fit:** [AWS documents](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)
  that compliance-mode object versions cannot be overwritten or deleted by any
  user, including root, and that retention cannot be shortened. This directly
  supports immutable append receipts and isolated recovery reads.
- **Account/contract:** a new organization-owned AWS account, separate from the
  staging/production hosting account; named billing, security and privacy
  owners; AWS Customer Agreement and the automatically applicable
  [GDPR DPA](https://aws.amazon.com/compliance/faq/) reviewed before use.
- **Credentials:** a non-human writer role/key restricted to create a new object
  under one ledger prefix and receive bounded version/digest evidence, with no
  list/read/delete/retention-policy rights; a separate recovery role with
  list/read only; named MFA administrators; audit reader; break-glass role held
  outside the application/deployment chain.
- **Region/transfer boundary:** AWS says customers choose the storage region and
  it does not move or replicate customer content outside it without agreement;
  the reviewer must still assess subprocessors, support access and any
  non-EEA transfers using the [AWS privacy material](https://aws.amazon.com/compliance/data-privacy-faq/).
- **Price:** usage-based with no storage commitment; storage, requests,
  CloudTrail data events, audit-log storage, key management and recovery egress
  are separate meters. AWS directs customers to the
  [current S3 price page/calculator](https://aws.amazon.com/s3/pricing/). A
  region-specific calculator export is required before approval; no exact
  monthly amount is claimed here.
- **Gap to close:** prove with synthetic data that the application cannot list,
  read, overwrite, delete, shorten retention or bypass governance; ensure the
  billing/root recovery process cannot expose the recovery credential to the
  runtime; choose the legally approved finite retention before locking it.

### Option B — Azure immutable Blob Storage

- **Component:** a private Blob Storage account/container in an approved EU
  region with versioning and a locked time-based WORM policy; Azure Activity and
  resource logs retained in a separately protected destination; encryption at
  rest and TLS in transit.
- **Fit:** Microsoft documents that a locked time-based policy prevents objects
  from being modified or deleted during retention and cannot be shortened or
  removed. See the official
  [immutable-storage overview](https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-storage-overview).
- **Account/contract:** an organization-owned Microsoft Entra tenant and Azure
  subscription isolated from the application-hosting subscription; named
  billing/security/privacy owners; Microsoft Customer Agreement and current
  [Microsoft DPA](https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA?lang=1)
  reviewed before use.
- **Credentials:** a custom data-plane writer role permitting only new-object
  creation in the ledger container; a separate recovery reader; named MFA
  administrators; log reader; break-glass custody outside runtime and CI.
- **Region/transfer boundary:** deploy into an EU Data Boundary region. Microsoft
  says EU-region configuration stores/processes covered customer and personal
  data inside the boundary, but also documents limited continuing transfers.
  Both the [EU boundary terms](https://www.microsoft.com/licensing/terms/product/PrivacyandSecurityTerms/)
  and exceptions require legal review.
- **Price:** pay-as-you-go storage plus operations, versions, logs and optional
  key management. Microsoft states immutable data uses normal Blob pricing and
  policy operations create transaction charges. A West Europe or North Europe
  [pricing-calculator](https://azure.microsoft.com/en-us/pricing) export is
  required before approval; no exact monthly amount is claimed here.
- **Gap to close:** more adapter work than an S3-compatible target; prove a true
  create-only role without list/read/delete and preserve a stable receipt that
  the existing normalized-ledger SHA-256 check can verify.

### Option C — Backblaze B2 Object Lock (cost-sensitive alternative)

- **Component:** a private B2 bucket in EU Central (Amsterdam) with default
  Object Lock in `compliance` mode, S3-compatible API, server-side encryption
  and TLS; a separate access-log bucket and an approved plan to make those logs
  independently immutable.
- **Fit:** [Backblaze documents](https://www.backblaze.com/docs/cloud-storage-object-lock)
  compliance-mode retention that cannot be removed by a user and can only be
  extended. Standard application keys can be bucket/prefix scoped and the
  console exposes a write-only access type. EU Central stores account data in
  Amsterdam according to the official
  [region documentation](https://www.backblaze.com/docs/cloud-storage-data-regions).
- **Account/contract:** a new organization-owned B2 account created directly in
  EU Central, because region cannot later be changed; named billing/security/
  privacy owners; Terms and the included
  [GDPR DPA](https://help.backblaze.com/hc/en-us/articles/360004146953-Data-Processing-Addendum)
  reviewed before use.
- **Credentials:** one bucket/prefix-limited write-only application key without
  list/read/delete/retention/bypass capabilities; separate read-only recovery
  key; named MFA administrators; audit reader; master key stored only as a
  break-glass secret outside runtime and CI.
- **Region/transfer boundary:** file data can remain in EU Central unless the
  customer directs movement, but Backblaze is US-headquartered. Subprocessors,
  support access and transfer safeguards still need reviewer approval.
- **Price:** the official [B2 pricing page](https://www.backblaze.com/cloud-storage/pricing)
  lists **USD 6.95/TB/month**, the first 10 GB free, free standard API calls and
  Object Lock at no additional charge. Taxes, nonstandard transactions, excess
  egress, log storage and future price changes remain outside that headline;
  revalidate immediately before approval.
- **Gap to close:** official bucket access logs must target a different bucket
  in the same account and that destination cannot have Object Lock enabled.
  Therefore B2 alone does not yet prove immutable access-audit custody. Account
  closure and master-key recovery also need an explicit threat-model answer.

## Security boundary common to every option

The provider test plan must prove all of the following before real data:

- the production application can create a uniquely named record and obtain a
  bounded receipt, but cannot list, read, replace, delete or weaken retention;
- an attempted duplicate key cannot destroy or hide the original protected
  version;
- the recovery principal can list/read but cannot append, delete or alter
  retention, and is absent from application hosts, CI and ordinary deployments;
- only named MFA administrators can change account, billing, IAM, logging,
  lifecycle or retention configuration, and those actions are audited;
- the audit destination is not writable/deletable by the ledger writer;
- encryption, region, public-access blocking, key rotation/revocation, cost
  alerts and account-recovery ownership are documented;
- the approved finite retention permits lawful expiry after its purpose ends;
  legal hold is exceptional and narrowly scoped, never the default workaround;
- an unavailable ledger fails the disposition operation closed and queues a
  bounded retry; it never silently performs deletion without a receipt; and
- a synthetic isolated restore reproduces the ledger digest, record counts and
  hook/database attestations before any traffic-promotion decision.

## Exact provisioning sequence after separate approval

This sequence is a plan, not current authorization:

1. The legal reviewer approves the exact ledger purpose, fields, finite
   retention, region/transfer posture, DPA and processor inventory entry.
2. The human selects one provider, legal contracting entity, region, account
   owner, credential custodians and monthly budget ceiling.
3. A named organization owner creates a new account/subscription that is not
   controlled by the staging application owner, enrolls MFA-protected billing,
   security and break-glass administrators, and enables budget alerts.
4. Operators record accepted terms/DPA, subprocessors, region and transfer
   evidence in the restricted legal/privacy evidence location—not Git.
5. Security reviews a provider-specific Infrastructure-as-Code plan containing
   public-access blocks, encryption, versioning/Object Lock, the approved
   retention, protected audit delivery and explicit deny rules. Final
   compliance retention is never locked while the legal value is provisional.
6. Operators first apply the design to a disposable synthetic test bucket with
   a short approved test retention. They create separate writer, recovery,
   audit and administration identities; secret values enter the approved secret
   manager and never CI output, Git or application logs.
7. The negative acceptance suite proves forbidden list/read/overwrite/delete/
   retention operations for the writer, forbidden append/delete for recovery,
   immutable originals after duplicate names, audited privileged changes and
   revocation/rotation behavior.
8. After the test evidence is reviewed, operators create the production ledger
   bucket/container with the final approved compliance policy and bind only the
   production writer. Recovery access remains disabled or separately vaulted
   until an authorized rehearsal or incident.
9. Engineering connects the provider adapter to the existing normalized JSONL
   digest/receipt contract, exercises outage and retry behavior with synthetic
   records, then performs an isolated restore and compares the hook/database
   attestations.
10. Privacy, security and operations sign the evidence pack. Only a later D30
    go/no-go may enable real-user disposition processing or the first invite;
    provisioning alone never authorizes launch.

## Exact no-spend next phase

No account or billable resource is needed to continue. After a human authorizes
contact, send one identical request for proposal to the selected legal firms.
It should include this gate document, D27, the data-flow/processor inventory,
the draft purpose/basis and retention templates, the privacy API/export format,
the normalized ledger schema and a request for:

- fixed fee or capped fee, VAT treatment and payment milestones;
- named Slovak/EU reviewer and backup reviewer;
- conflict-check prerequisites and expected start/completion dates;
- precise deliverables and number of review/redline rounds;
- assumptions, exclusions and launch-blocking findings; and
- treatment of later provider or policy changes.

In parallel, engineering may prepare provider-neutral Infrastructure-as-Code
**plans only** and a synthetic acceptance checklist for the three storage
options. It must not run an apply, open an account, generate a credential,
accept online terms or upload even synthetic data without the next approval.

## Next human decision required

Choose which legal firms may be contacted for quotes and whether all three
ledger options should receive a non-binding calculator/design comparison. Also
name the proposed internal privacy/incident owner and set a maximum legal-review
budget plus a maximum monthly ledger budget. Those choices authorize requests
and planning only; provider selection, account creation, contract acceptance,
credential generation, provisioning and first-real-user launch remain separate
HUMAN GATES.

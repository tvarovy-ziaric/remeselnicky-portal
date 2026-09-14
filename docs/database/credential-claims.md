# Credential claims and manual review (R1-009)

Migration `0023_credential_claim_review.sql` adds the private credential-claim
boundary required by D08, D23 and D24. It does not publish credential data or
award reputation/ranking points.

## Model

- A claim has an explicit server-governed credential type and one owned active
  craftsman profession. Credentials remain separate from self-declared skills
  and proficiency.
- A type policy records whether evidence is `REQUIRED` or `OPTIONAL`. Policies
  are installed by trusted server/deployment code, are immutable, have no owner
  mutation API, and this migration deliberately seeds no Slovak product
  taxonomy.
- Claims begin `PENDING`. Manual transitions are `PENDING -> APPROVED`,
  `PENDING -> REJECTED`, and `APPROVED -> REVOKED`. Reject and revoke require a
  privacy-safe reason category and reason. Every command has revision CAS and
  exact idempotency provenance.
- `expires_on` is nullable context. An approved claim past that date is treated
  as no longer valid without changing the recorded state or rewriting history.
- Commands, evidence links, decisions and revision snapshots are append-only.
  Revocation changes only current/future validity; historical Job/commercial
  snapshots remain outside this mutable projection and must not be rewritten.

## Evidence privacy and provenance

The owner may attach only an owned `READY` `DOCUMENT` or `IMAGE` asset whose
purpose is respectively `CREDENTIAL_DOCUMENT` or `CREDENTIAL_IMAGE`. The asset
must already carry server-created `CREDENTIAL` provenance for the exact claim
and expected revision, and must have a non-revoked private canonical object.
Approval of a required-evidence type rechecks all of those facts at decision
time, including current object revocation.

Before upload, `prepareEvidenceUpload` locks and rechecks the active owner,
pending claim and exact current revision, then mints the opaque trusted
`ServerMediaProvenance` and matching credential media purpose. Client-provided
claim IDs alone can therefore never manufacture trusted upload provenance.

Owner and review projections expose only allowlisted asset IDs, kinds and
attachment timestamps. They never expose bytes, filenames, hashes, storage
keys, signed URLs, session hashes or audit fingerprints. Evidence delivery
continues through `@portal/media` private delivery with the
`CREDENTIAL_REVIEWER` relation grant; no public derivative is created.

## Admin boundary

`createCredentialReviewService` first authorizes
`admin.credentials.review` with recent MFA. The repository then revalidates and
locks the active base session, privileged session, active account, MFA factor
and qualifying admin role in the same transaction as queue reads or review
writes. A review decision and its minimized `PRIVILEGED_COMMAND` audit event
commit atomically. The audit records actor, capability, server time and state
diff, but no evidence content or authentication material.

The queue order is deterministic (`created_at`, then claim ID). There is no
automated verification or verdict path.

## Integration helper

`runCredentialClaimIntegrationAssertions(sql)` is a standalone helper for the
single clean-migration PostgreSQL integration suite. It covers ownership,
READY/private evidence, required-evidence approval, CAS/idempotency, immutable
history, capability/MFA denial, revoked evidence, and suspension/revocation
races. It is intentionally not wired into `migration.integration.test.ts` by
this ticket owner.

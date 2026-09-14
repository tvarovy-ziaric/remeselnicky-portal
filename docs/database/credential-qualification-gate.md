# Credential qualification gate (R2-006)

Migration `0032_credential_qualification_gate.sql` separates two concepts that
must not be conflated. The R1 credential type policy says whether documentary
evidence is required before an administrator may approve a claim. The R2 legal
qualification policy says whether a specific approved credential is required
or optional for a specific profession/service match.

## Governed policy releases

Legal policy is a full-release, append-only catalog. Each version is
checksummed and pinned to the exact current canonical profession-taxonomy
release. Activation is serialized and requires canonical content, explicit
human-review approval and reference, at least one row, active profession rows,
active credential types and a strictly increasing version. Releases, entries
and activation history cannot be updated or deleted. No Slovak legal-policy
content is seeded: installing the real policy remains the expert/legal HUMAN
GATE already recorded by the product specification.

Installation is atomic: entries may be inserted only in the same transaction
that creates their release. The server installer canonicalizes and orders the
full row set, recomputes its SHA-256 digest, verifies exact stored content on
retry, and accepts only an exact activation replay. Activation has no public or
owner API; it remains an offline privileged HUMAN-GATE operation until a
dedicated capability-backed and audited admin command is explicitly added.

The current projection is deliberately empty before a reviewed release is
activated. It also becomes empty if the profession taxonomy advances without a
qualification release pinned to that taxonomy. Both cases fail closed rather
than silently applying stale legal rules.

## Exact gate

The server derives the relevant profession and credential type from the
selected service and calls the gate with that exact pair. A `REQUIRED` rule is
qualified only by a current `APPROVED`, nonexpired claim for the same active
craftsman profession and credential type. `PENDING`, `REJECTED`, `REVOKED`,
expired, absent and mismatched claims do not qualify. An `OPTIONAL` rule never
blocks eligibility; its approved/not-approved result is only a relevance/trust
fact for later ranking.

The SQL function joins the live R2 public-search views, so hidden, moderated,
unready or suspended profiles return no decision. Missing, inactive or corrupt
policy data likewise returns no row and the repository maps it uniformly to
`UNAVAILABLE` with `eligible: false`.

## Privacy and authority

The outward result is an explicit allowlist: eligibility, requirement,
current-approved boolean and a bounded reason code. It contains no claim ID,
evidence/media reference, reviewer identity, private reason, storage key, hash
or account ID. The function is `SECURITY INVOKER`; default function execution
does not grant access to its underlying security-invoker views/tables, and the
production runtime must continue to use a least-privilege database role.

`runCredentialQualificationIntegrationAssertions(sql)` is a standalone live
PostgreSQL helper. It installs only synthetic reviewed fixtures and is not wired
into the shared migration runner by this ticket owner.

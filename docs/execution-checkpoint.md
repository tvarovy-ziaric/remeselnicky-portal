# Implementation execution checkpoint

This file is the persistent implementation-status overlay for the hash-verified canonical `IMPLEMENTATION_BACKLOG.md`. It records execution state without rewriting the canonical source bundle.

- Updated: 2026-09-14
- Definition: D01–D30 LOCKED and hash verified
- Active release: R1 — Supply side
- Last completed ticket: R1-001 — Canonical Profession/Specialization taxonomy + seed governance
- Active tickets: R1-002 — CustomerProfile lazy creation; R1-003 — CraftsmanProfile core entity
- Next dependency-satisfied candidate: R1-004 — Craftsman profession/proficiency relationships (after R1-003)
- Human gate: canonical Slovak taxonomy content still requires expert/legal review before activation; this does not block R1-002/R1-003
- Integrated verification: CI run 34810124231 passed quality, dependency audit, secret scan and clean PostgreSQL/PostGIS migrations

## Ticket state overlay

| Ticket | State | Verification evidence                                                                                        |
| ------ | ----- | ------------------------------------------------------------------------------------------------------------ |
| R0-001 | DONE  | Frozen install, strict workspace scripts, tests and production builds passed                                 |
| R0-002 | DONE  | Shared TypeScript/lint/format policy and 5/5 negative import-boundary tests passed                           |
| R0-003 | DONE  | Public/server config projections and validation/secret-boundary tests passed                                 |
| R0-004 | DONE  | Frozen CI, HIGH/CRITICAL audit and immutable-pinned full-history Gitleaks passed                             |
| R0-005 | DONE  | Environment-isolated OCI/Kustomize skeleton, TLS path and protected staging workflow validated               |
| R0-006 | DONE  | PostGIS topology, least-privilege roles, query boundary and safe health checks passed                        |
| R0-007 | DONE  | Ordered checksum/advisory-lock migrations passed clean and repeat PostGIS CI                                 |
| R0-008 | DONE  | User state/schema constraints and persistence negatives passed clean PostGIS CI                              |
| R0-009 | DONE  | Invitation-only auth/session/reset, rate-limit and security negatives passed                                 |
| R0-010 | DONE  | Digest-only email verification, resend/race/expiry/CSRF/rate-limit tests passed                              |
| R0-011 | DONE  | E.164 phone verification, HMAC OTP, supersession/attempt/race tests passed                                   |
| R0-012 | DONE  | Provider-neutral MFA, regenerated privileged sessions, role guards and live PG race tests passed             |
| R0-013 | DONE  | Server-only fail-closed evaluator, public allowlist and 20 policy tests passed                               |
| R0-014 | DONE  | Server-only allowlist projections and public/private/context/admin negatives passed                          |
| R0-015 | DONE  | Transaction/idempotency/outbox command pattern and race/fail-closed tests passed                             |
| R0-016 | DONE  | Private/public storage topology, opaque keys, signed grants and revocation tests passed                      |
| R0-017 | DONE  | Controlled private upload and MediaAsset constraints/transitions passed clean PostGIS CI                     |
| R0-018 | DONE  | Bounded image decode/canonicalization, metadata stripping and atomic READY tests passed                      |
| R0-019 | DONE  | Strict PDF parse, malware evidence, timeout/retry and hostile-input tests passed                             |
| R0-020 | DONE  | Double current authorization, uniform IDOR denial and bounded signed delivery tests passed                   |
| R0-021 | DONE  | Retry/terminal queue, privacy-safe telemetry and deployable worker tests passed                              |
| R0-022 | DONE  | Transactional outbox leases/retries/dedupe/privacy and live PG race tests passed                             |
| R0-023 | DONE  | In-app/email notification state, provenance, privacy and live PG lease tests passed                          |
| R0-024 | DONE  | Immutable typed audit ledger, role-event mirror and live PG rollback/race tests passed                       |
| R0-025 | DONE  | Fail-closed noindex/no-store admin shell and per-module capability tests passed                              |
| R0-026 | DONE  | Privacy-safe API/web/worker telemetry and redaction/admission/rate-limit tests passed                        |
| R0-027 | DONE  | API/worker metrics, readiness, alert contracts and failure-isolation tests passed                            |
| R0-028 | DONE  | Guarded restore verifier, recovery negatives and recovery evidence tests passed                              |
| R0-029 | DONE  | Strict analytics catalog/envelope, privacy and environment-isolation tests passed                            |
| R0-030 | DONE  | Purpose-bound consent, retention/privacy ledgers and live PG history/race tests passed                       |
| R0-031 | DONE  | Deterministic non-production multi-role seeds and conflict/idempotency tests passed                          |
| R0-032 | DONE  | Isolated PG, multi-role auth, IDOR and concurrency harness passed locally and in CI                          |
| R0-033 | DONE  | Digest-pinned release, bounded smoke, protected production and rollback validation passed                    |
| R1-001 | DONE  | Append-only approved taxonomy releases, non-activatable placeholder and live PG governance/race tests passed |

All rows above are covered by CI run `34810124231` unless a more specific earlier run is referenced in history. The run applied migrations `0000`–`0013` twice and passed the complete live PostgreSQL/PostGIS integration suite.

## Durable decisions

- [ADR 0001](./adr/0001-typescript-monorepo-tooling.md): pnpm/Turborepo strict TypeScript monorepo.
- [ADR 0002](./adr/0002-server-side-auth-sessions.md): server-authoritative authentication and session boundary.
- [ADR 0005](./adr/0005-provider-neutral-admin-mfa.md): provider-neutral privileged MFA boundary.
- Architecture, security, operations, recovery and release contracts are maintained under `docs/`, `infra/` and `deploy/` alongside their executable validators.

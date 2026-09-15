# Implementation execution checkpoint

This file is the persistent implementation-status overlay for the hash-verified canonical `IMPLEMENTATION_BACKLOG.md`. It records execution state without rewriting the canonical source bundle.

- Updated: 2026-09-15
- Definition: D01–D30 LOCKED and hash verified
- Active release: R3 — Demand side
- Last completed ticket: R3-018 — Quote comparison normalization/UI
- Active ticket: R3-019 — Quote expiry/withdraw/stale handling
- Next dependency-satisfied candidate: R3-020 — Demand-side notification catalog
- Human gate: canonical Slovak profession/skill/location content still requires expert/legal/source review before activation; this does not block private supply-side implementation
- Integrated verification: commit `5710c9d`, CI run `34974700120`, passed quality, dependency audit, full-history secret scan, clean PostgreSQL/PostGIS migrations 0000–0050 and the complete live R0/R1/R2 plus R3-001–R3-018 integration suite; customer-only Quote comparison, exact current structured/external content, canonical selected PDF checks, strict privacy allowlist, neutral/fixed-final sorting, ACTIVE/competitor isolation and responsive private UI passed

## Ticket state overlay

| Ticket | State    | Verification evidence                                                                                         |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------- |
| R0-001 | DONE     | Frozen install, strict workspace scripts, tests and production builds passed                                  |
| R0-002 | DONE     | Shared TypeScript/lint/format policy and 5/5 negative import-boundary tests passed                            |
| R0-003 | DONE     | Public/server config projections and validation/secret-boundary tests passed                                  |
| R0-004 | DONE     | Frozen CI, HIGH/CRITICAL audit and immutable-pinned full-history Gitleaks passed                              |
| R0-005 | DONE     | Environment-isolated OCI/Kustomize skeleton, TLS path and protected staging workflow validated                |
| R0-006 | DONE     | PostGIS topology, least-privilege roles, query boundary and safe health checks passed                         |
| R0-007 | DONE     | Ordered checksum/advisory-lock migrations passed clean and repeat PostGIS CI                                  |
| R0-008 | DONE     | User state/schema constraints and persistence negatives passed clean PostGIS CI                               |
| R0-009 | DONE     | Invitation-only auth/session/reset, rate-limit and security negatives passed                                  |
| R0-010 | DONE     | Digest-only email verification, resend/race/expiry/CSRF/rate-limit tests passed                               |
| R0-011 | DONE     | E.164 phone verification, HMAC OTP, supersession/attempt/race tests passed                                    |
| R0-012 | DONE     | Provider-neutral MFA, regenerated privileged sessions, role guards and live PG race tests passed              |
| R0-013 | DONE     | Server-only fail-closed evaluator, public allowlist and 20 policy tests passed                                |
| R0-014 | DONE     | Server-only allowlist projections and public/private/context/admin negatives passed                           |
| R0-015 | DONE     | Transaction/idempotency/outbox command pattern and race/fail-closed tests passed                              |
| R0-016 | DONE     | Private/public storage topology, opaque keys, signed grants and revocation tests passed                       |
| R0-017 | DONE     | Controlled private upload and MediaAsset constraints/transitions passed clean PostGIS CI                      |
| R0-018 | DONE     | Bounded image decode/canonicalization, metadata stripping and atomic READY tests passed                       |
| R0-019 | DONE     | Strict PDF parse, malware evidence, timeout/retry and hostile-input tests passed                              |
| R0-020 | DONE     | Double current authorization, uniform IDOR denial and bounded signed delivery tests passed                    |
| R0-021 | DONE     | Retry/terminal queue, privacy-safe telemetry and deployable worker tests passed                               |
| R0-022 | DONE     | Transactional outbox leases/retries/dedupe/privacy and live PG race tests passed                              |
| R0-023 | DONE     | In-app/email notification state, provenance, privacy and live PG lease tests passed                           |
| R0-024 | DONE     | Immutable typed audit ledger, role-event mirror and live PG rollback/race tests passed                        |
| R0-025 | DONE     | Fail-closed noindex/no-store admin shell and per-module capability tests passed                               |
| R0-026 | DONE     | Privacy-safe API/web/worker telemetry and redaction/admission/rate-limit tests passed                         |
| R0-027 | DONE     | API/worker metrics, readiness, alert contracts and failure-isolation tests passed                             |
| R0-028 | DONE     | Guarded restore verifier, recovery negatives and recovery evidence tests passed                               |
| R0-029 | DONE     | Strict analytics catalog/envelope, privacy and environment-isolation tests passed                             |
| R0-030 | DONE     | Purpose-bound consent, retention/privacy ledgers and live PG history/race tests passed                        |
| R0-031 | DONE     | Deterministic non-production multi-role seeds and conflict/idempotency tests passed                           |
| R0-032 | DONE     | Isolated PG, multi-role auth, IDOR and concurrency harness passed locally and in CI                           |
| R0-033 | DONE     | Digest-pinned release, bounded smoke, protected production and rollback validation passed                     |
| R1-001 | DONE     | Append-only approved taxonomy releases, non-activatable placeholder and live PG governance/race tests passed  |
| R1-002 | DONE     | Lazy private CustomerProfile, ACTIVE-owner serialization and raw-SQL privacy/history guards passed            |
| R1-003 | DONE     | Private INDIVIDUAL/COMPANY draft, owner/revision/verification and suspension-race guards passed               |
| R1-004 | DONE     | Taxonomy-pinned professions, declared-level history, idempotency and live PG race/SQL guards passed           |
| R1-005 | DONE     | Governed M:N skills/specializations, retained custom wording and evidence-separation guards passed            |
| R1-006 | DONE     | PostGIS municipality/service-area history, extensible extras and privacy/race guards passed                   |
| R1-007 | DONE     | Optional EUR-cent pricing snapshots, profession links, archive/idempotency and public-text guards passed      |
| R1-008 | DONE     | Working-since history, owner CAS/idempotency and suspension-race guards passed                                |
| R1-009 | DONE     | Credential evidence, MFA admin review, immutable decisions and revocation/race guards passed                  |
| R1-010 | DONE     | Independent approval/visibility/moderation history and atomic audit guards passed                             |
| R1-011 | DONE     | Allowlisted public profile/page and exact public portfolio/media delivery intersection passed                 |
| R1-012 | DONE     | Lightweight UTC availability history, overlap-tolerant semantics and owner/race guards passed                 |
| R1-013 | DONE     | Immutable self-declared portfolio provenance, privacy-safe content and owner/race guards passed               |
| R1-014 | DONE     | Private project photo sets, phase/order history, max-15 and delivery/revocation guards passed                 |
| R1-015 | DEFERRED | Job-linked provenance hooks are completed with R4 Job integration                                             |
| R1-016 | DONE     | Immutable collaborator invitation/acceptance/visibility history and permission races passed                   |
| R1-017 | DONE     | Owner-managed featured-project history, deterministic ordering and hard maximum of three passed               |
| R1-018 | DONE     | Self-declared project/photo publication, public derivative and revoke/visibility intersections passed         |
| R1-019 | DONE     | Live public/private/admin matrix, exact command outcomes, two-way races and leakage negatives passed          |
| R2-001 | DONE     | Live approved-PUBLIC search views, strict public DTO and cold-start-safe discovery hooks passed               |
| R2-002 | DONE     | Governed deterministic taxonomy autocomplete, privacy guards and live SQL execution passed                    |
| R2-003 | DONE     | PostGIS distance facts, optional-location semantics and privacy-safe output passed                            |
| R2-004 | DONE     | Service-radius bands, explicit outside-radius opt-in and neutral missing-location behavior passed             |
| R2-005 | DONE     | Exact-profession relevance, evidence separation and no skill-count boost passed                               |
| R2-006 | DONE     | Governed REQUIRED/OPTIONAL qualification policy, hard gate and privacy/race tests passed                      |
| R2-007 | DONE     | Availability overlap facts, AVAILABLE-only soft signal/filter and private-time guards passed                  |
| R2-008 | DONE     | Sparse trust/evidence volume, quality and confidence facts with neutral cold-start semantics passed           |
| R2-009 | DONE     | Recommended categorical ranking without numeric weights or cold-start penalty passed                          |
| R2-010 | DONE     | Nearest and Best-rated alternate sorts with strict fact integrity passed                                      |
| R2-011 | DONE     | Privacy-safe result cards, live qualification gates and why-matched explanations passed                       |
| R2-012 | DONE     | Private persistent shortlist, idempotent commands and unavailable-target tombstones passed                    |
| R2-013 | DONE     | Privacy-minimal discovery and shortlist analytics catalog tests passed                                        |
| R2-014 | DONE     | Search abuse admission, response bounds and privacy/security/performance regressions passed                   |
| R3-001 | DONE     | Private JobRequest identity, immutable DRAFT history and fail-closed ACTIVE transition passed                 |
| R3-002 | DONE     | Bounded canonical section autosave, recovery, exact replay and live PostgreSQL race/history guards passed     |
| R3-003 | DONE     | Session-rotation-safe marker, atomic first section, retry dedupe and IndexedDB multi-tab recovery passed      |
| R3-004 | DONE     | Mobile autosave form, governed selection, strict submission validation and READY-only private media passed    |
| R3-005 | DONE     | Append-only active-content history, server-derived material versions and live PG concurrency guards passed    |
| R3-006 | DONE     | Configurable active limit/warnings, expiry, extension/reactivation, cancellation and clean duplication passed |
| R3-007 | DONE     | JobInvitation lifecycle, exact request-version provenance and max-five active invitations passed              |
| R3-008 | DONE     | Explicit candidate selection, server-revalidated invitations and request-context UI/API passed                |
| R3-009 | DONE     | Transactional invitation notifications, asynchronous delivery and configurable reminders passed               |
| R3-010 | DONE     | Authorized invitation inbox/detail/actions, pinned safe request context and neutral outcome UX passed         |
| R3-011 | DONE     | ENGAGED-only conversation identity, participant isolation and terminal read-only history passed               |
| R3-012 | DONE     | Immutable chat timeline, read receipts/unread state, archive/mute/report and live isolation tests passed      |
| R3-013 | DONE     | Private chat photo/PDF attachments, processing/delivery guards and future Job-documentation hooks passed      |
| R3-014 | DONE     | Server/DB-enforced pre-confirmation contact/address policy, generic denial and bypass regressions passed      |
| R3-015 | DONE     | Immutable Quote revisions, private draft/submitted isolation, CAS/idempotency and live DB guards passed       |
| R3-016 | DONE     | Native structured Quote authoring, immutable typed content and submit/save race guards passed                 |
| R3-017 | DONE     | External PDF Quote authoring, minimal structured envelope and immutable PDF revisions passed live PG CI       |
| R3-018 | DONE     | Neutral structured/PDF Quote normalization, strict private DTO, responsive UI and live PG checks passed       |
| R3-019 | ACTIVE   | Append-only Quote expiry/withdrawal and material-request staleness/reconfirmation handling                    |

All DONE rows above are covered by CI run `34974700120` unless a more specific earlier run is referenced in history. The run applied migrations `0000`–`0050` twice and passed the complete live PostgreSQL/PostGIS integration suite, including the R1 supply-side authorization/privacy matrix, full R2 discovery/shortlist assertions, and R3 request core, recovery, validated content, private media, lifecycle, invitations, conversations, immutable chat and attachments, pre-confirm privacy policy, Quote core revisions, both authoring modes, private comparison and concurrency boundaries.

## Durable decisions

- [ADR 0001](./adr/0001-typescript-monorepo-tooling.md): pnpm/Turborepo strict TypeScript monorepo.
- [ADR 0002](./adr/0002-server-side-auth-sessions.md): server-authoritative authentication and session boundary.
- [ADR 0005](./adr/0005-provider-neutral-admin-mfa.md): provider-neutral privileged MFA boundary.
- Architecture, security, operations, recovery and release contracts are maintained under `docs/`, `infra/` and `deploy/` alongside their executable validators.

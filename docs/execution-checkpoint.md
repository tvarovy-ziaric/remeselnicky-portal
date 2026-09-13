# Implementation execution checkpoint

This file is the persistent implementation-status overlay for the hash-verified canonical `IMPLEMENTATION_BACKLOG.md`. It records execution state without rewriting the canonical source bundle.

- Updated: 2026-09-14
- Definition: D01–D30 LOCKED and hash verified
- Active release: R0 — Foundation
- Last completed ticket: R0-013 — Deny-by-default authorization framework
- Active ticket: R0-008 — Core identity/User persistence
- Next dependency-satisfied candidate: R0-009 after R0-008
- Human gate: none

## Ticket state overlay

| Ticket | State  | Verification evidence                                                                                    |
| ------ | ------ | -------------------------------------------------------------------------------------------------------- |
| R0-001 | DONE   | `pnpm install --frozen-lockfile`, format check, typecheck, lint, 8 tests, and build passed on 2026-09-13 |
| R0-002 | DONE   | Shared TypeScript/lint/format/test policy plus 5/5 negative import-boundary tests passed                 |
| R0-003 | DONE   | Public/server config projections and 10/10 validation/secret-boundary tests passed                       |
| R0-004 | DONE   | Frozen install, quality, HIGH/CRITICAL audit and immutable-pinned Gitleaks workflow                      |
| R0-005 | DONE   | Environment-isolated OCI/Kustomize skeleton, TLS path and protected staging workflow validated           |
| R0-006 | DONE   | PostGIS Compose/migration, least-privilege roles, DB query boundary and safe health tests passed         |
| R0-007 | DONE   | Checksum/advisory-lock migration runner; clean PostGIS CI, repeat run and all security gates passed      |
| R0-008 | ACTIVE | Core User identity persistence in progress                                                               |
| R0-013 | DONE   | Server-only fail-closed evaluator, public allowlist and 20 positive/negative policy tests passed         |
| R0-016 | DONE   | Separate container contract, opaque server keys, authorized private grants and revocation tests passed   |
| R0-021 | DONE   | Retry/terminal queue port, safe telemetry, 10 queue tests and 2 independently deployable worker tests    |

## Durable decisions

- [ADR 0001](./adr/0001-typescript-monorepo-tooling.md): pnpm/Turborepo strict TypeScript monorepo.

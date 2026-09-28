# R4-031 security launch suite

This is the executable, account-free security gate for the synthetic Web Alpha.
It binds the locked D26 security-testing rules to the D30 real-user release
gates without turning local evidence into provider-staging or production
approval.

## Evidence classes

- `LOCAL_ISOLATED_SYNTHETIC` proves the listed tests against a clean disposable
  loopback PostGIS database and the exact clean Git revision.
- `PUBLIC_QUICK_TUNNEL_SYNTHETIC` proves the focused browser behavior through
  the temporary Basic-Auth-protected Quick Tunnel. It is not provider staging.
- `PROVIDER_STAGING` remains `NOT_EVALUATED` until the approved isolated
  provider stack exists.
- `REAL_USER_PRODUCTION` remains **NO-GO** until every D30 hard gate and the
  explicit human go/no-go decision pass.

No result from this suite supplies real admin MFA enrollment, a monitoring
receiver, incident ownership, production backup/provider evidence, legal or
privacy approval, or authorization for a first real-user cohort.

## Local isolated command

Run only from a clean worktree:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/run-r4-security-launch-suite.ps1 -EvidenceDirectory ./.alpha/r4-security-evidence
```

The script:

1. requires an already-present pinned `postgis/postgis:17-3.5-alpine` image and
   a working Docker daemon; it never pulls an image;
2. creates one randomly named container with a tmpfs database and a dynamic
   `127.0.0.1` port, leaving the Alpha stack and every persistent volume alone;
3. builds the database dependency graph;
4. runs authorization, admin-MFA, hostile-media/private-delivery,
   notification, worker, API, Web, isolated-harness and committed-race suites;
5. parses each Vitest JSON result and fails on any failed, skipped or todo test;
6. records a credential-free JSON result only when the worktree exactly matches
   the recorded commit; and
7. removes only the generated container and validated temporary directory.

The evidence file contains no database URL, password, token, cookie, OTP,
uploaded content, object key, signed URL, address, contact value or message.
It always records provider evidence as `NOT_EVALUATED` and production as
`NO-GO`.

## Public synthetic command

After the exact revision is deployed to the current synthetic Alpha:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./apps/e2e/scripts/run-r4-security-public.ps1
```

The runner moves the old ignored fixture manifest to an ignored recoverable
backup, provisions a fresh synthetic request/Quote fixture, and runs Chromium
checks for competitor isolation, private media plus EICAR rejection, Quote
acceptance/race-visible outcomes, and the canonical full loop including sealed
reviews. It does not delete the old database records or fixture manifest. The
canonical runner derives the loopback verification-sink port from
`.env.alpha`; it does not assume port `8467` and never exposes the sink publicly.

## D30 security-gate manifest

| D30 gate                                                             | Mandatory automated evidence                                                                                                                      | External evidence boundary                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Negative object/field/action authorization                           | `packages/testing/test/r3-demand-side-http-security.test.ts`, API route tests, `docs/testing/r4-final-permission-matrix.md`, clean DB integration | Provider staging rerun still required.                                  |
| Competitor Quote and conversation isolation                          | `apps/e2e/tests/r3-competitor-isolation.spec.ts`, Quote/conversation DB and API tests                                                             | Quick Tunnel is synthetic only.                                         |
| Private JobRequest/file ID substitution                              | exact JobRequest media delivery repository/API/media tests plus `packages/media/test/delivery.test.ts`                                            | No UUID or role alone grants delivery.                                  |
| Pre-confirm contact/address absence                                  | competitor E2E, request/invitation projections and contact policy tests                                                                           | Manual browser UAT remains separate.                                    |
| Post-confirm role-specific exposure                                  | canonical E2E plus Job contact/participant capability tests                                                                                       | Participant device UAT remains separate.                                |
| Sealed-review non-leakage                                            | main-review DB/API tests and `apps/worker/src/sealed-review-notification.test.ts`                                                                 | Provider email delivery reliability remains external.                   |
| Admin/SUPER_ADMIN and MFA                                            | `packages/admin-auth`, privileged API negatives and immutable audit tests                                                                         | Real provider MFA and first enrolled admin remain `BLOCKED_HUMAN_GATE`. |
| CSRF, CORS and sessions                                              | auth API tests plus R3 HTTP security matrix                                                                                                       | Provider edge configuration requires staging evidence.                  |
| XSS and free text                                                    | `apps/web/src/security-free-text.test.tsx` on request, chat, operational, Change-order and review surfaces                                        | Manual exploratory browser UAT remains separate.                        |
| Spoofed, malicious, active, oversized and decompression-bomb uploads | `packages/media` and worker media tests; public EICAR scenario                                                                                    | Provider object-storage policy remains external.                        |
| Quote-acceptance race/idempotency                                    | `quote-acceptance-committed-race-integration-helper.ts` inside the clean live PostGIS suite and focused public acceptance E2E                     | Provider staging rerun still required.                                  |
| No known exploitable critical issue                                  | this suite, full `pnpm check`, dependency audit, repository secret scan, defect ledger                                                            | Human/security review must still assess all findings before real users. |

## Pass rule

Local R4-031 evidence passes only when every discovered mandatory test passes,
the suite reports zero skipped/todo tests, the disposable database run passes,
the worktree is clean, the current full quality check passes, and no open known
BLOCKER or CRITICAL security defect exists. A HIGH defect needs an explicit
named human risk acceptance; automation cannot grant it.

Even a local and public synthetic `PASS` leaves the real-user production verdict
at **NO-GO** while provider staging, real admin MFA, manual UAT, privacy/legal,
observability/incident ownership, recovery/provider and rollout gates remain
open.

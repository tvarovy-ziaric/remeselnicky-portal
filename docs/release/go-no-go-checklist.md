# R4-032 D30 go/no-go checklist

Status: **SYNTHETIC TEST OPERATION ONLY — REAL-USER PRODUCTION NO-GO**

This checklist assembles release evidence without changing any locked D30
gate. It has two independent decisions:

1. whether a specific synthetic candidate may continue internal testing; and
2. whether real-user production may launch.

A synthetic `PASS` can support only decision 1. It cannot satisfy a provider,
legal/privacy, real admin-MFA, production-operations or real-user gate.

## Status vocabulary

- `PASS`: exact evidence for this release candidate exists and was reviewed.
- `FAIL`: exact evidence exists and does not meet the gate.
- `NOT_EVALUATED`: evidence is missing, stale, incomplete, or for a different
  evidence class/revision/environment.
- `BLOCKED_HUMAN_GATE`: completion requires a decision or resource reserved to
  a human under the repository operating instructions.
- `NOT_APPLICABLE`: permitted only with a written D30-consistent reason; it is
  never valid for a missing core journey or launch gate.

Unchecked boxes are `NOT_EVALUATED`, not implicit passes.

## Candidate identity

- Checklist ID:
- Candidate Git revision (full SHA):
- Application release revision:
- Environment and data class:
- Evidence bundle reference:
- Prepared by/date:
- Reviewed by/date:

## Hard decision rules

Synthetic internal-test continuation is `NO-GO` when any of these is true:

- an open `BLOCKER` or known `CRITICAL` affects the synthetic path;
- synthetic data/environment isolation is not proven;
- a secret, token, private field, exact contact/address, sealed review,
  competitor Quote/chat, or private file may be exposed;
- the core tested transaction can lose data, create duplicate primary Jobs, or
  silently mutate an accepted commercial snapshot;
- the candidate revision differs from the reviewed evidence.

Real-user production is `NO-GO` unless every D30 hard gate has exact production
or approved provider-staging evidence, there are zero open `BLOCKER` and zero
known `CRITICAL` defects, every `HIGH` has a named human risk decision, and the
authorized approver explicitly accepts the initial invite cohort. A
`BLOCKED_HUMAN_GATE` or blocking `NOT_EVALUATED` row therefore keeps production
at `NO-GO`.

## A. Candidate and automated evidence

Default status for a new candidate is `NOT_EVALUATED`, even when an older run
passed.

| Gate                                                               | Current status  | Required evidence                                                              |
| ------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------ |
| Lockfile install, format, typecheck, lint, tests and builds        | `NOT_EVALUATED` | Successful CI/local evidence for the exact revision.                           |
| Clean migration apply/replay and critical constraints              | `NOT_EVALUATED` | Exact migration version and clean PostgreSQL/PostGIS evidence.                 |
| Canonical full marketplace loop                                    | `NOT_EVALUATED` | R4-030 automated run for the exact candidate and environment.                  |
| Negative authorization/race/upload/sealed-review suite             | `NOT_EVALUATED` | R4-031 result with zero unexplained skipped critical probes.                   |
| Synthetic registration TEST classification and analytics exclusion | `NOT_EVALUATED` | Server-owned classification evidence; no matching non-TEST account.            |
| Release smoke and revision correlation                             | `NOT_EVALUATED` | Public web, API liveness/readiness, auth entry point and exact release marker. |

Automated results remain `AUTOMATED_SYNTHETIC`; they do not satisfy section B.

## B. Scripted manual UAT

Use one completed [`uat-evidence.template.md`](./uat-evidence.template.md) copy
per bounded run.

| Gate                                                        | Current status       | Blocking condition / evidence needed                                                                                                                                                                                                  |
| ----------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anonymous/public/responsive entry                           | `NOT_EVALUATED`      | Named tester/browser/device evidence.                                                                                                                                                                                                 |
| Customer draft/search/shortlist/invitation journey          | `NOT_EVALUATED`      | Named manual evidence including refresh/back/multiple tabs.                                                                                                                                                                           |
| Craftsman invitation/conversation/attachment/Quote journey  | `NOT_EVALUATED`      | Named manual evidence including slow/offline/retry behavior.                                                                                                                                                                          |
| Quote comparison/acceptance/confirmed Job                   | `NOT_EVALUATED`      | Named manual evidence for one Job, immutable recap and contact boundary.                                                                                                                                                              |
| Job operation/change/completion/review journey              | `NOT_EVALUATED`      | Named manual evidence including history preservation and sealed unlock.                                                                                                                                                               |
| Notifications/dispute/privacy-request UX                    | `NOT_EVALUATED`      | Named manual evidence without overpromising unsupported legal completion.                                                                                                                                                             |
| Browser registration + email/phone verification             | `NOT_EVALUATED`      | UI and automated synthetic flow pass; named manual browser/device onboarding evidence is still missing.                                                                                                                               |
| Craftsman onboarding/profile/credential/portfolio authoring | `NOT_EVALUATED`      | Publication-minimum owner, private self-declared portfolio and private pending credential/evidence authoring are implemented locally; genuine admin approval, deployed staging verification and named manual evidence remain missing. |
| Admin operational perspective                               | `NOT_EVALUATED`      | A provider-neutral browser TOTP entry exists locally and fails closed without a real adapter/enrolled factor. Provider-backed admin operation and named manual evidence remain missing.                                               |
| Real provider-backed admin MFA                              | `BLOCKED_HUMAN_GATE` | Approved provider, named enrollment, replay/rate/expiry and emergency recovery evidence.                                                                                                                                              |

The craftsman authoring journey cannot be marked `PASS` from seed data or a
written workaround. The implemented customer browser onboarding likewise
cannot be marked as a manual `PASS` from automated Playwright evidence alone.

## C. Exploratory, compatibility and accessibility

| Gate                                                           | Current status  | Required evidence                                                             |
| -------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------- |
| Refresh, Back/Forward, multiple tabs and double click          | `NOT_EVALUATED` | Manual observations on core customer/craftsman paths.                         |
| Slow/offline network, retry and interrupted upload             | `NOT_EVALUATED` | Manual recovery and no-partial-effect evidence.                               |
| Logout/revocation and genuine session expiry                   | `NOT_EVALUATED` | Genuine expiry remains unevaluated if only logout/cookie deletion was tested. |
| Current Chrome, Firefox, Safari and Edge/Chromium              | `NOT_EVALUATED` | Separate current-browser results.                                             |
| Actual iPhone Safari                                           | `NOT_EVALUATED` | Actual-device result; WebKit/emulation is separate automated evidence.        |
| Actual Android Chrome                                          | `NOT_EVALUATED` | Actual-device result; Chromium/emulation is separate automated evidence.      |
| Labels, validation/errors, keyboard/focus and obvious contrast | `NOT_EVALUATED` | Manual critical-form review.                                                  |
| Alpha-scale practical performance baseline                     | `NOT_EVALUATED` | Search, dashboard, chat, uploads and core forms on ordinary connections.      |

## D. Failure injection and operational behavior

| Gate                                      | Current status  | Required evidence                                                                                                                                |
| ----------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Synthetic verification-sink outage        | `NOT_EVALUATED` | Generic failure, no secret leak or invented verification; named manual failure-injection evidence is still required.                             |
| Worker/queue retry and terminal behavior  | `NOT_EVALUATED` | Durable recovery, no duplicate business effect and runbook timeline.                                                                             |
| Scanner/media/object-storage failure      | `NOT_EVALUATED` | Quarantine/fail-closed delivery and recovery evidence.                                                                                           |
| API/database unavailability               | `NOT_EVALUATED` | Bounded UX, health signal and no partial transaction.                                                                                            |
| Critical invariant alert/runbook exercise | `NOT_EVALUATED` | Synthetic firing/detection/recovery timeline without identifiers.                                                                                |
| Local synthetic restore rehearsal         | `PASS`          | Existing bounded evidence: `../recovery/rehearsals/2026-09-28-local-synthetic-restore.md`. This is not provider or production recovery evidence. |

## E. Security, privacy and commercial integrity

| Gate                                                                     | Current status       | Required evidence                                                       |
| ------------------------------------------------------------------------ | -------------------- | ----------------------------------------------------------------------- |
| Competitor Quote/conversation and private-file isolation                 | `NOT_EVALUATED`      | Exact R4-031/candidate result and manual spot checks.                   |
| Pre-confirm contact/address non-disclosure and post-confirm field policy | `NOT_EVALUATED`      | Exact candidate evidence for customer, winner, competitor and outsider. |
| Sealed-review non-leakage across API/UI/notifications                    | `NOT_EVALUATED`      | Exact candidate evidence before and after unlock.                       |
| One primary Job and acceptance race/idempotency                          | `NOT_EVALUATED`      | Concurrent test plus manual retry/double-click observation.             |
| Accepted snapshots/change revisions/history immutable                    | `NOT_EVALUATED`      | Database and browser evidence for the exact candidate.                  |
| CSRF/CORS/session/XSS/free-text/upload boundaries                        | `NOT_EVALUATED`      | R4-031 result with all critical cases evaluated.                        |
| Privacy-request/account closure/deindex/photo-consent technical paths    | `NOT_EVALUATED`      | Synthetic technical evidence only; it cannot close legal review.        |
| Approved Privacy Notice, Terms, purpose/basis and retention matrix       | `BLOCKED_HUMAN_GATE` | Named Slovak/EU review, controller/contact and approved policy records. |
| Processor/subprocessor, transfer and independent-ledger decisions        | `BLOCKED_HUMAN_GATE` | Approved vendors/contracts/regions/credentials and recovery ownership.  |

## F. Provider and production operations

| Gate                                                       | Current status       | Required evidence                                                                                                                                         |
| ---------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider-managed isolated staging                          | `BLOCKED_HUMAN_GATE` | Approved account, billing owner, DNS names, credentials and provider apply.                                                                               |
| Uninterrupted provider-staging canonical E2E               | `NOT_EVALUATED`      | Exact provider-managed staging run; Quick Tunnel evidence is not equivalent.                                                                              |
| Named Access-protected staging and external port probe     | `BLOCKED_HUMAN_GATE` | Approved account/zone/Access identities and outside-device result.                                                                                        |
| Real email and SMS provider delivery                       | `BLOCKED_HUMAN_GATE` | Approved processors/accounts/credentials and delivery/failure evidence. The synthetic sink is not a production fallback.                                  |
| Production DNS/TLS and object-storage permissions          | `BLOCKED_HUMAN_GATE` | Approved production accounts/configuration and verification.                                                                                              |
| Automated production database backups and media recovery   | `BLOCKED_HUMAN_GATE` | Provider mapping, monitoring, recovery credentials and successful rehearsal.                                                                              |
| Production logging/error tracking/monitoring/alert channel | `BLOCKED_HUMAN_GATE` | Approved collector/receiver, named incident owner and firing/resolved evidence.                                                                           |
| Real admin MFA enrollment/bootstrap/recovery               | `BLOCKED_HUMAN_GATE` | Approved TOTP/WebAuthn provider, named administrators and audited bootstrap.                                                                              |
| Invite-only intake pause/throttle                          | `NOT_EVALUATED`      | Local migration/repository/admin-route evidence exists (ADR 0028); protected production wiring, real MFA operation and smoke evidence are still required. |
| Production smoke and rollback/forward-fix exercise         | `NOT_EVALUATED`      | Protected deployment evidence, prior digest or first-release containment plan.                                                                            |

## G. Defects

- Open `BLOCKER`:
- Open `CRITICAL`:
- Open `HIGH`:
- Open `MEDIUM`:
- Open `LOW`:

| Defect | Severity | State | Owner | Workaround | Human risk decision if `HIGH` |
| ------ | -------- | ----- | ----- | ---------- | ----------------------------- |
|        |          |       |       |            |                               |

Launch requires zero open `BLOCKER` and zero known `CRITICAL`. A `HIGH`
requires explicit named human acceptance; Codex, automation, a workaround, or
silence cannot accept it.

## H. Decisions

### Synthetic internal-test continuation

Current decision: **NOT_EVALUATED**.

It may become `GO` only for continued synthetic internal testing after all
in-scope synthetic hard rules pass, manual evidence is reviewed, and there are
zero open `BLOCKER`/`CRITICAL` defects. Such a `GO` does not authorize real
personal data, provider accounts or production.

Decision, reviewer and timestamp:

### Real-user production launch

Current decision: **NO-GO**.

Reasons:

- provider-managed staging and provider delivery are not approved/evaluated;
- production infrastructure, monitoring, backups and recovery are not ready;
- real provider-backed admin MFA is not selected or enrolled;
- legal/privacy/processor/retention decisions remain human-gated;
- browser craftsman onboarding/authoring is implemented locally but lacks
  deployed provider-staging and named manual evidence; customer onboarding has
  only automated synthetic evidence, and manual UAT is not complete;
- the initial invite cohort and explicit D30 production approval have not been
  authorized.

Only the authorized human go/no-go reviewer may change this production
decision after every blocking row has exact reviewed evidence. The production
workflow still requires its protected-environment approval and exact
`D30 PRODUCTION GO` confirmation; editing this Markdown is never approval.

## Post-launch success evidence

At least one real invited customer and one real invited craftsman completing
the marketplace loop without developer/database rescue is
`REAL_USER_PRODUCTION` evidence collected only after an authorized launch. Its
current state is **NOT_EVALUATED**. Synthetic users, seed data and internal
testers cannot satisfy it.

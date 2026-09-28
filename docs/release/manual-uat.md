# R4-032 synthetic manual UAT

Status: **READY TO EXECUTE FOR SYNTHETIC TEST OPERATION ONLY**. This document
does not authorize provider provisioning, production data, a real-user cohort,
or a production release.

Locked reference: D30. The acceptance bar in D30 is not weakened by a local or
synthetic result.

## Evidence boundary

Keep these evidence classes separate:

| Evidence class         | What it proves                                                                                              | What it does not prove                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `MANUAL_SYNTHETIC_UAT` | A named tester observed the recorded browser/device behavior against the exact synthetic release candidate. | Automated correctness, provider delivery, production readiness, or real-user usability. |
| `AUTOMATED_SYNTHETIC`  | A named test suite passed against the recorded synthetic release candidate.                                 | That a human completed the flow or understood the user experience.                      |
| `PROVIDER_STAGING`     | A provider-managed isolated staging run passed with its approved accounts and configuration.                | Production approval or real-user success.                                               |
| `REAL_USER_PRODUCTION` | Approved invited users exercised the production path after go/no-go.                                        | Any pre-launch result; synthetic actors can never supply this evidence.                 |

Never copy an automated Playwright/API result into a manual-UAT result. An
automated run may prepare synthetic state, but every manual observation must be
recorded independently in a copy of
[`uat-evidence.template.md`](./uat-evidence.template.md).

## Safety and data rules

- Use only the explicit staging synthetic fixture and `.invalid` identities.
- Do not enter a real name, email, telephone number, address, message, document,
  photo, or other personal data.
- Do not paste or capture the Basic Auth password, account password, session
  state, cookie, bearer key, token, OTP, verification-claim body, signed media
  URL, storage key, or database URL.
- Keep screenshots, browser recordings, downloaded files, and storage state
  outside Git. Screenshots and recordings must remain disabled during token or
  OTP claim handling.
- Record only bounded synthetic labels and opaque case/run identifiers. Do not
  record exact contact or address values even when they are synthetic.
- Stop immediately if the environment marker is not `staging`, if
  `ALPHA_SYNTHETIC_FIXTURE=1` is absent, or if any screen contains real data.
- Never use `docker compose down -v`, remove a named volume, delete a database,
  or run a cleanup wildcard as part of UAT.

## Preconditions

Record every item as `PASS`, `FAIL`, or `NOT_EVALUATED` before testing:

1. The release candidate is identified by an immutable Git revision and the
   application reports the same release revision.
2. `pwsh ./infra/alpha/Alpha.ps1 -Action config` succeeds.
3. `pwsh ./infra/alpha/Alpha.ps1 -Action status` reports the expected local
   Alpha services healthy.
4. The app is reached through the currently configured synthetic Alpha origin,
   with its generated Basic Auth gate. Do not commit the live Quick Tunnel URL.
5. The synthetic verification sink is healthy, is not routed by Nginx or the
   tunnel, and its claim port is bound to host loopback only.
6. The deterministic seed and any automated fixture preparation completed with
   synthetic data only. Preparation is `AUTOMATED_SYNTHETIC`, not manual UAT.
7. The tester has a fresh copy of the evidence template and a defect log.
8. No open known defect can expose private data or corrupt the core flow.

The current R4 canonical preparation command is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./apps/e2e/scripts/run-r4-canonical.ps1
```

This command is automated evidence. It derives the loopback sink port from
`ALPHA_SYNTHETIC_VERIFICATION_PORT`; any missing or invalid value fails closed
rather than exposing or bypassing the sink.

## Synthetic actor set

Use only locally provisioned fixture identities and read passwords directly
from ignored secret files. Never write a password into this document or an
evidence record.

| Perspective     | Synthetic actor                                         | Intended use                                                                                                   |
| --------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Anonymous       | no portal session                                       | Public search/profile, authentication boundary, private-route denial.                                          |
| Customer        | seeded customer or fresh signed synthetic customer      | Draft, search, shortlist, invitation, comparison, acceptance, Job, completion, review, privacy, notifications. |
| Craftsman A     | seeded public provider                                  | Winning invitation, conversation, Quote, Job operation and review.                                             |
| Craftsman B     | seeded public competitor                                | Competitor-isolation observations and losing invitation outcome.                                               |
| Unrelated actor | second seeded customer or unrelated provider            | Uniform private-object denial.                                                                                 |
| Admin           | no browser-usable local MFA enrollment currently exists | Admin browser UAT remains `NOT_EVALUATED`; real MFA is `BLOCKED_HUMAN_GATE`.                                   |

## Known blocking or unevaluated browser journeys

These are findings, not passed cases:

- **Registration and verification UI — implemented and automated, manual result
  still `NOT_EVALUATED`.** The web application now provides `/registracia`,
  `/overenie-emailu` and `/overenie`; the public synthetic Chromium scenario
  passed registration, fragment-only single-use email verification, invalid and
  valid phone OTP handling and the verified `/dopyt` continuation. This is
  `AUTOMATED_SYNTHETIC`, not a named tester/browser/device manual pass.
- **Craftsman onboarding and profile authoring — implemented locally, manual
  result `NOT_EVALUATED`, blocking.** `/ucet/profil-remeselnika` now covers
  profile identity/About, one or more governed professions with declared level,
  base municipality, normal radius, the exact locked first-publication
  readiness list, review submission and deliberate visibility after approval.
  The privacy-minimal admin review UI/API is present but remains inaccessible
  without genuine recent-MFA `admin.profiles.review` authority. Credential and
  portfolio authoring, a full browser approval pass and named manual evidence
  remain unevaluated; seeded profiles are still not acceptable UAT evidence.
- **Admin entry and MFA — `BLOCKED_HUMAN_GATE` for production evidence.** The
  existing short-lived synthetic database session is an internal seed aid, not
  a browser login or proof of provider-backed MFA. Do not create an
  authorization-only bypass.
- **Privacy Notice and Terms — `BLOCKED_HUMAN_GATE` for real users.** The
  privacy center is not approved legal notice or terms evidence.

Treat a blocking missing journey as `NOT_EVALUATED`, never `PASS` or
`NOT_APPLICABLE`.

## Manual browser scripts

Run each case in a new evidence row. Preserve the same synthetic data set only
where a later case intentionally depends on an earlier case.

### UAT-01 — anonymous and responsive entry

1. Open the public home, craftsman search, one public profile, `/dopyt`, and
   `/prihlasenie` without a portal session.
2. Confirm private navigation does not reveal account or fixture details.
3. Repeat the public entry and draft form at desktop width and a narrow mobile
   width. Check zoom, readable errors, labels, keyboard order, visible focus,
   and that no action depends only on color.
4. Attempt a known private URL while anonymous and confirm a uniform sign-in or
   not-found outcome without private content.

Expected: public projections contain only intended fields; the draft entry is
usable; private content, exact contacts and addresses remain absent.

### UAT-02 — draft autosave and recovery

1. Sign in as a synthetic customer and create a lightweight request in
   `/dopyt` using only synthetic text and the synthetic municipality.
2. Move between form steps, refresh, use Back/Forward, close and reopen the tab,
   and open a second tab.
3. Confirm the latest committed sections recover without duplication or loss.
4. Submit once, then double-click or retry the submit control.

Expected: recovery is understandable, validation is usable, and retries create
one authoritative active request without partial state.

### UAT-03 — search, shortlist and invitations

1. Search for the synthetic profession and inspect both seeded public profiles.
2. Add and remove shortlist entries, including refresh and a second tab.
3. Invite Craftsman A and Craftsman B to the same active request.
4. As each craftsman, inspect only their invitation and record the appropriate
   engagement/decline action.
5. Try to navigate from Craftsman B to Craftsman A's private conversation or
   Quote URL.

Expected: shortlist state is stable, each invitation is isolated, and a
competitor learns neither the other provider's identity, conversation nor
commercial content.

### UAT-04 — conversation, attachment and Quote

1. As the engaged craftsman, send synthetic text and attach a minimal synthetic
   PDF through the browser.
2. Confirm progress and a clear success or failure state. Refresh during
   processing and verify the conversation remains usable.
3. Attempt pre-confirmation contact sharing and confirm it is rejected without
   echoing the forbidden value.
4. Author and submit one Quote. Use the other provider to submit the alternate
   Quote mode when the prepared scenario supports it.
5. As customer, compare Quotes and inspect the final acceptance recap.

Expected: attachments remain private, retry does not duplicate authoritative
effects, competing commercial data is isolated, and missing/uncertain Quote
fields are not invented.

### UAT-05 — acceptance and confirmed Job

1. As customer, accept the intended final Quote and immediately retry or
   double-click once.
2. Confirm exactly one Job appears and the competitor becomes `NOT_SELECTED`.
3. Confirm only the customer and winning provider can see the Job, authorized
   contact projection and exact location after confirmation.
4. Confirm the accepted request/Quote/PDF recap remains unchanged after later
   operational actions.

Expected: one primary Job, immutable acceptance snapshot, no premature or
competitor contact/address disclosure, and an understandable confirmation.

### UAT-06 — Job operation, changes and completion

1. Start the Job as the authorized provider and add synthetic documentation.
2. Exercise progress/issue, optional participant/workgroup, milestone and
   Change-order UI when the prepared fixture exposes each branch.
3. Approve one material Change order from the other party and confirm the base
   agreement remains separately visible and immutable.
4. Request completion, reject one attempt with a concrete synthetic objection,
   retry, and accept the final attempt.
5. Confirm history remains visible throughout.

Expected: role/state-specific controls are clear, rejected attempts preserve
history, approved changes apply exactly once, and completion does not become a
payment ledger.

### UAT-07 — reviews, notifications, disputes and privacy

1. Submit both bilateral main reviews in separate sessions/tabs and confirm the
   counterparty content stays sealed before unlock.
2. Confirm unlock/publication behavior and that internal/moderation fields do
   not enter the public profile.
3. Exercise the notification center, read/archive actions and preferences;
   required in-app events must remain available.
4. Open and progress a synthetic dispute as an exact Job party without changing
   Job, commercial or reputation history.
5. In `/ucet/sukromie`, create synthetic access/portability/closure requests and
   confirm the UI explains assisted or pending processing honestly.

Expected: sealed content does not leak, notifications remain privacy-minimal,
disputes are case management rather than verdict/payment mutation, and privacy
requests do not promise unsupported automatic deletion or legal completion.

### UAT-08 — restricted, suspended and expired access

1. Use only a prepared synthetic restriction/suspension fixture; do not edit
   production-like data manually.
2. Confirm restricted writes fail while allowed historical reads and appeal or
   privacy paths remain available according to the D26 matrix.
3. Confirm logout invalidates the active browser session and stale tabs cannot
   mutate.
4. If no supported fixture can produce a genuinely expired server session,
   record the expired-session row as `NOT_EVALUATED`; cookie deletion or logout
   is not equivalent evidence.

## Exploratory and compatibility matrix

For the core customer and craftsman paths, record separate results for:

- refresh, Back/Forward and multiple tabs;
- slow network and temporary offline recovery;
- request retry and double click;
- interrupted upload followed by a safe retry;
- session logout/revocation, and genuine expiry only when supported;
- desktop keyboard-only use, visible focus and error announcements;
- current Chrome, Firefox, Safari/WebKit and Edge/Chromium;
- actual iPhone Safari and Android Chrome when devices are available.

Playwright WebKit or mobile emulation is useful `AUTOMATED_SYNTHETIC` evidence,
but it is not a manual pass for actual iPhone Safari or Android Chrome. Record
unavailable browsers/devices as `NOT_EVALUATED`.

## Local synthetic failure injection

Only run these cases after recording a healthy state and only against the
disposable/synthetic Alpha. Restore the exact stopped service after each case.
Do not combine outages.

| Failure                       | Manual observation                                                                                                                                                          | Required integrity check                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Verification sink unavailable | Registration delivery must fail generically without a token/OTP leak. The browser-manual outage result remains `NOT_EVALUATED` until a named tester runs this failure case. | No verified flag or partial registration side effect is invented; recovery uses normal resend/verify semantics. |
| Worker stopped and restarted  | Pending upload/notification processing reports a bounded pending state and later recovers.                                                                                  | No duplicate business effect and no queue deletion.                                                             |
| Scanner unavailable           | PDF remains quarantined/unavailable rather than being treated as clean.                                                                                                     | No signed delivery for an unverified object.                                                                    |
| Object storage unavailable    | Upload/download fails safely and existing business state remains readable where appropriate.                                                                                | No public/private fallback or storage identifier leak.                                                          |
| API or PostgreSQL unavailable | The browser shows a bounded unavailable state and later recovers after health is restored.                                                                                  | No partial acceptance, Change order, completion or review effect.                                               |

Use the existing runbooks for diagnosis. Never weaken readiness,
authorization, malware scanning, or transaction checks to make a failure case
pass.

## Defects and stop rules

- `BLOCKER`: the synthetic candidate cannot be evaluated safely.
- `CRITICAL`: security/privacy/data-loss/integrity or core-loop failure.
- `HIGH`: major broken flow without an acceptable workaround.
- `MEDIUM`/`LOW`: record with owner and due date.

Stop the affected UAT immediately for any private-data disclosure, competitor
leak, pre-confirmation contact/address leak, sealed-review leak, duplicate Job,
mutable accepted snapshot, lost history, unsafe upload delivery, or token/secret
exposure. Synthetic continuation requires zero open `BLOCKER` and zero known
`CRITICAL`. A `HIGH` never becomes accepted merely because a workaround exists;
real-user risk acceptance requires a named human decision.

## Completion

Manual UAT is complete only when every in-scope row has a result and evidence,
every unavailable row is explicitly `NOT_EVALUATED` or
`BLOCKED_HUMAN_GATE`, and defects are classified. Then apply
[`go-no-go-checklist.md`](./go-no-go-checklist.md). A completed synthetic UAT
record can support continued internal testing only; it cannot make the
real-user production decision `GO`.

# R4-032 UAT evidence record — template

Copy this template for one bounded run. Do not replace prior evidence in place.
This record contains no secrets, personal data, live signed URLs, contact or
address values, chat/document contents, screenshots of verification claims, or
browser storage state.

## Run identity

- Evidence ID:
- Started (UTC):
- Completed (UTC):
- Tester:
- Reviewer:
- Git revision (full SHA):
- Reported application release revision:
- Environment marker:
- Data class: `synthetic`
- App origin class: `local-loopback` / `quick-tunnel` / `named-provider-staging`
- Evidence class: `MANUAL_SYNTHETIC_UAT`
- Browser and exact version:
- OS and exact version:
- Device / viewport:

If the data class is not `synthetic`, stop. This template does not authorize
anonymized or production data.

## Status vocabulary

- `PASS`: the named tester directly observed the expected manual result.
- `FAIL`: the named tester observed a mismatch or unsafe result.
- `NOT_EVALUATED`: the case was not executed or lacks sufficient manual
  evidence. Missing UI/device/setup remains here; it is never silently passed.
- `BLOCKED_HUMAN_GATE`: completion requires an external provider/account,
  legal/privacy decision, real admin-MFA enrollment, production credential, or
  real-user launch authorization.

Automation, documentation review, and inferred behavior cannot produce a
manual `PASS`.

## Preflight

| Check                                            | Status          | Privacy-safe evidence/reference | Notes                                   |
| ------------------------------------------------ | --------------- | ------------------------------- | --------------------------------------- |
| Git revision equals application release revision | `NOT_EVALUATED` |                                 |                                         |
| Explicit staging + synthetic fixture markers     | `NOT_EVALUATED` |                                 |                                         |
| Local Alpha health/readiness                     | `NOT_EVALUATED` |                                 |                                         |
| Basic Auth and portal-auth boundaries            | `NOT_EVALUATED` |                                 |                                         |
| Verification sink absent from public routing     | `NOT_EVALUATED` |                                 |                                         |
| Synthetic fixture preparation completed          | `NOT_EVALUATED` |                                 | Record its evidence class as automated. |
| Defect log opened                                | `NOT_EVALUATED` |                                 |                                         |

## Manual UAT results

Add rows as needed. One row is one tester-observed case on one browser/device.

| Case                                            | Perspective                   | Browser/device | Status               | Expected result                                       | Bounded actual result | Defect ID | Evidence reference |
| ----------------------------------------------- | ----------------------------- | -------------- | -------------------- | ----------------------------------------------------- | --------------------- | --------- | ------------------ |
| UAT-01 anonymous/responsive entry               | Anonymous                     |                | `NOT_EVALUATED`      |                                                       |                       |           |                    |
| UAT-02 draft autosave/recovery                  | Customer                      |                | `NOT_EVALUATED`      |                                                       |                       |           |                    |
| UAT-03 search/shortlist/invitations             | Customer/craftsman            |                | `NOT_EVALUATED`      |                                                       |                       |           |                    |
| UAT-04 conversation/attachment/Quote            | Craftsman/customer            |                | `NOT_EVALUATED`      |                                                       |                       |           |                    |
| UAT-05 acceptance/confirmed Job                 | Customer/craftsman/competitor |                | `NOT_EVALUATED`      |                                                       |                       |           |                    |
| UAT-06 Job/change/completion                    | Customer/craftsman            |                | `NOT_EVALUATED`      |                                                       |                       |           |                    |
| UAT-07 reviews/notifications/dispute/privacy    | Customer/craftsman            |                | `NOT_EVALUATED`      |                                                       |                       |           |                    |
| UAT-08 restrictions/session boundary            | Restricted/suspended actor    |                | `NOT_EVALUATED`      |                                                       |                       |           |                    |
| Browser registration + email/phone verification | New customer                  |                | `NOT_EVALUATED`      | UI exists; record named manual browser/device result. |                       |           |                    |
| Craftsman onboarding/profile/portfolio          | New craftsman                 |                | `NOT_EVALUATED`      | Record named profile and private portfolio authoring. |                       |           |                    |
| UAT-10 private credential claim/evidence        | New craftsman                 |                | `NOT_EVALUATED`      | Pending is not verified; private READY evidence only. |                       |           |                    |
| UAT-12 managed taxonomy and suggestion          | Customer/craftsman/admin      |                | `NOT_EVALUATED`      | Shared top-10 catalog; admin step needs genuine MFA.  |                       |           |                    |
| Admin operational UI with provider-backed MFA   | Admin                         |                | `BLOCKED_HUMAN_GATE` | Real TOTP/WebAuthn enrollment and privileged session. |                       |           |                    |

## Exploratory and failure results

| Probe                      | Status          | Affected case | Bounded observation | Integrity result | Defect ID |
| -------------------------- | --------------- | ------------- | ------------------- | ---------------- | --------- |
| Refresh / Back / Forward   | `NOT_EVALUATED` |               |                     |                  |           |
| Multiple tabs              | `NOT_EVALUATED` |               |                     |                  |           |
| Slow network               | `NOT_EVALUATED` |               |                     |                  |           |
| Temporary offline / retry  | `NOT_EVALUATED` |               |                     |                  |           |
| Double click               | `NOT_EVALUATED` |               |                     |                  |           |
| Interrupted upload         | `NOT_EVALUATED` |               |                     |                  |           |
| Logout/revoked session     | `NOT_EVALUATED` |               |                     |                  |           |
| Genuine expired session    | `NOT_EVALUATED` |               |                     |                  |           |
| Verification sink outage   | `NOT_EVALUATED` |               |                     |                  |           |
| Worker/queue interruption  | `NOT_EVALUATED` |               |                     |                  |           |
| Scanner/media interruption | `NOT_EVALUATED` |               |                     |                  |           |
| API/database interruption  | `NOT_EVALUATED` |               |                     |                  |           |

## Compatibility and accessibility

Do not treat emulation as an actual-device result.

| Target                        | Manual status   | Keyboard/focus/errors | Responsive usability | Notes/defect |
| ----------------------------- | --------------- | --------------------- | -------------------- | ------------ |
| Current Chrome desktop        | `NOT_EVALUATED` |                       |                      |              |
| Current Edge/Chromium desktop | `NOT_EVALUATED` |                       |                      |              |
| Current Firefox desktop       | `NOT_EVALUATED` |                       |                      |              |
| Current Safari desktop        | `NOT_EVALUATED` |                       |                      |              |
| Actual iPhone Safari          | `NOT_EVALUATED` |                       |                      |              |
| Actual Android Chrome         | `NOT_EVALUATED` |                       |                      |              |

## Separate automated evidence

These references provide context only. They do not change any manual status.

| Evidence                          | Evidence class        | Revision/environment | Result/reference |
| --------------------------------- | --------------------- | -------------------- | ---------------- |
| CI quality suite                  | `AUTOMATED_SYNTHETIC` |                      |                  |
| R4 canonical marketplace loop     | `AUTOMATED_SYNTHETIC` |                      |                  |
| R4 security/negative/race suite   | `AUTOMATED_SYNTHETIC` |                      |                  |
| Local synthetic restore rehearsal | `AUTOMATED_SYNTHETIC` |                      |                  |

## Defect ledger

| Defect ID | Severity                                           | Case/surface | Bounded description | Workaround | Owner | Due date | State                                      |
| --------- | -------------------------------------------------- | ------------ | ------------------- | ---------- | ----- | -------- | ------------------------------------------ |
|           | `BLOCKER` / `CRITICAL` / `HIGH` / `MEDIUM` / `LOW` |              |                     |            |       |          | `OPEN` / `FIXED_PENDING_RETEST` / `CLOSED` |

For a `HIGH`, record a workaround but do not record risk acceptance here. A
real-user risk acceptance is a named human decision in the go/no-go record.

## Human-gated evidence status

| Gate                                            | Status               | What is still required                                                                               |
| ----------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| Provider-managed isolated staging               | `BLOCKED_HUMAN_GATE` | Approved account, billing, DNS, credentials and uninterrupted staging run.                           |
| Real email/SMS delivery providers               | `BLOCKED_HUMAN_GATE` | Vendor/processor approval, accounts, credentials and real delivery evidence.                         |
| Production infrastructure/backups/monitoring    | `BLOCKED_HUMAN_GATE` | Approved providers, credentials, alert receiver, recovery mapping and tested evidence.               |
| Real admin MFA                                  | `BLOCKED_HUMAN_GATE` | Approved provider, enrolled named admin, recovery ownership and provider-backed tests.               |
| Legal/privacy production baseline               | `BLOCKED_HUMAN_GATE` | Approved controller/contact, Privacy Notice, Terms, purpose/basis and retention/processor decisions. |
| Real-user invite cohort and production go/no-go | `BLOCKED_HUMAN_GATE` | Named human approval after every D30 gate passes.                                                    |
| Real customer and craftsman completion evidence | `NOT_EVALUATED`      | Occurs only after an authorized launch; synthetic actors cannot satisfy it.                          |

## Run verdict

- Synthetic internal-test continuation:
  `NOT_EVALUATED` / `GO` / `NO-GO`
- Open `BLOCKER` count:
- Open `CRITICAL` count:
- Open `HIGH` count:
- Reviewer rationale:

### Real-user production verdict

**NO-GO.** This synthetic evidence record cannot authorize production or real
users. Provider, legal/privacy, real admin-MFA, production operations and the
explicit D30 launch decision remain outside this run.

## Evidence hygiene attestation

- [ ] No secret, cookie, token, OTP, claim body, signed URL or storage state is
      included.
- [ ] No real personal data is included.
- [ ] Manual and automated results are recorded in separate sections.
- [ ] Missing browser UI and unavailable devices are not marked `PASS`.
- [ ] No human-gated item was inferred from synthetic evidence.
- [ ] The real-user production verdict remains `NO-GO`.

Tester/date:

Reviewer/date:

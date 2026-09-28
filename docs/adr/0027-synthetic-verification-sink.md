# ADR 0027: Local encrypted sink for synthetic verification secrets

- Status: Accepted for synthetic testing only
- Date: 2026-09-28
- Ticket: R4-030 canonical staging E2E

## Context

The canonical D30 staging scenario must register a fresh account and complete
email and phone verification without a manual database edit. The normal API
correctly fails closed when no delivery provider is configured. Selecting a
real email or SMS vendor would introduce an external account, processor,
credentials, terms and potentially a paid personal-data flow, so it is a HUMAN
GATE rather than an implementation shortcut.

The temporary Alpha target uses synthetic identities and zero-cost local
infrastructure. It therefore needs a narrow way for automated tests to receive
the same one-time secrets that a real provider would deliver. Returning a token
or OTP from the verification command, writing it to logs, storing plaintext in
PostgreSQL, or exposing a mailbox-like public UI would weaken the production
boundary and is rejected.

## Decision

Add a dedicated `synthetic-verification-sink` service to the temporary Alpha
composition. The API may use it only when all explicit synthetic-fixture gates
are satisfied:

- the runtime environment is non-production;
- `ALPHA_SYNTHETIC_FIXTURE=1`;
- `SYNTHETIC_VERIFICATION_MODE=encrypted-sink`;
- the sink origin is the fixed internal origin
  `http://synthetic-verification-sink:8467`; and
- the configured destination is a structurally valid synthetic address: a
  signed `synthetic.e2e.<nonce>.<mac>@portal.invalid` email address or the
  reserved synthetic `+999` phone namespace.

The sink has three bounded HTTP operations:

- internal `POST /v1/deliver`, authenticated with a dedicated ingest key,
  accepts `{ channel, destination, secret }` and returns only `202` with
  `{ accepted: true }`;
- loopback-only `POST /v1/claim`, authenticated with a different claim key,
  accepts `{ channel, destination }` and returns the secret once; and
- `GET /health/ready`, which exposes no delivery state.

Every response is `Cache-Control: no-store`. There is no list/search endpoint,
mailbox UI, Nginx route, tunnel route or public service port. The service joins
only the internal Alpha network; its host port is bound to loopback for the
local E2E runner. The API can ingest but cannot claim, and the test runner can
claim but cannot ingest.

Pending secrets are stored in a dedicated SQLite volume as AES-GCM ciphertext.
Lookup uses an HMAC of the normalized destination rather than destination
plaintext. Records have a short TTL and a hard capacity, are consumed on a
successful claim, and are not copied to the portal database, object storage or
backup workflow. The sink is delivery plumbing only: the existing
server-authoritative token/OTP consumption remains the sole verification
authority.

## Threat model and controls

The token and OTP are bearer secrets until consumed. Relevant attackers are an
internet client reaching the temporary Alpha URL, another synthetic account,
a process that obtains only one service credential, a reader of logs or CI
artifacts, and an operator accidentally enabling test plumbing in a production
configuration.

Controls are deliberately layered:

- the sink has no edge or egress network and is absent from Nginx routing;
- ingest and claim use independently generated high-entropy bearer keys;
- bearer keys travel in headers, never URLs, and are mounted from read-only
  Compose secret files;
- the encryption key, ingest key, claim key and synthetic-registration signing
  key are separate secrets under ignored `.alpha/secrets/` paths;
- exact signed synthetic destinations prevent the sink from accepting ordinary
  email addresses or real telephone numbers;
- claims are exact-destination, one-time, TTL-bounded and non-enumerable;
- response bodies, destinations, tokens, OTPs, Authorization headers and
  ciphertext are excluded from application, proxy and test logs;
- screenshots, Playwright traces, videos and uploaded CI artifacts must not
  capture claim responses; and
- production mode or an incomplete/inconsistent synthetic configuration fails
  at startup rather than falling back to the sink.

Basic Auth, portal sessions and the sink keys are separate boundaries. Knowing
the temporary Alpha Basic Auth password or having a portal session does not
authorize a claim. Conversely, a claim key does not authorize portal actions
or API delivery writes.

## Secret handling runbook

The Alpha initializer generates the four sink-related values locally:

- `synthetic_verification_ingest_key`;
- `synthetic_verification_claim_key`;
- `synthetic_verification_encryption_key`; and
- `synthetic_registration_signing_key`.

They remain in ignored `.alpha/secrets/` files. Do not paste them into shell
history, command arguments, URLs, tickets, chat, screenshots or test output.
Load the claim key into the E2E process from its file, use it only in the
Authorization header, and retain the claimed secret only long enough to call
the normal verification endpoint. Test helpers must not print failed response
bodies from claim calls because a successful body contains the secret.

Stop the sink and remove its synthetic SQLite volume when retiring the Alpha
fixture. Rotate all four values after suspected exposure. Sink contents are not
recovery data and must not be included in database or media restoration
evidence.

## Boundaries and consequences

- This is a zero-cost, test-only substitute for provider delivery, not a mail
  server, SMS gateway, production feature or proof of provider reliability.
- It accepts synthetic destinations only and must never be widened to a real
  address or telephone range.
- A passing sink-backed scenario proves the portal's registration and
  verification commands through the deployed Alpha boundary. It does not close
  D30 provider, privacy, operational-readiness or real-user go/no-go gates.
- Choosing and configuring real email/SMS providers, accepting their legal or
  processor terms, creating paid resources, supplying production credentials,
  or sending real contact data remains an explicit HUMAN GATE.
- Production keeps the existing fail-closed behavior until that gate is
  resolved. The synthetic adapter and sink configuration are not a permitted
  production fallback.

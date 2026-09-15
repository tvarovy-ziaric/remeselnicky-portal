# Product analytics boundary

`@portal/analytics` is the internal, provider-neutral D28 boundary. It records
privacy-minimized observations of product outcomes; it is never authoritative
for domain state and its availability cannot change a command result.

## R0 contract

- Every event is selected from the version-controlled catalog in
  `packages/analytics/src/catalog.ts`. Unknown names and unknown properties are
  rejected before delivery.
- The common envelope contains an event UUID, catalog name and schema version,
  a server UTC timestamp, one pseudonymous actor or anonymous context, platform,
  application release and environment.
- Actor IDs and entity IDs must be internal UUIDs. Email, phone, exact address,
  coordinates, chat/review/request/quote text, filenames, documents, tokens,
  signed URLs and whole business objects have no schema path into this package.
- Authenticated context carries explicit `is_internal` and `is_test` exclusion
  flags. Admin actions are not accepted as marketplace funnel events.
- Anonymous/session IDs use random first-party opaque values and carry trusted
  `is_internal`/`is_test` exclusion flags. A caller may only
  create or persist those identifiers when the D27 cookie/consent rules permit
  it; this package neither creates cookies nor treats analytics as necessary
  authentication storage.
- A transport declares its exact environment. Cross-environment delivery and a
  test transport in production fail closed without calling the destination.
  No-op collection is explicit and observable through `readiness()`.
- Delivery and diagnostic failures resolve to a privacy-safe result. They do not
  throw into the business workflow and diagnostics contain no event properties.

No vendor SDK belongs in domain code. A future provider adapter implements only
`AnalyticsTransport` at the composition edge and receives the validated
envelope. Dev, staging and production use separate adapter instances and
destinations.

## Critical server-side events

R0 defines only the locked server outcomes needed to prepare the core alpha
funnel: registration/contact verification, submitted request, engaged
invitation, submitted/accepted quote, confirmed/completed Job and submitted
review. One locked `public_profile_viewed` UX schema provides the deliberately
bounded anonymous-context path; R0 does not add client instrumentation. This is
not the final feature catalog: feature tickets and R4-027 add their locked
UX/domain events and KPI definitions deliberately.

R2 search/liquidity event schemas and their authoritative denominators are
documented in `docs/analytics/search-liquidity-events.md`. That feature does not
itself wire `public_profile_viewed`; the public route still needs the compliant
client consent/admission seam before emitting it.

For a critical conversion, the owning command first commits its domain state and
transactional outbox event. An idempotent analytics consumer then maps that
successful domain event to one catalog event and reuses a stable event UUID.
Retries deliver the same validated envelope/event ID. A click or attempted
command must never emit the successful conversion event.

The domain database remains normalized and is not used as an unbounded generic
analytics log. Provider/raw-event retention, cookie consent UI, vendor choice,
complete KPI denominators and dashboard tooling remain in their explicitly
deferred D27/D28/R4 work.

## R3 demand funnel

Migration 0053 captures only committed request, invitation, conversation and
Quote effects into `r3.analytics.*` source events. It never derives conversions
from notification fanout. Request submission and first Quote submission use
catalog schema v2; the exact v1 definitions remain available for historical
replay. Dashboards must group/filter by both `event_name` and `schema_version`.
Later Quote submissions use `quote_revision_submitted`.

The R3 consumer owns `r3_analytics_event_deliveries`. Its lease, retry and
terminal state is independent of the global outbox status, including when the
notification consumer has already published or terminally classified the same
source row. A provider receives the immutable source event UUID as its
idempotency key. `INVALID_EVENT` is terminal, an explicitly disabled transport
is terminal-skipped, and unavailable or misconfigured transport is retryable.
The business and notification worker continue even when analytics storage or
transport fails.

Traffic class is snapshotted at the effect. Absence means `REAL`; explicit test
fixtures are `TEST`; an active admin role or explicit internal classification
is `INTERNAL`, with `TEST` taking precedence. There is no public or owner API
for classification. System expiry events retain an explicit system initiator
fact while using the affected marketplace profile as the analytics subject.

Quote view and comparison observations are client-visible facts, so the browser
emits them only after a real viewport intersection in a visible tab. The server
then rechecks ACTIVE customer ownership, current Quote state/content and current
`NON_ESSENTIAL_ANALYTICS` consent under shared serialization. Missing or
withdrawn consent is a uniform HTTP 204 no-op. PDF-open observation is not
trusted from the browser: it is attempted only after the existing private media
delivery resolver returns success, and it independently repeats the exact
current external-PDF/canonical-object authorization. All analytics failures are
non-blocking.

No R3 event carries request/chat/Quote text, amounts, raw query/location,
contact/address data, document/storage identifiers, filenames, hashes,
competitor lists or result UUID arrays. Bounded categories and counts are
server-derived. This ticket adds no analytics-driven ranking behavior or vendor.

### D28 R3 coverage ledger

- D28.101 and .106–.114 are server-derived from committed JobRequest effects;
  `UNKNOWN` budget is not counted as provided and photo/timing values are
  bounded categories.
- D28.115–.117 reuse the already-shipped R2 search-result/open and private
  shortlist events. R3 does not create a second semantic definition.
- D28.118–.130 are captured from invitation/message effects. Invitation view
  is a consented, actually-visible provider observation; message analytics use
  first/bilateral facts and a bounded count, never content.
- D28.131 is emitted only when controlled processing marks a chat IMAGE/PDF
  attachment READY, using count/type buckets. Filename, bytes, storage and
  media IDs have no event property.
- D28.136–.150 are captured from immutable Quote effects and consented views.
  PDF open is coupled to successful private-delivery authorization.
- D28.102–.105 remain deliberately deferred: autosave and recovery exist, but
  there is no consented, viewport-aware form-step/abandonment observation seam.
  A server autosave is not mislabelled as UX success or abandonment, and no
  draft content is placed in analytics. These events belong with that future
  client seam rather than being inferred from persistence traffic.

The exact R3 inventory is:

- implemented server effects: `job_request_started`,
  `job_request_submitted` v2, request cancel/expire/reactivate/material revision,
  invitation sent/received/engaged/declined/expired/withdrawn/not-selected,
  first message, bilateral participation, READY attachment, Quote draft,
  first/later submit, reject, withdraw and expire;
- implemented consented UX facts: invitation viewed, Quote viewed, comparison
  opened and external-PDF opened after secure delivery;
- reused R2 facts: candidate list shown, candidate profile opened and shortlist
  size; their established catalog schemas remain the single authority;
- deferred with the missing safe product surface: autosave success/failure,
  restored draft, form-step viewed/completed and abandonment; and
- deferred to R4 because no successful domain effect exists yet: Quote selected
  recap, acceptance, confirmed Job and all later execution/completion events.

Funnel reports use entity-level denominators, not raw delivery counts:

- submitted requests are distinct `job_request_id` on
  `job_request_submitted` v2; v1 is reported separately;
- invitation response rate uses distinct invitations with ENGAGED or DECLINED
  over distinct sent invitations in the same eligible cohort. EXPIRED remains a
  separate no-response outcome; withdrawal/not-selected are separate terminal
  outcomes;
- time-to-first response is the server effect-time delta from invitation sent
  to the first ENGAGED or DECLINED effect for that invitation;
- invitations-needed-to-first-engagement counts distinct sent invitations for
  a request up to its first ENGAGED effect;
- first-message and bilateral metrics use one first/bilateral event per
  conversation; message volume and attachment volume use only their locked
  buckets;
- Quote submission counts distinct quote/revision identities, with
  `quote_submitted` v2 first-only and `quote_revision_submitted` later-only;
  old `quote_submitted` v1 is never mixed into that definition;
- Quote view/comparison denominators use distinct consented first observations;
  `available_quote_count` is the DB-authoritative eligible-card count clamped to
  the five-card UI bound, not a client page count; and
- quote-to-accept and Job completion KPIs remain unavailable until the R4
  server effects exist. No click is substituted for those conversions.

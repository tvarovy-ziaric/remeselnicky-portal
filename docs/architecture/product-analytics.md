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
- Anonymous/session IDs use random first-party opaque values. A caller may only
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

For a critical conversion, the owning command first commits its domain state and
transactional outbox event. An idempotent analytics consumer then maps that
successful domain event to one catalog event and reuses a stable event UUID.
Retries deliver the same validated envelope/event ID. A click or attempted
command must never emit the successful conversion event.

The domain database remains normalized and is not used as an unbounded generic
analytics log. Provider/raw-event retention, cookie consent UI, vendor choice,
complete KPI denominators and dashboard tooling remain in their explicitly
deferred D27/D28/R4 work.

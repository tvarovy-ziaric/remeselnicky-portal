# Notification foundation (R0-023)

## Boundary

Notifications are a delivery layer over authoritative domain events. A domain
command commits its state and the event to the transactional outbox. The outbox
worker then invokes `createNotificationOutboxPublisher`; the consumer claim,
in-app record and requested channel rows commit atomically. A delivery failure
therefore cannot roll back or rewrite business state.

R4-024 adds the complete Web Alpha catalog. Each feature registers an explicit
event mapper that chooses a stable notification type, recipient, priority,
exact entity/revision path and channels. `catalog.ts` is the shared
type-to-category, privacy-safe Slovak presentation and email-reliability policy.
Unknown events are ignored without taking a consumer claim; an unknown
notification type or invalid mapped data fails closed before a partial record
can be created.

## Stored model

`notifications` is the canonical in-app inbox and stores:

- recipient user, stable type and triggering outbox event/idempotency key;
- entity type/id, optional immutable revision, and an app-relative deep link;
- `INFO`, `IMPORTANT` or `CRITICAL` priority;
- server-created UTC timestamp plus independent read/archive timestamps; and
- a small, flat, machine-value payload used to select safe presentation copy.

Creation is guarded by a unique `(domain_event_id, recipient_user_id, type)`
constraint in addition to the transactional outbox consumer claim. Worker
retries therefore cannot create duplicate in-app records. Core provenance and
content are immutable after creation. `requested_channels` preserves producer
intent while `delivery_channels` preserves the first preference-policy
decision, so replay cannot change delivery after a later preference edit.
Read/archive operations are scoped by both
notification ID and recipient ID. They only update notification UX state; they
do not call a domain command, update outbox state, or imply approval. Deep-link
targets must re-run normal object/action authorization when opened.

The database and TypeScript validator both reject payload keys for chat/body,
descriptions, exact address/coordinates, contact details, credentials/tokens,
reviews and similar content. Values are bounded machine scalars, not rendered
sentences. Links cannot contain a host, query string or fragment, so they cannot
be bearer links. Rendered copy is generated later from type plus safe context.

## Channel delivery

In-app is required for every mapped notification. `notification_deliveries`
stores asynchronous EMAIL delivery and reserves PUSH as a future channel; push
is not enabled in Web Alpha. Delivery rows have a stable provider idempotency
key, attempt counter, availability time, expiring lease and explicit
`QUEUED / PROCESSING / SENT / DELIVERED / TERMINAL_FAILED` state.

`createNotificationEmailWorker` is the independently deployable worker
contract. It leases one email, passes the same idempotency key on every attempt,
and conditionally records sent, delivered, retry or terminal state only while
the lease is current. Operational telemetry includes delivery ID, stable type,
attempt, outcome and error code—never recipient/contact data or payload.

The adapter receives a user ID and resolves the current verified address inside
the delivery boundary; raw addresses are not persisted in notification rows.
Private attachments and business text are absent from its request. The default
unavailable adapter fails closed with `EMAIL_PROVIDER_UNAVAILABLE`, which moves
the delivery to visible terminal state instead of pretending that email was
sent. Selecting and authorizing a real production email provider/account remains
an external HUMAN GATE. Tests may inject deterministic adapters without making
that vendor decision.

## Web Alpha center and preferences

The authenticated `/v1/me/notifications` surface provides `All / Unread`, a
global unread count, mark-one/mark-all-read and archive operations. Every query
is scoped from the active server session; no recipient selector is accepted.
Mutations require CSRF, and responses are private/no-store/no-index. The API
returns generated short copy and a relative path, but not outbox IDs, event
keys or the private machine payload. Opening a path reaches the normal
authorized entity route and never substitutes a business command.

`notification_channel_preferences` stores EMAIL/PUSH preferences by category.
IN_APP cannot be inserted into that table and remains canonical. Optional CHAT
and review email obeys the preference (together with the conversation mute);
notification-specific required transactional/security email overrides an
opt-out. The immutable in-app record is still created in every case.

## Worker wiring contract

Production wiring composes existing pieces without importing application code
into shared packages:

1. `createOutboxWorker` uses `createNotificationOutboxPublisher` and the DB
   outbox transaction/consumer-claim ports.
2. The publisher uses `database.notifications.writer` for atomic creation.
3. A worker loop calls `createNotificationEmailWorker.processNext()` with
   `database.notifications`, an authorized email adapter and bounded backoff.
4. `database.notifications.snapshot()` feeds queue/email backlog, age and
   terminal-failure monitoring.

Provider webhook verification and mobile push-token lifecycle remain later
tickets. Those layers must preserve the same type/idempotency taxonomy and D25
privacy boundaries.

# Notification foundation (R0-023)

## Boundary

Notifications are a delivery layer over authoritative domain events. A domain
command commits its state and the event to the transactional outbox. The outbox
worker then invokes `createNotificationOutboxPublisher`; the consumer claim,
in-app record and requested channel rows commit atomically. A delivery failure
therefore cannot roll back or rewrite business state.

The package contains no feature notification catalog. Each later feature must
register an explicit event mapper that chooses a stable notification type,
recipient, priority, exact entity/revision path and channels. Unknown events are
ignored without taking a consumer claim. Invalid mapped data is a permanent,
observable outbox failure rather than a partially created notification.

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
content are immutable after creation. Read/archive operations are scoped by both
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

Feature catalogs, user preference UI, batching policy, provider webhook
verification and mobile push-token lifecycle remain later tickets. Those layers
must preserve the same type/idempotency taxonomy and D25 privacy boundaries.

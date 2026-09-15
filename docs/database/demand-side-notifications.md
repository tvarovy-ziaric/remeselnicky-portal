# R3 demand-side notification catalog

R3-020 extends the notification/outbox foundation with demand-side workflow
events. Notifications remain derived delivery records: invitation, request,
conversation and Quote state is authoritative even when notification mapping or
email delivery fails.

## Stable event and notification taxonomy

| Authoritative effect                     | Outbox event                           | Recipient                                 | Notification type                  | Channels                                      |
| ---------------------------------------- | -------------------------------------- | ----------------------------------------- | ---------------------------------- | --------------------------------------------- |
| invitation sent                          | `job_invitation.sent`                  | invited provider                          | `job_invitation.received`          | in-app + email                                |
| reminder becomes due                     | `job_invitation.expiry_reminder`       | invited provider                          | same event name                    | in-app + email                                |
| provider engages                         | `job_invitation.engaged`               | customer                                  | `job_invitation.provider_engaged`  | in-app + email                                |
| provider declines                        | `job_invitation.declined`              | customer                                  | `job_invitation.provider_declined` | in-app                                        |
| customer withdraws pending invitation    | `job_invitation.withdrawn_by_customer` | provider                                  | same event name                    | in-app                                        |
| provider withdraws candidacy             | `job_invitation.withdrawn_by_provider` | customer                                  | same event name                    | in-app                                        |
| request closes candidacy                 | `job_invitation.request_closed`        | provider                                  | same event name                    | in-app                                        |
| candidacy becomes not selected           | `job_invitation.not_selected`          | provider                                  | same event name                    | in-app                                        |
| invitation expires                       | `job_invitation.expired`               | customer                                  | same event name                    | in-app                                        |
| human message is accepted                | `conversation.message_created`         | exact counterparty                        | `conversation.message_received`    | immediate in-app; delayed generic email batch |
| active request materially changes        | `job_request.materially_updated`       | each current pending/engaged provider     | same event name                    | in-app + email                                |
| first Quote revision is submitted        | `quote.submitted`                      | customer                                  | same event name                    | in-app + email                                |
| later Quote revision is submitted        | `quote.revised`                        | customer                                  | same event name                    | in-app + email                                |
| customer rejects Quote                   | `quote.rejected`                       | provider                                  | same event name                    | in-app                                        |
| provider withdraws Quote                 | `quote.withdrawn`                      | customer                                  | same event name                    | in-app                                        |
| Quote reaches explicit validity deadline | `quote.expired`                        | customer and provider, as separate events | same event name                    | in-app                                        |

`CUSTOMER_STOP` and the system `NOT_SELECT` transition reuse the same neutral
not-selected contract. This R3 catalog does not create Job/acceptance events or
the R4 notification-preference surface. Creating a reconfirmation draft does
not notify the customer; submitting that immutable revision emits
`quote.revised`.

## Privacy and authorization

Capture functions derive recipients from profile ownership and the exact
invitation/Quote/conversation relation. Callers cannot provide recipient,
audience, path or event time. Payloads contain only opaque IDs, positive
revisions/sequences and bounded action codes. They never contain request or
chat text, rejection/decline reasons, price, competitor facts, contact data,
exact location, filenames, media/storage references or document bytes.

Deep links are relative application routes and are not bearer capabilities.
The target API must re-run current object authorization. Customer Quote
submission/revision events link to the private comparison route. Terminal
withdrawn/expired events for either party and provider-facing events link to
the exact invitation conversation, because comparison intentionally excludes a
terminal Quote. Material updates link to the exact authorized request-content
revision under the invitation. A provider may open only the send-time pinned
revision or a revision backed by that invitation's immutable DB-derived
material-update entitlement. The operational outbox is not an authorization
authority. Changing the revision in the URL cannot expose pre-invitation,
non-material or post-terminal request history.

## Idempotency and delivery isolation

`insert_exact_notification_outbox_event` inserts by a deterministic event key.
On conflict it locks and exact-compares event name, schema, occurrence time,
entity, payload, command name and correlation; a reused key with different
intent aborts instead of being silently accepted. Reminder occurrence remains
the DB scheduler time from the first successful enqueue. The narrow reminder
helper recognizes an exact pre-0052 event with its original occurrence for
upgrade compatibility; configurable policy only determines when a missing
reminder is first enqueued.

The notification writer independently exact-compares an existing
event/recipient/type row, its context, priority, payload and intended channel
set before treating a retry as idempotent. Outbox consumer claims,
notifications and delivery rows commit together. SMTP/provider work stays in
the asynchronous delivery worker, so provider failure cannot roll back a
business transition.

## Chat mute, unread and batching

The DB-derived `conversation_notification_states` row is a privacy-minimal
serialization head. Both message commands and participant preference commands
use one total lock order:

1. command advisory lock;
2. exact recipient notification state;
3. conversation/invitation context;
4. message or participant history effect.

This makes message-versus-mute linearizable without trusting application-only
checks. A muted recipient gets neither an ordinary message notification nor a
later email for that message. `MUTE` advances the durable considered watermark
through the current latest message; `MARK_READ` advances it through the exact
read sequence. Therefore unmuting never revives an old burst. Archive state is
intentionally irrelevant to business-notification eligibility.

Immediate chat mapping is in-app only. Maintenance waits for the configurable
DB delay, then locks each exact state head and schedules at most one generic
email delivery for the latest still-unread, unmuted message in the burst.
`conversation_notification_email_batches` is append-only and the notification
delivery has its own unique idempotency key. No active-view/presence claim is
made because R3 has no authoritative presence seam; reading the conversation
before maintenance suppresses the email through `last_read_sequence`.

## Integrated runtime seam

Migration 0052 is wired through four narrow integration points:

- `@portal/db` exports and creates `createDemandSideNotificationRepository`;
- the worker uses `mapDemandSideNotificationEvent` as its notification mapper;
- the existing bounded maintenance cycle calls `enqueueDueUnreadChatEmails`;
- the single migration runner executes the standalone R3-020 assertions after
  the Quote lifecycle fixture.

The runtime delay is offline-configurable DB policy, not a product promise or
an invented email-provider schedule.

Material edits, invitation transitions, request cancellation and expiry use a
second total order: immutable request identity resolution, request advisory
lock `41007`, then actor/profile/request/invitation rows. Candidate discovery
for sweepers is non-locking and every candidate is freshly revalidated only
after the advisory lock.

import { createHash, randomUUID } from "node:crypto";

import {
  normalizeJobRequestContentSection,
  type ConversationId,
  type ConversationParticipantState,
  type CraftsmanProfileId,
  type JobInvitationId,
  type JobRequestCoreContent,
  type JobRequestId,
  type UserId,
} from "@portal/domain";
import type { EventPayload, PersistedDomainEvent } from "@portal/outbox";
import {
  createNotificationOutboxPublisher,
  mapDemandSideNotificationEvent,
} from "@portal/notifications";
import type { Sql, TransactionSql } from "postgres";
import { expect } from "vitest";

import { createConversationChatRepository } from "../src/conversation-chat-repository.js";
import { createDemandSideNotificationRepository } from "../src/demand-side-notification-repository.js";
import { createJobInvitationRepository } from "../src/job-invitation-repository.js";
import { createJobRequestLifecycleRepository } from "../src/job-request-lifecycle-repository.js";
import { createJobRequestRepository } from "../src/job-request-repository.js";
import { createJobRequestVersionRepository } from "../src/job-request-version-repository.js";
import { createNotificationRepository } from "../src/notification-repository.js";
import { createOutboxRepository } from "../src/outbox-repository.js";

interface ConversationFixture {
  readonly conversationId: ConversationId;
  readonly customerOwnerId: UserId;
  readonly invitationId: JobInvitationId;
  readonly jobRequestId: JobRequestId;
  readonly providerOwnerId: UserId;
}

interface EventRow {
  readonly commandName: string;
  readonly correlationId: string;
  readonly entityId: string;
  readonly entityType: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly payload: EventPayload;
  readonly schemaVersion: number;
}

/** Standalone R3-020 assertions; root wires this after the R3-019 fixture. */
export async function runDemandSideNotificationIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const fixture = await loadWritableFixture(sql);
  const chat = createConversationChatRepository(sql);
  const maintenance = createDemandSideNotificationRepository(sql);
  const notifications = createNotificationRepository(sql);
  const outbox = createOutboxRepository(sql);
  const publisher = createNotificationOutboxPublisher({
    claims: outbox.consumerClaims,
    mapper: mapDemandSideNotificationEvent,
    notifications: notifications.writer,
    transactions: outbox.transactions,
  });

  await ensureUnmuted(chat, sql, fixture);
  await sql`
    UPDATE demand_notification_runtime_policy
    SET chat_email_delay_seconds = 1, updated_at = clock_timestamp()
    WHERE singleton
  `;
  try {
    const first = await sendAndPublish(
      sql,
      chat,
      publisher,
      fixture,
      "Prvá bezpečná správa.",
    );
    await expectEmailCount(sql, first.event.eventId, 0);

    const beforeMute = await loadState(sql, fixture);
    await expect(
      chat.updateParticipantState({
        action: "MUTE",
        actorUserId: fixture.providerOwnerId,
        commandId: randomUUID(),
        conversationId: fixture.conversationId,
        expectedRevision: beforeMute.revision,
      }),
    ).resolves.toMatchObject({ status: "APPLIED" });
    const mutedSequence = await sendWithoutPublishing(
      chat,
      fixture,
      "Správa počas stíšenia.",
    );
    const [mutedEvent] = await sql<Array<{ readonly count: number }>>`
      SELECT count(*)::integer AS count FROM domain_outbox_events
      WHERE event_name = 'conversation.message_created'
        AND entity_id = ${fixture.conversationId}
        AND (payload ->> 'conversation_sequence')::integer = ${mutedSequence}
    `;
    expect(mutedEvent?.count).toBe(0);
    await sql`SELECT pg_sleep(1.1)`;
    await expect(maintenance.enqueueDueUnreadChatEmails()).resolves.toBe(0);

    const muted = await loadState(sql, fixture);
    await expect(
      chat.updateParticipantState({
        action: "UNMUTE",
        actorUserId: fixture.providerOwnerId,
        commandId: randomUUID(),
        conversationId: fixture.conversationId,
        expectedRevision: muted.revision,
      }),
    ).resolves.toMatchObject({ status: "APPLIED" });
    await expect(maintenance.enqueueDueUnreadChatEmails()).resolves.toBe(0);
    await expectEmailCount(sql, first.event.eventId, 0);

    const second = await sendAndPublish(
      sql,
      chat,
      publisher,
      fixture,
      "Nová správa po zapnutí upozornení.",
    );
    const latest = await sendAndPublish(
      sql,
      chat,
      publisher,
      fixture,
      "Druhá správa v rovnakom emailovom burste.",
    );
    await sql`SELECT pg_sleep(1.1)`;
    await expect(maintenance.enqueueDueUnreadChatEmails()).resolves.toBe(1);
    await expect(maintenance.enqueueDueUnreadChatEmails()).resolves.toBe(0);
    await expectEmailCount(sql, second.event.eventId, 0);
    await expectEmailCount(sql, latest.event.eventId, 1);
    await expectOutboxCollisionRejected(sql, second.row);
    await expectNotificationChannelCollisionRejected(
      outbox,
      notifications,
      first.event,
    );

    const readBeforeSweep = await sendAndPublish(
      sql,
      chat,
      publisher,
      fixture,
      "Správa prečítaná pred emailovým sweepom.",
    );
    const beforeRead = await loadState(sql, fixture);
    await expect(
      chat.updateParticipantState({
        action: "MARK_READ",
        actorUserId: fixture.providerOwnerId,
        commandId: randomUUID(),
        conversationId: fixture.conversationId,
        expectedRevision: beforeRead.revision,
        readThroughSequence: readBeforeSweep.sequence,
      }),
    ).resolves.toMatchObject({ status: "APPLIED" });
    await sql`SELECT pg_sleep(1.1)`;
    await expect(maintenance.enqueueDueUnreadChatEmails()).resolves.toBe(0);
    await expectEmailCount(sql, readBeforeSweep.event.eventId, 0);

    const beforeArchive = await loadState(sql, fixture);
    await expect(
      chat.updateParticipantState({
        action: "ARCHIVE",
        actorUserId: fixture.providerOwnerId,
        commandId: randomUUID(),
        conversationId: fixture.conversationId,
        expectedRevision: beforeArchive.revision,
      }),
    ).resolves.toMatchObject({ status: "APPLIED" });
    const afterArchive = await sendAndPublish(
      sql,
      chat,
      publisher,
      fixture,
      "Správa po archivovaní konverzácie.",
    );
    await sql`SELECT pg_sleep(1.1)`;
    await expect(maintenance.enqueueDueUnreadChatEmails()).resolves.toBe(1);
    await expectEmailCount(sql, afterArchive.event.eventId, 1);

    await publishExistingWorkflowEvents(sql, publisher);
    await expectAuthoritativeRecipients(sql);
    await expectMaterialFanoutAndMinorSilence(sql);
    await expectQuoteExpiryAudiencePaths(sql);
    await expectPrivacyMinimalPersistence(sql);
    await expectOutsiderParticipantCommandDenied(sql, chat, fixture);
    await expectLegacyReminderReplayAndRollback(sql);
    await expectMaterialEntitlementCannotBeForged(sql, fixture);
    await expectMessageVersusMuteLockOrder(sql, fixture);
    await expectMaterialEditVersusCancellationLockOrder(sql, fixture);
    await expectMaterialEditVersusInvitationLockOrder(sql, fixture);
  } finally {
    await sql`
      UPDATE demand_notification_runtime_policy
      SET chat_email_delay_seconds = 900, updated_at = clock_timestamp()
      WHERE singleton
    `;
  }
}

async function loadWritableFixture(sql: Sql): Promise<ConversationFixture> {
  const [row] = await sql<ConversationFixture[]>`
    SELECT conversation.id AS "conversationId",
      invitation.id AS "invitationId",
      invitation.job_request_id AS "jobRequestId",
      customer.owner_user_id AS "customerOwnerId",
      craftsman.owner_user_id AS "providerOwnerId"
    FROM conversations conversation
    JOIN current_conversations current ON current.id = conversation.id
    JOIN job_invitations invitation
      ON invitation.id = conversation.invitation_id
    JOIN customer_profiles customer
      ON customer.id = invitation.customer_profile_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = invitation.craftsman_profile_id
    JOIN users customer_owner ON customer_owner.id = customer.owner_user_id
      AND customer_owner.account_state = 'ACTIVE'
    JOIN users provider_owner ON provider_owner.id = craftsman.owner_user_id
      AND provider_owner.account_state = 'ACTIVE'
    WHERE current.access_state = 'WRITABLE'
    ORDER BY conversation.created_at DESC, conversation.id DESC
    LIMIT 1
  `;
  if (row === undefined) {
    throw new Error("R3-020 requires a writable R3 conversation fixture.");
  }
  return row;
}

async function sendAndPublish(
  sql: Sql,
  chat: ReturnType<typeof createConversationChatRepository>,
  publisher: ReturnType<typeof createNotificationOutboxPublisher>,
  fixture: ConversationFixture,
  body: string,
): Promise<{
  readonly event: PersistedDomainEvent;
  readonly row: EventRow;
  readonly sequence: number;
}> {
  const sent = await chat.sendMessage({
    actorUserId: fixture.customerOwnerId,
    body,
    commandId: randomUUID(),
    conversationId: fixture.conversationId,
  });
  if (sent.status !== "SENT") {
    throw new Error(
      `Expected notification test message, received ${sent.status}.`,
    );
  }
  const [row] = await sql<EventRow[]>`
    SELECT event_id AS "eventId", idempotency_key AS "idempotencyKey",
      event_name AS "eventName", schema_version AS "schemaVersion",
      occurred_at AS "occurredAt", entity_type AS "entityType",
      entity_id AS "entityId", payload, command_name AS "commandName",
      correlation_id AS "correlationId"
    FROM domain_outbox_events
    WHERE event_name = 'conversation.message_created'
      AND entity_type = 'CONVERSATION'
      AND entity_id = ${fixture.conversationId}
      AND (payload ->> 'conversation_sequence')::integer = ${sent.entry.sequence}
  `;
  if (row === undefined) throw new Error("Chat notification event missing.");
  const event = toEvent(row);
  const delivery = {
    attempt: 1,
    commandName: row.commandName,
    correlationId: row.correlationId,
    event,
    leaseToken: randomUUID(),
  };
  await publisher.publish(delivery);
  await publisher.publish(delivery);
  return { event, row, sequence: sent.entry.sequence };
}

async function sendWithoutPublishing(
  chat: ReturnType<typeof createConversationChatRepository>,
  fixture: ConversationFixture,
  body: string,
): Promise<number> {
  const sent = await chat.sendMessage({
    actorUserId: fixture.customerOwnerId,
    body,
    commandId: randomUUID(),
    conversationId: fixture.conversationId,
  });
  if (sent.status !== "SENT") {
    throw new Error(`Expected muted test message, received ${sent.status}.`);
  }
  return sent.entry.sequence;
}

async function ensureUnmuted(
  chat: ReturnType<typeof createConversationChatRepository>,
  sql: Sql,
  fixture: ConversationFixture,
): Promise<void> {
  const current = await loadState(sql, fixture);
  if (!current.muted) return;
  const result = await chat.updateParticipantState({
    action: "UNMUTE",
    actorUserId: fixture.providerOwnerId,
    commandId: randomUUID(),
    conversationId: fixture.conversationId,
    expectedRevision: current.revision,
  });
  if (result.status !== "APPLIED") {
    throw new Error("Could not normalize notification fixture mute state.");
  }
}

async function loadState(
  sql: Sql,
  fixture: ConversationFixture,
): Promise<ConversationParticipantState> {
  const [row] = await sql<
    Array<{
      readonly archived: boolean;
      readonly lastReadAt: Date | null;
      readonly lastReadSequence: number;
      readonly muted: boolean;
      readonly revision: number;
    }>
  >`
    SELECT revision, last_read_sequence::integer AS "lastReadSequence",
      last_read_at AS "lastReadAt", archived, muted
    FROM current_conversation_participant_states
    WHERE conversation_id = ${fixture.conversationId}
      AND actor_user_id = ${fixture.providerOwnerId}
  `;
  return (
    row ?? {
      archived: false,
      lastReadAt: null,
      lastReadSequence: 0,
      muted: false,
      revision: 0,
    }
  );
}

async function expectEmailCount(
  sql: Sql,
  eventId: string,
  count: number,
): Promise<void> {
  const [row] = await sql<Array<{ readonly count: number }>>`
    SELECT count(delivery.id)::integer AS count
    FROM notifications notification
    JOIN notification_deliveries delivery
      ON delivery.notification_id = notification.id
      AND delivery.channel = 'EMAIL'
    WHERE notification.domain_event_id = ${eventId}
  `;
  expect(row?.count).toBe(count);
}

async function expectOutboxCollisionRejected(
  sql: Sql,
  row: EventRow,
): Promise<void> {
  await expect(sql`
    SELECT insert_exact_notification_outbox_event(
      ${row.idempotencyKey}, 'conversation.invalid_collision',
      ${row.occurredAt}, ${row.entityType}, ${row.entityId},
      ${sql.json(row.payload)}, ${row.commandName}, ${row.correlationId},
      ${row.occurredAt}
    )
  `).rejects.toThrow(/notification outbox idempotency key collision/u);
}

async function expectNotificationChannelCollisionRejected(
  outbox: ReturnType<typeof createOutboxRepository>,
  notifications: ReturnType<typeof createNotificationRepository>,
  event: PersistedDomainEvent,
): Promise<void> {
  const draft = mapDemandSideNotificationEvent(event)?.[0];
  if (draft === undefined) throw new Error("Expected chat notification draft.");
  await expect(
    outbox.transactions.run((transaction) =>
      notifications.writer.create(transaction, {
        ...draft,
        channels: ["IN_APP", "EMAIL"],
        domainEventId: event.eventId,
        eventIdempotencyKey: event.idempotencyKey,
      }),
    ),
  ).rejects.toThrow(/channel intent collision/u);
}

async function publishExistingWorkflowEvents(
  sql: Sql,
  publisher: ReturnType<typeof createNotificationOutboxPublisher>,
): Promise<void> {
  const rows = await sql<EventRow[]>`
    SELECT event_id AS "eventId", idempotency_key AS "idempotencyKey",
      event_name AS "eventName", schema_version AS "schemaVersion",
      occurred_at AS "occurredAt", entity_type AS "entityType",
      entity_id AS "entityId", payload, command_name AS "commandName",
      correlation_id AS "correlationId"
    FROM domain_outbox_events
    WHERE event_name IN (
      'job_invitation.engaged', 'job_invitation.declined',
      'job_invitation.withdrawn_by_customer',
      'job_invitation.withdrawn_by_provider', 'job_invitation.request_closed',
      'job_invitation.not_selected', 'job_request.materially_updated',
      'quote.submitted', 'quote.revised', 'quote.rejected',
      'quote.withdrawn', 'quote.expired'
    )
    ORDER BY occurred_at, event_id
  `;
  expect(
    rows.some((row) => row.eventName === "job_request.materially_updated"),
  ).toBe(true);
  const expiryRows = rows.filter((row) => row.eventName === "quote.expired");
  expect(expiryRows.length).toBeGreaterThanOrEqual(2);
  const expiryCountByQuote = new Map<string, number>();
  for (const row of expiryRows) {
    expiryCountByQuote.set(
      row.entityId,
      (expiryCountByQuote.get(row.entityId) ?? 0) + 1,
    );
  }
  for (const count of expiryCountByQuote.values()) expect(count).toBe(2);
  for (const row of rows) {
    const delivery = {
      attempt: 1,
      commandName: row.commandName,
      correlationId: row.correlationId,
      event: toEvent(row),
      leaseToken: randomUUID(),
    };
    await publisher.publish(delivery);
    await publisher.publish(delivery);
  }
}

async function expectQuoteExpiryAudiencePaths(sql: Sql): Promise<void> {
  const rows = await sql<
    Array<{
      readonly path: string;
      readonly quoteId: string;
      readonly recipientUserId: string;
    }>
  >`
    SELECT notification.deep_link_path AS path,
      notification.recipient_user_id AS "recipientUserId",
      event.entity_id AS "quoteId"
    FROM notifications notification
    JOIN domain_outbox_events event
      ON event.event_id = notification.domain_event_id
    WHERE event.event_name = 'quote.expired'
    ORDER BY notification.recipient_user_id
  `;
  expect(rows.length).toBeGreaterThanOrEqual(2);
  const recipientsByQuote = new Map<string, Set<string>>();
  for (const row of rows) {
    expect(row.path).toMatch(/^\/konverzacie\/pozvanka\/[0-9a-f-]{36}$/u);
    const recipients = recipientsByQuote.get(row.quoteId) ?? new Set<string>();
    recipients.add(row.recipientUserId);
    recipientsByQuote.set(row.quoteId, recipients);
  }
  for (const recipients of recipientsByQuote.values())
    expect(recipients.size).toBe(2);
}

async function expectAuthoritativeRecipients(sql: Sql): Promise<void> {
  const [invitation] = await sql<Array<{ readonly bad: number }>>`
    SELECT count(*) FILTER (
      WHERE event.payload ->> 'recipient_user_id' IS DISTINCT FROM CASE
        WHEN event.event_name IN (
          'job_invitation.engaged', 'job_invitation.declined',
          'job_invitation.withdrawn_by_provider'
        ) THEN customer.owner_user_id::text
        ELSE craftsman.owner_user_id::text
      END
    )::integer AS bad
    FROM domain_outbox_events event
    JOIN job_invitations identity
      ON identity.id::text = event.entity_id
    JOIN customer_profiles customer
      ON customer.id = identity.customer_profile_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = identity.craftsman_profile_id
    WHERE event.event_name IN (
      'job_invitation.engaged', 'job_invitation.declined',
      'job_invitation.withdrawn_by_customer',
      'job_invitation.withdrawn_by_provider', 'job_invitation.request_closed',
      'job_invitation.not_selected'
    )
  `;
  expect(invitation?.bad).toBe(0);

  const [quote] = await sql<Array<{ readonly bad: number }>>`
    SELECT count(*) FILTER (
      WHERE event.payload ->> 'recipient_user_id' IS DISTINCT FROM CASE
        WHEN event.payload ->> 'recipient_audience' = 'CUSTOMER'
          THEN customer.owner_user_id::text
        WHEN event.payload ->> 'recipient_audience' = 'PROVIDER'
          THEN craftsman.owner_user_id::text
        ELSE NULL
      END
    )::integer AS bad
    FROM domain_outbox_events event
    JOIN quotes quote ON quote.id::text = event.entity_id
    JOIN job_invitations invitation ON invitation.id = quote.invitation_id
    JOIN customer_profiles customer
      ON customer.id = invitation.customer_profile_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = invitation.craftsman_profile_id
    WHERE event.event_name IN (
      'quote.submitted', 'quote.revised', 'quote.rejected',
      'quote.withdrawn', 'quote.expired'
    )
  `;
  expect(quote?.bad).toBe(0);
}

async function expectMaterialFanoutAndMinorSilence(sql: Sql): Promise<void> {
  const [minor] = await sql<Array<{ readonly bad: number }>>`
    SELECT count(*)::integer AS bad
    FROM job_request_active_edit_commands command
    JOIN domain_outbox_events event
      ON event.correlation_id = command.command_id::text
      AND event.event_name = 'job_request.materially_updated'
    WHERE NOT command.material_change
  `;
  expect(minor?.bad).toBe(0);

  const [fanout] = await sql<Array<{ readonly missing: number }>>`
    WITH expected AS (
      SELECT revision.job_request_id, revision.content_revision,
        revision.visible_version,
        invitation.id AS invitation_id,
        profile.owner_user_id AS recipient_user_id
      FROM job_request_active_content_revisions revision
      JOIN job_invitations invitation
        ON invitation.job_request_id = revision.job_request_id
      JOIN craftsman_profiles profile
        ON profile.id = invitation.craftsman_profile_id
      JOIN LATERAL (
        SELECT state.state
        FROM job_invitation_revisions state
        WHERE state.invitation_id = invitation.id
          AND state.changed_at <= revision.changed_at
        ORDER BY state.revision DESC LIMIT 1
      ) current_at_effect ON current_at_effect.state IN ('PENDING', 'ENGAGED')
      WHERE revision.material_change AND revision.command_id IS NOT NULL
    )
    SELECT count(*) FILTER (
      WHERE event.event_id IS NULL OR entitlement.invitation_id IS NULL
    )::integer AS missing
    FROM expected
    LEFT JOIN domain_outbox_events event
      ON event.idempotency_key = 'job-request:'
        || expected.job_request_id::text || ':visible:'
        || expected.visible_version::text || ':invitation:'
        || expected.invitation_id::text
      AND event.event_name = 'job_request.materially_updated'
      AND event.payload ->> 'recipient_user_id'
        = expected.recipient_user_id::text
    LEFT JOIN job_request_material_update_entitlements entitlement
      ON entitlement.job_request_id = expected.job_request_id
      AND entitlement.request_content_revision = expected.content_revision
      AND entitlement.invitation_id = expected.invitation_id
      AND entitlement.recipient_user_id = expected.recipient_user_id
  `;
  expect(fanout?.missing).toBe(0);
}

async function expectPrivacyMinimalPersistence(sql: Sql): Promise<void> {
  const [row] = await sql<Array<{ readonly leaks: number }>>`
    SELECT count(*) FILTER (
      WHERE payload ?| ARRAY[
        'body', 'description', 'price', 'amount', 'reason', 'email', 'phone',
        'address', 'storage_key', 'document_id', 'competitor_id'
      ]
    )::integer AS leaks
    FROM domain_outbox_events
    WHERE event_name IN (
      'conversation.message_created', 'job_request.materially_updated',
      'quote.submitted', 'quote.revised', 'quote.rejected',
      'quote.withdrawn', 'quote.expired'
    )
  `;
  expect(row?.leaks).toBe(0);
}

async function expectOutsiderParticipantCommandDenied(
  sql: Sql,
  chat: ReturnType<typeof createConversationChatRepository>,
  fixture: ConversationFixture,
): Promise<void> {
  const outsider = randomUUID() as UserId;
  await sql`INSERT INTO users (id) VALUES (${outsider})`;
  await expect(
    chat.updateParticipantState({
      action: "MUTE",
      actorUserId: outsider,
      commandId: randomUUID(),
      conversationId: fixture.conversationId,
      expectedRevision: 0,
    }),
  ).resolves.toEqual({ status: "NOT_FOUND" });
  await expect(sql`
    INSERT INTO conversation_participant_state_commands (
      command_id, conversation_id, actor_user_id, action,
      expected_revision, resulting_revision, read_through_sequence,
      payload_fingerprint, created_at
    ) VALUES (
      ${randomUUID()}, ${fixture.conversationId}, ${outsider}, 'MUTE',
      0, 1, NULL, ${"0".repeat(64)}, clock_timestamp()
    )
  `).rejects.toThrow(/active participant conversation required/u);
}

async function expectLegacyReminderReplayAndRollback(sql: Sql): Promise<void> {
  const [legacy] = await sql<EventRow[]>`
    SELECT event_id AS "eventId", idempotency_key AS "idempotencyKey",
      event_name AS "eventName", schema_version AS "schemaVersion",
      occurred_at AS "occurredAt", entity_type AS "entityType",
      entity_id AS "entityId", payload, command_name AS "commandName",
      correlation_id AS "correlationId"
    FROM domain_outbox_events
    WHERE event_name = 'job_invitation.expiry_reminder'
    ORDER BY occurred_at LIMIT 1
  `;
  if (legacy === undefined) throw new Error("Reminder fixture missing.");
  const [replay] = await sql<Array<{ readonly inserted: boolean }>>`
    SELECT insert_exact_invitation_reminder_outbox_event(
      ${legacy.idempotencyKey}, clock_timestamp(), ${legacy.entityId},
      ${sql.json(legacy.payload)}, ${legacy.commandName},
      ${legacy.correlationId}, clock_timestamp()
    ) AS inserted
  `;
  expect(replay?.inserted).toBe(false);

  const rollbackKey = `notification-rollback:${randomUUID()}`;
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        SELECT insert_exact_notification_outbox_event(
          ${rollbackKey}, 'conversation.message_created', clock_timestamp(),
          'CONVERSATION', ${randomUUID()},
          ${transaction.json({
            conversation_sequence: 1,
            invitation_id: randomUUID(),
            recipient_user_id: randomUUID(),
          })},
          'integration.rollback', ${randomUUID()}, clock_timestamp()
        )
      `;
      throw new Error("ROLLBACK_NOTIFICATION_PROBE");
    }),
  ).rejects.toThrow("ROLLBACK_NOTIFICATION_PROBE");
  const [persisted] = await sql<Array<{ readonly count: number }>>`
    SELECT count(*)::integer AS count FROM domain_outbox_events
    WHERE idempotency_key = ${rollbackKey}
  `;
  expect(persisted?.count).toBe(0);
}

async function expectMaterialEntitlementCannotBeForged(
  sql: Sql,
  fixture: ConversationFixture,
): Promise<void> {
  const [version] = await sql<Array<{ readonly contentRevision: number }>>`
    SELECT max(content_revision)::integer AS "contentRevision"
    FROM job_request_active_content_revisions
    WHERE job_request_id = ${fixture.jobRequestId}
  `;
  const contentRevision = version?.contentRevision;
  if (
    typeof contentRevision !== "number" ||
    !Number.isSafeInteger(contentRevision)
  ) {
    throw new Error("Material entitlement revision fixture is missing.");
  }
  await expect(sql`
    INSERT INTO job_request_material_update_entitlements (
      invitation_id, job_request_id, request_content_revision,
      recipient_user_id, request_visible_version, created_at
    ) VALUES (
      ${fixture.invitationId}, ${fixture.jobRequestId},
      ${contentRevision}, ${fixture.providerOwnerId}, 1,
      clock_timestamp()
    )
  `).rejects.toThrow(/material update entitlement is DB-derived/u);
}

async function expectMessageVersusMuteLockOrder(
  sql: Sql,
  fixture: ConversationFixture,
): Promise<void> {
  await ensureUnmuted(createConversationChatRepository(sql), sql, fixture);
  const state = await loadState(sql, fixture);
  const gateReady = deferred<void>();
  const releaseGate = deferred<void>();
  const appPid = deferred<number>();
  const rawPid = deferred<number>();

  const gate = sql.begin(async (transaction) => {
    await transaction`
      SELECT id FROM job_invitations
      WHERE id = ${fixture.invitationId}
      FOR UPDATE
    `;
    gateReady.resolve();
    await releaseGate.promise;
  });
  await gateReady.promise;

  const appChat = createConversationChatRepository(
    instrumentBegin(sql, appPid.resolve),
  );
  const appSend = appChat.sendMessage({
    actorUserId: fixture.customerOwnerId,
    body: "Správa počas deterministického overenia poradia zámkov.",
    commandId: randomUUID(),
    conversationId: fixture.conversationId,
  });
  await waitUntilLockBlocked(sql, await appPid.promise);

  const rawCommandId = randomUUID();
  const rawMute = sql.begin(async (transaction) => {
    rawPid.resolve(await backendPid(transaction));
    await transaction`
      INSERT INTO conversation_participant_state_commands (
        command_id, conversation_id, actor_user_id, action,
        expected_revision, resulting_revision, read_through_sequence,
        payload_fingerprint, created_at
      ) VALUES (
        ${rawCommandId}, ${fixture.conversationId}, ${fixture.providerOwnerId},
        'MUTE', ${state.revision}, ${state.revision + 1}, NULL,
        ${stateCommandFingerprint({
          action: "MUTE",
          actorUserId: fixture.providerOwnerId,
          conversationId: fixture.conversationId,
          expectedRevision: state.revision,
        })}, clock_timestamp()
      )
    `;
    await transaction`
      INSERT INTO conversation_participant_state_revisions (
        conversation_id, actor_user_id, revision, command_id,
        last_read_sequence, last_read_at, archived, muted, changed_at
      ) VALUES (
        ${fixture.conversationId}, ${fixture.providerOwnerId},
        ${state.revision + 1}, ${rawCommandId}, 0, NULL, false, false,
        clock_timestamp()
      )
    `;
  });
  await waitUntilLockBlocked(sql, await rawPid.promise);
  releaseGate.resolve();

  const [sent] = await Promise.all([appSend, rawMute, gate]);
  expect(sent.status).toBe("SENT");
  expect((await loadState(sql, fixture)).muted).toBe(true);
  await ensureUnmuted(createConversationChatRepository(sql), sql, fixture);

  const reverseState = await loadState(sql, fixture);
  const reverseGateReady = deferred<void>();
  const releaseReverseGate = deferred<void>();
  const reverseRawPid = deferred<number>();
  const reverseAppPid = deferred<number>();
  const reverseGate = sql.begin(async (transaction) => {
    await transaction`
      SELECT id FROM conversations
      WHERE id = ${fixture.conversationId}
      FOR UPDATE
    `;
    reverseGateReady.resolve();
    await releaseReverseGate.promise;
  });
  await reverseGateReady.promise;

  const reverseCommandId = randomUUID();
  const reverseRawMute = sql.begin(async (transaction) => {
    reverseRawPid.resolve(await backendPid(transaction));
    await transaction`
      INSERT INTO conversation_participant_state_commands (
        command_id, conversation_id, actor_user_id, action,
        expected_revision, resulting_revision, read_through_sequence,
        payload_fingerprint, created_at
      ) VALUES (
        ${reverseCommandId}, ${fixture.conversationId},
        ${fixture.providerOwnerId}, 'MUTE', ${reverseState.revision},
        ${reverseState.revision + 1}, NULL,
        ${stateCommandFingerprint({
          action: "MUTE",
          actorUserId: fixture.providerOwnerId,
          conversationId: fixture.conversationId,
          expectedRevision: reverseState.revision,
        })}, clock_timestamp()
      )
    `;
    await transaction`
      INSERT INTO conversation_participant_state_revisions (
        conversation_id, actor_user_id, revision, command_id,
        last_read_sequence, last_read_at, archived, muted, changed_at
      ) VALUES (
        ${fixture.conversationId}, ${fixture.providerOwnerId},
        ${reverseState.revision + 1}, ${reverseCommandId}, 0, NULL, false,
        false, clock_timestamp()
      )
    `;
  });
  await waitUntilLockBlocked(sql, await reverseRawPid.promise);

  const reverseAppChat = createConversationChatRepository(
    instrumentBegin(sql, reverseAppPid.resolve),
  );
  const reverseSend = reverseAppChat.sendMessage({
    actorUserId: fixture.customerOwnerId,
    body: "Správa pri opačnom deterministickom poradí zámkov.",
    commandId: randomUUID(),
    conversationId: fixture.conversationId,
  });
  await waitUntilLockBlocked(sql, await reverseAppPid.promise);
  releaseReverseGate.resolve();

  const [reverseSent] = await Promise.all([
    reverseSend,
    reverseRawMute,
    reverseGate,
  ]);
  expect(reverseSent.status).toBe("SENT");
  if (reverseSent.status !== "SENT") {
    throw new Error("Reverse-order notification message was not stored.");
  }
  const [mutedEvent] = await sql<Array<{ readonly count: number }>>`
    SELECT count(*)::integer AS count FROM domain_outbox_events
    WHERE event_name = 'conversation.message_created'
      AND entity_id = ${fixture.conversationId}
      AND (payload ->> 'conversation_sequence')::integer
        = ${reverseSent.entry.sequence}
  `;
  expect(mutedEvent?.count).toBe(0);
  await ensureUnmuted(createConversationChatRepository(sql), sql, fixture);
}

async function expectMaterialEditVersusCancellationLockOrder(
  sql: Sql,
  fixture: ConversationFixture,
): Promise<void> {
  const reader = createJobRequestVersionRepository(sql);
  const [lifecycle] = await sql<
    Array<{ readonly revision: number; readonly state: string }>
  >`
    SELECT revision, state::text AS state
    FROM current_job_request_operational_status
    WHERE job_request_id = ${fixture.jobRequestId}
  `;
  if (lifecycle?.state !== "ACTIVE") {
    throw new Error("Cancellation lock-order request must be ACTIVE.");
  }

  const runOrdering = async (
    order: "EDIT_FIRST" | "CANCEL_FIRST",
  ): Promise<void> => {
    const [eligibleRecipients] = await sql<Array<{ readonly count: number }>>`
      SELECT count(*)::integer AS count
      FROM current_job_invitations invitation
      WHERE invitation.job_request_id = ${fixture.jobRequestId}
        AND invitation.state IN ('PENDING', 'ENGAGED')
    `;
    if ((eligibleRecipients?.count ?? 0) < 1) {
      throw new Error(
        "Cancellation lock-order request has no eligible recipients.",
      );
    }
    const current = await reader.readActiveOwned({
      actorUserId: fixture.customerOwnerId,
      jobRequestId: fixture.jobRequestId,
    });
    if (current.status !== "OK") {
      throw new Error("Cancellation lock-order request is unavailable.");
    }
    const core = current.snapshot.sections.find(
      (section) => section.key === "request.core",
    )?.payload as JobRequestCoreContent | undefined;
    if (core === undefined) {
      throw new Error("Cancellation lock-order request core is missing.");
    }

    const gateReady = deferred<void>();
    const releaseGate = deferred<void>();
    const editPid = deferred<number>();
    const cancelPid = deferred<number>();
    const gate = sql.begin(async (transaction) => {
      await transaction`
        SELECT id FROM job_requests
        WHERE id = ${fixture.jobRequestId}
        FOR UPDATE
      `;
      gateReady.resolve();
      await releaseGate.promise;
    });
    await gateReady.promise;

    const editCommandId = randomUUID();
    const startEdit = () =>
      createJobRequestVersionRepository(
        instrumentBegin(sql, editPid.resolve),
      ).reviseActiveOwned({
        actorUserId: fixture.customerOwnerId,
        commandId: editCommandId,
        expectedContentRevision: current.snapshot.version.contentRevision,
        jobRequestId: fixture.jobRequestId,
        section: normalizeJobRequestContentSection({
          key: "request.core",
          payload: {
            ...core,
            description:
              order === "EDIT_FIRST"
                ? "Materiálna zmena pred rollbacknutým zrušením dopytu."
                : "Materiálna zmena po rollbacknutom zrušení dopytu.",
          },
          schemaVersion: 1,
        }),
      });
    const cancellation = () =>
      createJobRequestLifecycleRepository(
        instrumentRollbackBegin(
          sql,
          cancelPid.resolve,
          `ROLLBACK_${order}_CANCELLATION`,
        ),
      ).cancelOwned({
        actorUserId: fixture.customerOwnerId,
        commandId: randomUUID(),
        expectedRevision: lifecycle.revision,
        jobRequestId: fixture.jobRequestId,
        reason: "NO_LONGER_NEEDED",
      });

    let edit: ReturnType<typeof startEdit>;
    let cancel: ReturnType<typeof cancellation>;
    if (order === "EDIT_FIRST") {
      edit = startEdit();
      await waitUntilLockBlocked(sql, await editPid.promise);
      cancel = cancellation();
      await waitUntilLockBlocked(sql, await cancelPid.promise);
    } else {
      cancel = cancellation();
      await waitUntilLockBlocked(sql, await cancelPid.promise);
      edit = startEdit();
      await waitUntilLockBlocked(sql, await editPid.promise);
    }
    releaseGate.resolve();

    await expect(cancel).rejects.toThrow(`ROLLBACK_${order}_CANCELLATION`);
    const [edited] = await Promise.all([edit, gate]);
    expect(edited.status).toBe("APPLIED");
    await expectMaterialEventCount(
      sql,
      editCommandId,
      eligibleRecipients?.count ?? 0,
    );
  };

  await runOrdering("EDIT_FIRST");
  await runOrdering("CANCEL_FIRST");
}

async function expectMaterialEditVersusInvitationLockOrder(
  sql: Sql,
  fixture: ConversationFixture,
): Promise<void> {
  const reader = createJobRequestVersionRepository(sql);
  const current = await reader.readActiveOwned({
    actorUserId: fixture.customerOwnerId,
    jobRequestId: fixture.jobRequestId,
  });
  if (current.status !== "OK") {
    throw new Error("Material lock-order request fixture is unavailable.");
  }
  const core = current.snapshot.sections.find(
    (section) => section.key === "request.core",
  )?.payload as JobRequestCoreContent | undefined;
  if (core === undefined) throw new Error("Request core fixture missing.");

  const [invitation] = await sql<
    Array<{ readonly revision: number; readonly state: string }>
  >`
    SELECT revision, state::text AS state
    FROM current_job_invitations
    WHERE id = ${fixture.invitationId}
  `;
  if (invitation?.state !== "ENGAGED") {
    throw new Error("Material lock-order invitation must be ENGAGED.");
  }
  const [eligibleRecipients] = await sql<Array<{ readonly count: number }>>`
    SELECT count(*)::integer AS count
    FROM current_job_invitations candidate
    WHERE candidate.job_request_id = ${fixture.jobRequestId}
      AND candidate.state IN ('PENDING', 'ENGAGED')
  `;
  if ((eligibleRecipients?.count ?? 0) < 1) {
    throw new Error("Material lock-order request has no eligible recipients.");
  }

  const gateReady = deferred<void>();
  const releaseGate = deferred<void>();
  const appPid = deferred<number>();
  const rawPid = deferred<number>();
  const gate = sql.begin(async (transaction) => {
    await transaction`
      SELECT id FROM job_requests
      WHERE id = ${fixture.jobRequestId}
      FOR UPDATE
    `;
    gateReady.resolve();
    await releaseGate.promise;
  });
  await gateReady.promise;

  const appVersions = createJobRequestVersionRepository(
    instrumentBegin(sql, appPid.resolve),
  );
  const materialCommandId = randomUUID();
  const materialEdit = appVersions.reviseActiveOwned({
    actorUserId: fixture.customerOwnerId,
    commandId: materialCommandId,
    expectedContentRevision: current.snapshot.version.contentRevision,
    jobRequestId: fixture.jobRequestId,
    section: normalizeJobRequestContentSection({
      key: "request.core",
      payload: {
        ...core,
        description:
          "Deterministická zmena rozsahu pre overenie poradia zámkov.",
      },
      schemaVersion: 1,
    }),
  });
  await waitUntilLockBlocked(sql, await appPid.promise);

  const rawCommandId = randomUUID();
  const rawTransition = sql.begin(async (transaction) => {
    rawPid.resolve(await backendPid(transaction));
    await transaction`
      INSERT INTO job_invitation_commands (
        command_id, invitation_id, actor_user_id, command_kind,
        expected_revision, resulting_revision, target_state, system_initiated,
        decline_reason, decline_note, payload_fingerprint
      ) VALUES (
        ${rawCommandId}, ${fixture.invitationId}, ${fixture.customerOwnerId},
        'CUSTOMER_STOP', ${invitation.revision}, ${invitation.revision + 1},
        'NOT_SELECTED', false, NULL, NULL, ${"0".repeat(64)}
      )
    `;
    await transaction`
      INSERT INTO job_invitation_revisions (
        invitation_id, revision, command_id, state, changed_at, sent_at,
        expires_at, engaged_at, decline_reason, decline_note
      ) VALUES (
        ${fixture.invitationId}, ${invitation.revision + 1}, ${rawCommandId},
        'NOT_SELECTED', clock_timestamp(), clock_timestamp(),
        clock_timestamp(), NULL, NULL, NULL
      )
    `;
    throw new Error("ROLLBACK_APP_FIRST_INVITATION_TRANSITION");
  });
  await waitUntilLockBlocked(sql, await rawPid.promise);
  releaseGate.resolve();

  await expect(rawTransition).rejects.toThrow(
    "ROLLBACK_APP_FIRST_INVITATION_TRANSITION",
  );
  const [revised] = await Promise.all([materialEdit, gate]);
  expect(revised.status).toBe("APPLIED");
  const [afterRollback] = await sql<Array<{ readonly state: string }>>`
    SELECT state::text AS state FROM current_job_invitations
    WHERE id = ${fixture.invitationId}
  `;
  expect(afterRollback?.state).toBe("ENGAGED");
  await expectMaterialEventCount(
    sql,
    materialCommandId,
    eligibleRecipients?.count ?? 0,
  );

  const reverseCurrent = await reader.readActiveOwned({
    actorUserId: fixture.customerOwnerId,
    jobRequestId: fixture.jobRequestId,
  });
  if (reverseCurrent.status !== "OK") {
    throw new Error(
      "Reverse material lock-order request fixture is unavailable.",
    );
  }
  const reverseCore = reverseCurrent.snapshot.sections.find(
    (section) => section.key === "request.core",
  )?.payload as JobRequestCoreContent | undefined;
  if (reverseCore === undefined) {
    throw new Error("Reverse request core fixture missing.");
  }

  const reverseGateReady = deferred<void>();
  const releaseReverseGate = deferred<void>();
  const reverseRawPid = deferred<number>();
  const reverseAppPid = deferred<number>();
  const reverseGate = sql.begin(async (transaction) => {
    await transaction`
      SELECT id FROM job_invitations
      WHERE id = ${fixture.invitationId}
      FOR UPDATE
    `;
    reverseGateReady.resolve();
    await releaseReverseGate.promise;
  });
  await reverseGateReady.promise;

  const reverseRawCommandId = randomUUID();
  const reverseRawTransition = sql.begin(async (transaction) => {
    reverseRawPid.resolve(await backendPid(transaction));
    await transaction`
      INSERT INTO job_invitation_commands (
        command_id, invitation_id, actor_user_id, command_kind,
        expected_revision, resulting_revision, target_state, system_initiated,
        decline_reason, decline_note, payload_fingerprint
      ) VALUES (
        ${reverseRawCommandId}, ${fixture.invitationId},
        ${fixture.customerOwnerId}, 'CUSTOMER_STOP', ${invitation.revision},
        ${invitation.revision + 1}, 'NOT_SELECTED', false, NULL, NULL,
        ${"0".repeat(64)}
      )
    `;
    await transaction`
      INSERT INTO job_invitation_revisions (
        invitation_id, revision, command_id, state, changed_at, sent_at,
        expires_at, engaged_at, decline_reason, decline_note
      ) VALUES (
        ${fixture.invitationId}, ${invitation.revision + 1},
        ${reverseRawCommandId}, 'NOT_SELECTED', clock_timestamp(),
        clock_timestamp(), clock_timestamp(), NULL, NULL, NULL
      )
    `;
  });
  await waitUntilLockBlocked(sql, await reverseRawPid.promise);

  const reverseAppVersions = createJobRequestVersionRepository(
    instrumentBegin(sql, reverseAppPid.resolve),
  );
  const reverseMaterialCommandId = randomUUID();
  const reverseMaterialEdit = reverseAppVersions.reviseActiveOwned({
    actorUserId: fixture.customerOwnerId,
    commandId: reverseMaterialCommandId,
    expectedContentRevision: reverseCurrent.snapshot.version.contentRevision,
    jobRequestId: fixture.jobRequestId,
    section: normalizeJobRequestContentSection({
      key: "request.core",
      payload: {
        ...reverseCore,
        description:
          "Opačná deterministická zmena rozsahu pre overenie poradia zámkov.",
      },
      schemaVersion: 1,
    }),
  });
  await waitUntilLockBlocked(sql, await reverseAppPid.promise);
  releaseReverseGate.resolve();

  const [reverseRevised] = await Promise.all([
    reverseMaterialEdit,
    reverseRawTransition,
    reverseGate,
  ]);
  expect(reverseRevised.status).toBe("APPLIED");
  const [after] = await sql<Array<{ readonly state: string }>>`
    SELECT state::text AS state FROM current_job_invitations
    WHERE id = ${fixture.invitationId}
  `;
  expect(after?.state).toBe("NOT_SELECTED");
  await expectMaterialEventCount(
    sql,
    reverseMaterialCommandId,
    (eligibleRecipients?.count ?? 0) - 1,
  );
  await createReplacementInvitationFixture(sql, fixture);
  if (revised.status !== "APPLIED" || reverseRevised.status !== "APPLIED") {
    throw new Error(
      "Material authorization race did not append exact versions.",
    );
  }
  const invitations = createJobInvitationRepository(sql);
  await expect(
    invitations.readOwned({
      actorUserId: fixture.providerOwnerId,
      invitationId: fixture.invitationId,
      requestContentRevision: revised.version.contentRevision,
    }),
  ).resolves.not.toBeNull();
  await expect(
    invitations.readOwned({
      actorUserId: fixture.providerOwnerId,
      invitationId: fixture.invitationId,
      requestContentRevision: reverseRevised.version.contentRevision,
    }),
  ).resolves.toBeNull();
}

async function createReplacementInvitationFixture(
  sql: Sql,
  fixture: ConversationFixture,
): Promise<void> {
  const [identity] = await sql<
    Array<{ readonly craftsmanProfileId: CraftsmanProfileId }>
  >`
    SELECT craftsman_profile_id AS "craftsmanProfileId"
    FROM job_invitations
    WHERE id = ${fixture.invitationId}
  `;
  if (identity === undefined) {
    throw new Error("Invitation identity is missing.");
  }
  const duplicate = await createJobRequestLifecycleRepository(
    sql,
  ).duplicateOwned({
    actorUserId: fixture.customerOwnerId,
    commandId: randomUUID(),
    sourceJobRequestId: fixture.jobRequestId,
  });
  if (!("jobRequestId" in duplicate)) {
    throw new Error("Could not create downstream lifecycle fixture.");
  }
  const activated = await createJobRequestRepository(sql).activateOwned({
    actorUserId: fixture.customerOwnerId,
    commandId: randomUUID(),
    expectedRevision: duplicate.revision,
    jobRequestId: duplicate.jobRequestId,
  });
  if (activated.status !== "APPLIED") {
    throw new Error(
      `Could not activate lifecycle fixture: ${activated.status}.`,
    );
  }
  const invitation = await createJobInvitationRepository(sql).sendOwned({
    actorUserId: fixture.customerOwnerId,
    commandId: randomUUID(),
    craftsmanProfileId: identity.craftsmanProfileId,
    jobRequestId: duplicate.jobRequestId,
  });
  if (invitation.status !== "APPLIED") {
    throw new Error(
      `Could not invite lifecycle fixture: ${invitation.status}.`,
    );
  }
}

async function expectMaterialEventCount(
  sql: Sql,
  commandId: string,
  count: number,
): Promise<void> {
  const [row] = await sql<Array<{ readonly count: number }>>`
    SELECT count(*)::integer AS count
    FROM domain_outbox_events
    WHERE event_name = 'job_request.materially_updated'
      AND correlation_id = ${commandId}
  `;
  expect(row?.count).toBe(count);
}

function instrumentBegin(sql: Sql, onPid: (pid: number) => void): Sql {
  return {
    begin: (callback: (transaction: TransactionSql) => Promise<unknown>) =>
      sql.begin(async (transaction) => {
        onPid(await backendPid(transaction));
        return callback(transaction);
      }),
  } as unknown as Sql;
}

function instrumentRollbackBegin(
  sql: Sql,
  onPid: (pid: number) => void,
  marker: string,
): Sql {
  return {
    begin: (callback: (transaction: TransactionSql) => Promise<unknown>) =>
      sql.begin(async (transaction) => {
        onPid(await backendPid(transaction));
        await callback(transaction);
        throw new Error(marker);
      }),
  } as unknown as Sql;
}

async function backendPid(transaction: TransactionSql): Promise<number> {
  const [row] = await transaction<Array<{ readonly pid: number }>>`
    SELECT pg_backend_pid()::integer AS pid
  `;
  if (row === undefined) throw new Error("Could not resolve backend pid.");
  return row.pid;
}

async function waitUntilLockBlocked(sql: Sql, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await sql<Array<{ readonly waitEventType: string | null }>>`
      SELECT wait_event_type AS "waitEventType"
      FROM pg_stat_activity WHERE pid = ${pid}
    `;
    if (row?.waitEventType === "Lock") return;
    await sql`SELECT pg_sleep(0.01)`;
  }
  throw new Error(`Backend ${pid} did not reach the expected lock barrier.`);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function stateCommandFingerprint(input: {
  readonly action: "MUTE";
  readonly actorUserId: UserId;
  readonly conversationId: ConversationId;
  readonly expectedRevision: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        action: input.action,
        actorUserId: input.actorUserId,
        conversationId: input.conversationId,
        expectedRevision: input.expectedRevision,
        readThroughSequence: null,
      }),
    )
    .digest("hex");
}

function toEvent(row: EventRow): PersistedDomainEvent {
  return Object.freeze({
    entity: Object.freeze({ id: row.entityId, type: row.entityType }),
    eventId: row.eventId,
    idempotencyKey: row.idempotencyKey,
    name: row.eventName,
    occurredAt: row.occurredAt,
    payload: Object.freeze(row.payload),
    schemaVersion: row.schemaVersion,
  });
}

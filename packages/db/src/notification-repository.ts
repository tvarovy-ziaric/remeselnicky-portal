import type {
  ClaimEmailDeliveryOptions,
  CreateNotificationInput,
  EmailDelivery,
  EmailDeliveryStore,
  NotificationRecord,
  NotificationWriteStore,
} from "@portal/notifications";
import { validateNotificationDraft } from "@portal/notifications";
import type { Sql } from "postgres";

import type { OutboxDatabaseTransaction } from "./outbox-repository.js";

export interface NotificationListOptions {
  readonly filter: "ALL" | "UNREAD";
  readonly limit: number;
  readonly recipientUserId: string;
}

export interface NotificationDeliverySnapshot {
  readonly emailBacklog: number;
  readonly emailOldestBacklogAgeMs: number | null;
  readonly emailProcessing: number;
  readonly emailQueued: number;
  readonly emailTerminalFailed: number;
}

export interface NotificationRepository extends EmailDeliveryStore {
  readonly writer: NotificationWriteStore<OutboxDatabaseTransaction>;
  archive(notificationId: string, recipientUserId: string): Promise<boolean>;
  list(
    options: NotificationListOptions,
  ): Promise<readonly NotificationRecord[]>;
  markAllRead(recipientUserId: string): Promise<number>;
  markRead(notificationId: string, recipientUserId: string): Promise<boolean>;
  snapshot(): Promise<NotificationDeliverySnapshot>;
}

interface NotificationRow {
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly deepLinkPath: string;
  readonly domainEventId: string;
  readonly entityId: string;
  readonly entityRevision: number | null;
  readonly entityType: string;
  readonly eventIdempotencyKey: string;
  readonly id: string;
  readonly payload: NotificationRecord["payload"];
  readonly priority: NotificationRecord["priority"];
  readonly readAt: Date | null;
  readonly recipientUserId: string;
  readonly type: string;
}

interface EmailDeliveryRow {
  readonly attempt: number;
  readonly deepLinkPath: string;
  readonly deliveryId: string;
  readonly entityId: string;
  readonly entityRevision: number | null;
  readonly entityType: string;
  readonly idempotencyKey: string;
  readonly leaseToken: string;
  readonly notificationId: string;
  readonly notificationType: string;
  readonly priority: EmailDelivery["priority"];
  readonly recipientUserId: string;
}

interface SnapshotRow {
  readonly emailBacklog: number;
  readonly emailOldestBacklogAgeMs: number | null;
  readonly emailProcessing: number;
  readonly emailQueued: number;
  readonly emailTerminalFailed: number;
}

interface CountRow {
  readonly count: number;
}

interface IdentifierRow {
  readonly id: string;
}

interface DeliveryChannelSetRow {
  readonly emailKey: string | null;
  readonly pushKey: string | null;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const eventKeyPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const errorCodePattern = /^[A-Z][A-Z0-9_.-]{0,63}$/u;
const providerReferencePattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/u;

export function createNotificationRepository(sql: Sql): NotificationRepository {
  const writer: NotificationWriteStore<OutboxDatabaseTransaction> =
    Object.freeze({
      async create(
        transaction: OutboxDatabaseTransaction,
        input: CreateNotificationInput,
      ): Promise<NotificationRecord> {
        validateCreateInput(input);
        const [created] = await transaction<NotificationRow[]>`
          INSERT INTO notifications (
            recipient_user_id,
            type,
            domain_event_id,
            event_idempotency_key,
            entity_type,
            entity_id,
            entity_revision,
            deep_link_path,
            priority,
            payload
          ) VALUES (
            ${input.recipientUserId},
            ${input.type},
            ${input.domainEventId},
            ${input.eventIdempotencyKey},
            ${input.context.entityType},
            ${input.context.entityId},
            ${input.context.entityRevision ?? null},
            ${input.context.path},
            ${input.priority},
            ${transaction.json(input.payload)}
          )
          ON CONFLICT (domain_event_id, recipient_user_id, type) DO NOTHING
          RETURNING
            id,
            recipient_user_id AS "recipientUserId",
            type,
            domain_event_id AS "domainEventId",
            event_idempotency_key AS "eventIdempotencyKey",
            entity_type AS "entityType",
            entity_id AS "entityId",
            entity_revision AS "entityRevision",
            deep_link_path AS "deepLinkPath",
            priority,
            payload,
            created_at AS "createdAt",
            read_at AS "readAt",
            archived_at AS "archivedAt"
        `;

        let notification = created;
        const replay = notification === undefined;
        if (notification === undefined) {
          [notification] = await transaction<NotificationRow[]>`
            SELECT
              id,
              recipient_user_id AS "recipientUserId",
              type,
              domain_event_id AS "domainEventId",
              event_idempotency_key AS "eventIdempotencyKey",
              entity_type AS "entityType",
              entity_id AS "entityId",
              entity_revision AS "entityRevision",
              deep_link_path AS "deepLinkPath",
              priority,
              payload,
              created_at AS "createdAt",
              read_at AS "readAt",
              archived_at AS "archivedAt"
            FROM notifications
            WHERE domain_event_id = ${input.domainEventId}
              AND recipient_user_id = ${input.recipientUserId}
              AND type = ${input.type}
              AND event_idempotency_key = ${input.eventIdempotencyKey}
              AND entity_type = ${input.context.entityType}
              AND entity_id = ${input.context.entityId}
              AND entity_revision IS NOT DISTINCT FROM ${input.context.entityRevision ?? null}
              AND deep_link_path = ${input.context.path}
              AND priority = ${input.priority}
              AND payload = ${transaction.json(input.payload)}
          `;
        }
        if (notification === undefined) {
          throw new Error("Notification idempotency intent collision.");
        }
        if (replay) {
          const [existingChannels] = await transaction<DeliveryChannelSetRow[]>`
            SELECT
              max(delivery.idempotency_key) FILTER (
                WHERE delivery.channel = 'EMAIL'
              ) AS "emailKey",
              max(delivery.idempotency_key) FILTER (
                WHERE delivery.channel = 'PUSH'
              ) AS "pushKey"
            FROM notification_deliveries delivery
            WHERE delivery.notification_id = ${notification.id}
          `;
          const expectedEmailKey = input.channels.includes("EMAIL")
            ? deliveryIdempotencyKey(input, "EMAIL")
            : null;
          const expectedPushKey = input.channels.includes("PUSH")
            ? deliveryIdempotencyKey(input, "PUSH")
            : null;
          if (
            existingChannels === undefined ||
            existingChannels.emailKey !== expectedEmailKey ||
            existingChannels.pushKey !== expectedPushKey
          ) {
            throw new Error("Notification channel intent collision.");
          }
        }

        for (const channel of input.channels) {
          if (channel === "IN_APP") continue;
          const idempotencyKey = deliveryIdempotencyKey(input, channel);
          await transaction`
            INSERT INTO notification_deliveries (
              notification_id,
              channel,
              idempotency_key
            ) VALUES (
              ${notification.id},
              ${channel},
              ${idempotencyKey}
            )
            ON CONFLICT (notification_id, channel) DO NOTHING
          `;
        }
        return mapNotification(notification);
      },
    });

  return Object.freeze({
    writer,
    async archive(
      notificationId: string,
      recipientUserId: string,
    ): Promise<boolean> {
      if (!isUuid(notificationId) || !isUuid(recipientUserId)) return false;
      const rows = await sql<IdentifierRow[]>`
        UPDATE notifications
        SET archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP)
        WHERE id = ${notificationId}
          AND recipient_user_id = ${recipientUserId}
        RETURNING id
      `;
      return rows.length === 1;
    },
    async claimNextEmail(options: ClaimEmailDeliveryOptions) {
      assertValidDate(options.now, "now");
      assertPositiveInteger(options.leaseDurationMs, "leaseDurationMs");
      const [row] = await sql<EmailDeliveryRow[]>`
        WITH candidate AS (
          SELECT delivery.id
          FROM notification_deliveries AS delivery
          WHERE delivery.channel = 'EMAIL'
            AND (
              (delivery.state = 'QUEUED' AND delivery.available_at <= CURRENT_TIMESTAMP)
              OR (
                delivery.state = 'PROCESSING'
                AND delivery.lease_expires_at <= CURRENT_TIMESTAMP
              )
            )
          ORDER BY
            CASE
              WHEN delivery.state = 'PROCESSING' THEN delivery.lease_expires_at
              ELSE delivery.available_at
            END,
            delivery.created_at,
            delivery.id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE notification_deliveries AS delivery
        SET
          state = 'PROCESSING',
          attempt_count = delivery.attempt_count + 1,
          lease_token = gen_random_uuid(),
          lease_expires_at = CURRENT_TIMESTAMP
            + (${options.leaseDurationMs} * interval '1 millisecond'),
          updated_at = CURRENT_TIMESTAMP
        FROM candidate, notifications AS notification
        WHERE delivery.id = candidate.id
          AND notification.id = delivery.notification_id
        RETURNING
          delivery.id AS "deliveryId",
          delivery.notification_id AS "notificationId",
          delivery.attempt_count AS attempt,
          delivery.idempotency_key AS "idempotencyKey",
          delivery.lease_token AS "leaseToken",
          notification.recipient_user_id AS "recipientUserId",
          notification.type AS "notificationType",
          notification.entity_type AS "entityType",
          notification.entity_id AS "entityId",
          notification.entity_revision AS "entityRevision",
          notification.deep_link_path AS "deepLinkPath",
          notification.priority
      `;
      return row === undefined ? undefined : mapEmailDelivery(row);
    },
    async list(
      options: NotificationListOptions,
    ): Promise<readonly NotificationRecord[]> {
      validateListOptions(options);
      const rows =
        options.filter === "UNREAD"
          ? await sql<NotificationRow[]>`
              SELECT
                id,
                recipient_user_id AS "recipientUserId",
                type,
                domain_event_id AS "domainEventId",
                event_idempotency_key AS "eventIdempotencyKey",
                entity_type AS "entityType",
                entity_id AS "entityId",
                entity_revision AS "entityRevision",
                deep_link_path AS "deepLinkPath",
                priority,
                payload,
                created_at AS "createdAt",
                read_at AS "readAt",
                archived_at AS "archivedAt"
              FROM notifications
              WHERE recipient_user_id = ${options.recipientUserId}
                AND read_at IS NULL
                AND archived_at IS NULL
              ORDER BY created_at DESC, id DESC
              LIMIT ${options.limit}
            `
          : await sql<NotificationRow[]>`
              SELECT
                id,
                recipient_user_id AS "recipientUserId",
                type,
                domain_event_id AS "domainEventId",
                event_idempotency_key AS "eventIdempotencyKey",
                entity_type AS "entityType",
                entity_id AS "entityId",
                entity_revision AS "entityRevision",
                deep_link_path AS "deepLinkPath",
                priority,
                payload,
                created_at AS "createdAt",
                read_at AS "readAt",
                archived_at AS "archivedAt"
              FROM notifications
              WHERE recipient_user_id = ${options.recipientUserId}
                AND archived_at IS NULL
              ORDER BY created_at DESC, id DESC
              LIMIT ${options.limit}
            `;
      return Object.freeze(rows.map(mapNotification));
    },
    async markAllRead(recipientUserId: string): Promise<number> {
      if (!isUuid(recipientUserId)) return 0;
      const [result] = await sql<CountRow[]>`
        WITH updated AS (
          UPDATE notifications
          SET read_at = CURRENT_TIMESTAMP
          WHERE recipient_user_id = ${recipientUserId}
            AND read_at IS NULL
            AND archived_at IS NULL
          RETURNING id
        )
        SELECT count(*)::integer AS count FROM updated
      `;
      return result?.count ?? 0;
    },
    async markEmailDelivered(
      delivery: EmailDelivery,
      providerMessageReference: string | undefined,
      deliveredAt: Date,
    ) {
      assertDeliveryMutation(delivery, providerMessageReference, deliveredAt);
      const rows = await sql<IdentifierRow[]>`
        UPDATE notification_deliveries
        SET
          state = 'DELIVERED',
          provider_message_reference = ${providerMessageReference ?? null},
          sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP),
          delivered_at = CURRENT_TIMESTAMP,
          lease_token = NULL,
          lease_expires_at = NULL,
          last_error_code = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${delivery.deliveryId}
          AND state = 'PROCESSING'
          AND lease_token = ${delivery.leaseToken}
          AND lease_expires_at > CURRENT_TIMESTAMP
        RETURNING id
      `;
      return rows.length === 1;
    },
    async markEmailSent(
      delivery: EmailDelivery,
      providerMessageReference: string | undefined,
      sentAt: Date,
    ) {
      assertDeliveryMutation(delivery, providerMessageReference, sentAt);
      const rows = await sql<IdentifierRow[]>`
        UPDATE notification_deliveries
        SET
          state = 'SENT',
          provider_message_reference = ${providerMessageReference ?? null},
          sent_at = CURRENT_TIMESTAMP,
          lease_token = NULL,
          lease_expires_at = NULL,
          last_error_code = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${delivery.deliveryId}
          AND state = 'PROCESSING'
          AND lease_token = ${delivery.leaseToken}
          AND lease_expires_at > CURRENT_TIMESTAMP
        RETURNING id
      `;
      return rows.length === 1;
    },
    async markRead(
      notificationId: string,
      recipientUserId: string,
    ): Promise<boolean> {
      if (!isUuid(notificationId) || !isUuid(recipientUserId)) return false;
      const rows = await sql<IdentifierRow[]>`
        UPDATE notifications
        SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
        WHERE id = ${notificationId}
          AND recipient_user_id = ${recipientUserId}
        RETURNING id
      `;
      return rows.length === 1;
    },
    async retryEmail(
      delivery: EmailDelivery,
      input: { readonly availableAt: Date; readonly errorCode: string },
    ) {
      assertEmailDelivery(delivery);
      assertValidDate(input.availableAt, "availableAt");
      assertErrorCode(input.errorCode);
      const rows = await sql<IdentifierRow[]>`
        UPDATE notification_deliveries
        SET
          state = 'QUEUED',
          available_at = GREATEST(CURRENT_TIMESTAMP, ${input.availableAt}),
          lease_token = NULL,
          lease_expires_at = NULL,
          last_error_code = ${input.errorCode},
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${delivery.deliveryId}
          AND state = 'PROCESSING'
          AND lease_token = ${delivery.leaseToken}
          AND lease_expires_at > CURRENT_TIMESTAMP
        RETURNING id
      `;
      return rows.length === 1;
    },
    async snapshot(): Promise<NotificationDeliverySnapshot> {
      const [row] = await sql<SnapshotRow[]>`
        SELECT
          count(*) FILTER (
            WHERE channel = 'EMAIL' AND state IN ('QUEUED', 'PROCESSING')
          )::integer AS "emailBacklog",
          count(*) FILTER (
            WHERE channel = 'EMAIL' AND state = 'QUEUED'
          )::integer AS "emailQueued",
          count(*) FILTER (
            WHERE channel = 'EMAIL' AND state = 'PROCESSING'
          )::integer AS "emailProcessing",
          count(*) FILTER (
            WHERE channel = 'EMAIL' AND state = 'TERMINAL_FAILED'
          )::integer AS "emailTerminalFailed",
          CASE WHEN min(created_at) FILTER (
            WHERE channel = 'EMAIL' AND state IN ('QUEUED', 'PROCESSING')
          ) IS NULL THEN NULL ELSE greatest(
            0,
            extract(epoch FROM (
              CURRENT_TIMESTAMP - min(created_at) FILTER (
                WHERE channel = 'EMAIL' AND state IN ('QUEUED', 'PROCESSING')
              )
            )) * 1000
          )::double precision END AS "emailOldestBacklogAgeMs"
        FROM notification_deliveries
      `;
      if (row === undefined)
        throw new Error("Notification snapshot query returned no row.");
      return Object.freeze({ ...row });
    },
    async terminalizeEmail(
      delivery: EmailDelivery,
      input: { readonly errorCode: string; readonly failedAt: Date },
    ) {
      assertEmailDelivery(delivery);
      assertValidDate(input.failedAt, "failedAt");
      assertErrorCode(input.errorCode);
      const rows = await sql<IdentifierRow[]>`
        UPDATE notification_deliveries
        SET
          state = 'TERMINAL_FAILED',
          terminal_failed_at = CURRENT_TIMESTAMP,
          lease_token = NULL,
          lease_expires_at = NULL,
          last_error_code = ${input.errorCode},
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${delivery.deliveryId}
          AND state = 'PROCESSING'
          AND lease_token = ${delivery.leaseToken}
          AND lease_expires_at > CURRENT_TIMESTAMP
        RETURNING id
      `;
      return rows.length === 1;
    },
  });
}

function mapNotification(row: NotificationRow): NotificationRecord {
  const revision =
    row.entityRevision === null ? {} : { entityRevision: row.entityRevision };
  return Object.freeze({
    archivedAt: row.archivedAt,
    context: Object.freeze({
      entityId: row.entityId,
      ...revision,
      entityType: row.entityType,
      path: row.deepLinkPath,
    }),
    createdAt: row.createdAt,
    domainEventId: row.domainEventId,
    eventIdempotencyKey: row.eventIdempotencyKey,
    id: row.id,
    payload: Object.freeze({ ...row.payload }),
    priority: row.priority,
    readAt: row.readAt,
    recipientUserId: row.recipientUserId,
    type: row.type,
  });
}

function mapEmailDelivery(row: EmailDeliveryRow): EmailDelivery {
  const revision =
    row.entityRevision === null ? {} : { entityRevision: row.entityRevision };
  return Object.freeze({
    attempt: row.attempt,
    context: Object.freeze({
      entityId: row.entityId,
      ...revision,
      entityType: row.entityType,
      path: row.deepLinkPath,
    }),
    deliveryId: row.deliveryId,
    idempotencyKey: row.idempotencyKey,
    leaseToken: row.leaseToken,
    notificationId: row.notificationId,
    notificationType: row.notificationType,
    priority: row.priority,
    recipientUserId: row.recipientUserId,
  });
}

function deliveryIdempotencyKey(
  input: CreateNotificationInput,
  channel: "EMAIL" | "PUSH",
): string {
  return `${input.domainEventId}:${input.recipientUserId}:${input.type}:${channel}`;
}

function validateCreateInput(input: CreateNotificationInput): void {
  validateNotificationDraft(input);
  if (!isUuid(input.domainEventId)) {
    throw new TypeError("domainEventId must be a UUID");
  }
  if (!eventKeyPattern.test(input.eventIdempotencyKey)) {
    throw new TypeError(
      "eventIdempotencyKey must be an opaque safe identifier",
    );
  }
}

function validateListOptions(options: NotificationListOptions): void {
  if (!isUuid(options.recipientUserId)) {
    throw new TypeError("recipientUserId must be a UUID");
  }
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  ) {
    throw new RangeError("limit must be between 1 and 100");
  }
}

function assertDeliveryMutation(
  delivery: EmailDelivery,
  providerMessageReference: string | undefined,
  occurredAt: Date,
): void {
  assertEmailDelivery(delivery);
  assertValidDate(occurredAt, "occurredAt");
  if (
    providerMessageReference !== undefined &&
    !providerReferencePattern.test(providerMessageReference)
  ) {
    throw new TypeError(
      "providerMessageReference must be an opaque safe identifier",
    );
  }
}

function assertEmailDelivery(delivery: EmailDelivery): void {
  if (!isUuid(delivery.deliveryId) || !isUuid(delivery.leaseToken)) {
    throw new TypeError("delivery and lease identifiers must be UUIDs");
  }
}

function assertErrorCode(code: string): void {
  if (!errorCodePattern.test(code)) {
    throw new TypeError("errorCode must be a stable safe identifier");
  }
}

function assertValidDate(value: Date, name: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) {
    throw new RangeError(`${name} must be a positive bounded integer`);
  }
}

function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}

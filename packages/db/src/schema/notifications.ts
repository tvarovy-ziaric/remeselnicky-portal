import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import type { EventPayload } from "@portal/outbox";

import { domainOutboxEvents } from "./outbox.js";
import { users } from "./user.js";

export const NOTIFICATION_PRIORITY_VALUES = [
  "INFO",
  "IMPORTANT",
  "CRITICAL",
] as const;
export const NOTIFICATION_CHANNEL_VALUES = ["IN_APP", "EMAIL", "PUSH"] as const;
export const NOTIFICATION_DELIVERY_STATE_VALUES = [
  "QUEUED",
  "PROCESSING",
  "SENT",
  "DELIVERED",
  "TERMINAL_FAILED",
] as const;

export const notificationPriorityEnum = pgEnum(
  "notification_priority",
  NOTIFICATION_PRIORITY_VALUES,
);
export const notificationChannelEnum = pgEnum(
  "notification_channel",
  NOTIFICATION_CHANNEL_VALUES,
);
export const notificationDeliveryStateEnum = pgEnum(
  "notification_delivery_state",
  NOTIFICATION_DELIVERY_STATE_VALUES,
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recipientUserId: uuid("recipient_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    type: text("type").notNull(),
    domainEventId: uuid("domain_event_id")
      .notNull()
      .references(() => domainOutboxEvents.eventId, { onDelete: "restrict" }),
    eventIdempotencyKey: text("event_idempotency_key").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    entityRevision: integer("entity_revision"),
    deepLinkPath: text("deep_link_path").notNull(),
    priority: notificationPriorityEnum("priority").notNull(),
    payload: jsonb("payload").$type<EventPayload>().notNull().default({}),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    readAt: timestamp("read_at", { mode: "date", withTimezone: true }),
    archivedAt: timestamp("archived_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    unique("notifications_event_recipient_type_unique").on(
      table.domainEventId,
      table.recipientUserId,
      table.type,
    ),
    index("notifications_recipient_created_idx")
      .on(table.recipientUserId, table.createdAt, table.id)
      .where(sql`${table.archivedAt} IS NULL`),
    index("notifications_recipient_unread_idx")
      .on(table.recipientUserId, table.createdAt, table.id)
      .where(sql`${table.readAt} IS NULL AND ${table.archivedAt} IS NULL`),
    check(
      "notifications_payload_is_safe",
      sql`notification_payload_is_safe(${table.payload})`,
    ),
  ],
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    channel: notificationChannelEnum("channel").notNull(),
    state: notificationDeliveryStateEnum("state").notNull().default("QUEUED"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    lastErrorCode: text("last_error_code"),
    providerMessageReference: text("provider_message_reference"),
    sentAt: timestamp("sent_at", { mode: "date", withTimezone: true }),
    deliveredAt: timestamp("delivered_at", {
      mode: "date",
      withTimezone: true,
    }),
    terminalFailedAt: timestamp("terminal_failed_at", {
      mode: "date",
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("notification_deliveries_channel_unique").on(
      table.notificationId,
      table.channel,
    ),
  ],
);

export type NotificationRecord = typeof notifications.$inferSelect;
export type NewNotificationRecord = typeof notifications.$inferInsert;
export type NotificationDeliveryRecord =
  typeof notificationDeliveries.$inferSelect;
export type NewNotificationDeliveryRecord =
  typeof notificationDeliveries.$inferInsert;

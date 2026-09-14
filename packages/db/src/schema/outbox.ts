import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import type { EventPayload } from "@portal/outbox";

export const OUTBOX_EVENT_STATUS_VALUES = [
  "PENDING",
  "PROCESSING",
  "PUBLISHED",
  "TERMINAL",
] as const;

export const outboxEventStatusEnum = pgEnum(
  "outbox_event_status",
  OUTBOX_EVENT_STATUS_VALUES,
);

export const domainOutboxEvents = pgTable(
  "domain_outbox_events",
  {
    eventId: uuid("event_id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    eventName: text("event_name").notNull(),
    schemaVersion: smallint("schema_version").notNull(),
    occurredAt: timestamp("occurred_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    payload: jsonb("payload").$type<EventPayload>().notNull(),
    commandName: text("command_name").notNull(),
    correlationId: text("correlation_id").notNull(),
    status: outboxEventStatusEnum("status").notNull().default("PENDING"),
    availableAt: timestamp("available_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    lastErrorCode: text("last_error_code"),
    publishedAt: timestamp("published_at", {
      mode: "date",
      withTimezone: true,
    }),
    terminalAt: timestamp("terminal_at", {
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
    unique("domain_outbox_events_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    index("domain_outbox_events_pending_idx").on(
      table.availableAt,
      table.occurredAt,
      table.eventId,
    ),
    index("domain_outbox_events_expired_lease_idx").on(
      table.leaseExpiresAt,
      table.occurredAt,
      table.eventId,
    ),
    index("domain_outbox_events_terminal_idx").on(
      table.terminalAt,
      table.eventName,
    ),
    check(
      "domain_outbox_events_payload_object_bounded",
      sql`outbox_payload_is_minimal(${table.payload}) AND octet_length(${table.payload}::text) <= 8192`,
    ),
  ],
);

export const outboxConsumerEffects = pgTable(
  "outbox_consumer_effects",
  {
    consumerName: text("consumer_name").notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => domainOutboxEvents.eventId, { onDelete: "restrict" }),
    appliedAt: timestamp("applied_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.consumerName, table.eventId] }),
    index("outbox_consumer_effects_event_idx").on(
      table.eventId,
      table.appliedAt,
    ),
  ],
);

export type DomainOutboxEventRecord = typeof domainOutboxEvents.$inferSelect;
export type NewDomainOutboxEventRecord = typeof domainOutboxEvents.$inferInsert;
export type OutboxConsumerEffectRecord =
  typeof outboxConsumerEffects.$inferSelect;

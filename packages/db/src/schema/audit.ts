import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import {
  AUDIT_ACTOR_KIND_VALUES,
  AUDIT_EVENT_CATEGORY_VALUES,
  SENSITIVE_ACCESS_PURPOSE_VALUES,
  type AuditChanges,
} from "@portal/audit";

import { adminRoleChangeEvents } from "./admin-auth.js";
import { users } from "./user.js";

export const auditEventCategoryEnum = pgEnum(
  "audit_event_category",
  AUDIT_EVENT_CATEGORY_VALUES,
);
export const auditActorKindEnum = pgEnum(
  "audit_actor_kind",
  AUDIT_ACTOR_KIND_VALUES,
);
export const auditSensitiveAccessPurposeEnum = pgEnum(
  "audit_sensitive_access_purpose",
  SENSITIVE_ACCESS_PURPOSE_VALUES,
);

export const auditEvents = pgTable(
  "audit_events",
  {
    eventId: uuid("event_id").primaryKey(),
    correlationId: uuid("correlation_id").notNull(),
    category: auditEventCategoryEnum("category").notNull(),
    actorKind: auditActorKindEnum("actor_kind").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    actorSystemReference: text("actor_system_reference"),
    actorCapability: text("actor_capability"),
    actionType: text("action_type").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    reason: text("reason"),
    sensitiveAccessPurpose: auditSensitiveAccessPurposeEnum(
      "sensitive_access_purpose",
    ),
    contextType: text("context_type"),
    contextId: text("context_id"),
    changes: jsonb("changes").$type<AuditChanges>().notNull().default({}),
    sourceAdminRoleChangeEventId: uuid("source_admin_role_change_event_id")
      .references(() => adminRoleChangeEvents.eventId)
      .unique(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "audit_events_changes_safe",
      sql`audit_diff_is_safe(${table.changes})`,
    ),
    index("audit_events_actor_timeline_idx")
      .on(table.actorUserId, table.occurredAt, table.eventId)
      .where(sql`${table.actorUserId} IS NOT NULL`),
    index("audit_events_target_timeline_idx").on(
      table.targetType,
      table.targetId,
      table.occurredAt,
      table.eventId,
    ),
    index("audit_events_correlation_idx").on(
      table.correlationId,
      table.occurredAt,
      table.eventId,
    ),
  ],
);

export type AuditEventRecord = typeof auditEvents.$inferSelect;
export type NewAuditEventRecord = typeof auditEvents.$inferInsert;

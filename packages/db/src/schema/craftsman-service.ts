import { sql } from "drizzle-orm";
import {
  char,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { craftsmanProfessions } from "./craftsman-profession.js";
import { craftsmanProfiles } from "./craftsman-profile.js";
import { taxonomyServices } from "./taxonomy.js";
import { users } from "./user.js";

export const craftsmanServiceStateEnum = pgEnum("craftsman_service_state", [
  "ACTIVE",
  "INACTIVE",
]);
export const craftsmanServiceCommandKindEnum = pgEnum(
  "craftsman_service_command_kind",
  ["ADD", "DEACTIVATE"],
);

export const craftsmanServices = pgTable(
  "craftsman_services",
  {
    id: uuid("id").primaryKey(),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id),
    taxonomyReleaseId: uuid("taxonomy_release_id").notNull(),
    serviceCode: text("service_code").notNull(),
    state: craftsmanServiceStateEnum("state").notNull().default("ACTIVE"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    deactivatedByUserId: uuid("deactivated_by_user_id").references(
      () => users.id,
    ),
    deactivationCommandId: uuid("deactivation_command_id"),
    deactivatedAt: timestamp("deactivated_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (table) => [
    foreignKey({
      columns: [table.taxonomyReleaseId, table.serviceCode],
      foreignColumns: [
        taxonomyServices.releaseId,
        taxonomyServices.serviceCode,
      ],
      name: "craftsman_services_taxonomy_service_fkey",
    }),
    uniqueIndex("craftsman_services_one_active_code_per_profile")
      .on(table.craftsmanProfileId, table.serviceCode)
      .where(sql`${table.state} = 'ACTIVE'`),
    index("craftsman_services_public_count_idx")
      .on(table.serviceCode, table.craftsmanProfileId)
      .where(sql`${table.state} = 'ACTIVE'`),
  ],
);

export const craftsmanServiceProfessionLinks = pgTable(
  "craftsman_service_profession_links",
  {
    craftsmanServiceId: uuid("craftsman_service_id")
      .notNull()
      .references(() => craftsmanServices.id),
    craftsmanProfessionId: uuid("craftsman_profession_id")
      .notNull()
      .references(() => craftsmanProfessions.id),
    linkedAt: timestamp("linked_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.craftsmanServiceId, table.craftsmanProfessionId],
    }),
  ],
);

export const craftsmanServiceCommands = pgTable(
  "craftsman_service_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    commandKind: craftsmanServiceCommandKindEnum("command_kind").notNull(),
    craftsmanServiceId: uuid("craftsman_service_id")
      .notNull()
      .references(() => craftsmanServices.id),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("craftsman_service_commands_assignment_idx").on(
      table.craftsmanServiceId,
      table.occurredAt,
    ),
    check(
      "craftsman_service_command_fingerprint_safe",
      sql`${table.payloadFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export type CraftsmanServiceRecord = typeof craftsmanServices.$inferSelect;

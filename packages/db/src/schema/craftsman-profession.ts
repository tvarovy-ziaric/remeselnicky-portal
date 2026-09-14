import { sql } from "drizzle-orm";
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  CRAFTSMAN_PROFESSION_STATES,
  PROFESSION_PROFICIENCY_LEVELS,
} from "@portal/domain";

import { craftsmanProfiles } from "./craftsman-profile.js";
import { taxonomyProfessions } from "./taxonomy.js";
import { users } from "./user.js";

export const CRAFTSMAN_PROFESSION_COMMAND_KINDS = Object.freeze([
  "ASSIGN",
  "CHANGE_DECLARED_LEVEL",
  "DEACTIVATE",
] as const);

export const professionProficiencyLevelEnum = pgEnum(
  "profession_proficiency_level",
  PROFESSION_PROFICIENCY_LEVELS,
);
export const craftsmanProfessionStateEnum = pgEnum(
  "craftsman_profession_state",
  CRAFTSMAN_PROFESSION_STATES,
);
export const craftsmanProfessionCommandKindEnum = pgEnum(
  "craftsman_profession_command_kind",
  CRAFTSMAN_PROFESSION_COMMAND_KINDS,
);

export const craftsmanProfessions = pgTable(
  "craftsman_professions",
  {
    id: uuid("id").primaryKey(),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id),
    taxonomyReleaseId: uuid("taxonomy_release_id").notNull(),
    professionCode: text("profession_code").notNull(),
    state: craftsmanProfessionStateEnum("state").notNull().default("ACTIVE"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    deactivatedByUserId: uuid("deactivated_by_user_id").references(
      () => users.id,
    ),
    // The SQL migration adds the circular FK to craftsman_profession_commands.
    deactivationCommandId: uuid("deactivation_command_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    deactivatedAt: timestamp("deactivated_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (table) => [
    foreignKey({
      columns: [table.taxonomyReleaseId, table.professionCode],
      foreignColumns: [
        taxonomyProfessions.releaseId,
        taxonomyProfessions.professionCode,
      ],
      name: "craftsman_professions_taxonomy_profession_fkey",
    }),
    uniqueIndex("craftsman_professions_one_active_code_per_profile")
      .on(table.craftsmanProfileId, table.professionCode)
      .where(sql`${table.state} = 'ACTIVE'`),
    index("craftsman_professions_profile_history_idx").on(
      table.craftsmanProfileId,
      table.createdAt,
      table.id,
    ),
    check(
      "craftsman_profession_state_consistent",
      sql`(
        ${table.state} = 'ACTIVE'
        AND ${table.deactivatedByUserId} IS NULL
        AND ${table.deactivationCommandId} IS NULL
        AND ${table.deactivatedAt} IS NULL
      ) OR (
        ${table.state} = 'INACTIVE'
        AND ${table.deactivatedByUserId} IS NOT NULL
        AND ${table.deactivationCommandId} IS NOT NULL
        AND ${table.deactivatedAt} IS NOT NULL
        AND ${table.deactivatedAt} >= ${table.createdAt}
      )`,
    ),
  ],
);

export const craftsmanProfessionCommands = pgTable(
  "craftsman_profession_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    commandKind: craftsmanProfessionCommandKindEnum("command_kind").notNull(),
    craftsmanProfessionId: uuid("craftsman_profession_id")
      .notNull()
      .references(() => craftsmanProfessions.id),
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
    index("craftsman_profession_commands_assignment_idx").on(
      table.craftsmanProfessionId,
      table.occurredAt,
    ),
    check(
      "craftsman_profession_command_fingerprint_safe",
      sql`${table.payloadFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const craftsmanProfessionDeclaredLevelEvents = pgTable(
  "craftsman_profession_declared_level_events",
  {
    eventId: uuid("event_id").primaryKey(),
    commandId: uuid("command_id")
      .notNull()
      .references(() => craftsmanProfessionCommands.commandId),
    craftsmanProfessionId: uuid("craftsman_profession_id")
      .notNull()
      .references(() => craftsmanProfessions.id),
    revision: integer("revision").notNull(),
    declaredLevel: professionProficiencyLevelEnum("declared_level").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("craftsman_profession_declared_level_events_command_id_key").on(
      table.commandId,
    ),
    unique(
      "craftsman_profession_declared_level_events_assignment_revision_key",
    ).on(table.craftsmanProfessionId, table.revision),
    check(
      "craftsman_profession_declared_level_revision_positive",
      sql`${table.revision} > 0`,
    ),
  ],
);

export type CraftsmanProfessionRecord =
  typeof craftsmanProfessions.$inferSelect;
export type CraftsmanProfessionCommandRecord =
  typeof craftsmanProfessionCommands.$inferSelect;
export type CraftsmanProfessionDeclaredLevelEventRecord =
  typeof craftsmanProfessionDeclaredLevelEvents.$inferSelect;

import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { craftsmanProfiles } from "./craftsman-profile.js";
import { users } from "./user.js";

export const CRAFTSMAN_EXPERIENCE_COMMAND_RESULTS = Object.freeze([
  "APPLIED",
  "UNCHANGED",
] as const);

export const craftsmanExperienceCommandResultEnum = pgEnum(
  "craftsman_experience_command_result",
  CRAFTSMAN_EXPERIENCE_COMMAND_RESULTS,
);

export const craftsmanExperienceCommands = pgTable(
  "craftsman_experience_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    expectedRevision: integer("expected_revision").notNull(),
    resultKind: craftsmanExperienceCommandResultEnum("result_kind").notNull(),
    resultingRevision: integer("resulting_revision").notNull(),
    workingSinceYear: integer("working_since_year"),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("craftsman_experience_commands_profile_created_idx").on(
      table.craftsmanProfileId,
      table.createdAt,
      table.commandId,
    ),
    check(
      "craftsman_experience_expected_revision_nonnegative",
      sql`${table.expectedRevision} >= 0`,
    ),
    check(
      "craftsman_experience_resulting_revision_nonnegative",
      sql`${table.resultingRevision} >= 0`,
    ),
    check(
      "craftsman_experience_working_since_technical_range",
      sql`${table.workingSinceYear} IS NULL OR ${table.workingSinceYear} BETWEEN 1800 AND 9999`,
    ),
  ],
);

export const craftsmanExperienceRevisions = pgTable(
  "craftsman_experience_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id),
    commandId: uuid("command_id")
      .notNull()
      .unique()
      .references(() => craftsmanExperienceCommands.commandId),
    revision: integer("revision").notNull(),
    workingSinceYear: integer("working_since_year"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("craftsman_experience_revisions_profile_revision_key").on(
      table.craftsmanProfileId,
      table.revision,
    ),
    check("craftsman_experience_revision_positive", sql`${table.revision} > 0`),
    check(
      "craftsman_experience_revision_year_technical_range",
      sql`${table.workingSinceYear} IS NULL OR ${table.workingSinceYear} BETWEEN 1800 AND 9999`,
    ),
  ],
);

export type CraftsmanExperienceCommandRecord =
  typeof craftsmanExperienceCommands.$inferSelect;
export type CraftsmanExperienceRevisionRecord =
  typeof craftsmanExperienceRevisions.$inferSelect;

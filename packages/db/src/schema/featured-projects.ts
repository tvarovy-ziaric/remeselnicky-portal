import { sql } from "drizzle-orm";
import {
  char,
  check,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { portfolioProjects } from "./portfolio-project.js";
import { craftsmanProfiles } from "./craftsman-profile.js";
import { users } from "./user.js";

export const FEATURED_PROJECT_COMMAND_KINDS = Object.freeze([
  "PIN",
  "UNPIN",
  "REORDER",
] as const);

export const featuredProjectCommandKindEnum = pgEnum(
  "featured_project_command_kind",
  FEATURED_PROJECT_COMMAND_KINDS,
);

export const featuredProjectSets = pgTable(
  "featured_project_sets",
  {
    craftsmanProfileId: uuid("craftsman_profile_id")
      .primaryKey()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    projectIds: uuid("project_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    revision: integer("revision").notNull().default(0),
    latestCommandId: uuid("latest_command_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "featured_project_sets_revision_nonnegative",
      sql`${table.revision} >= 0`,
    ),
  ],
);

export const featuredProjectCommands = pgTable("featured_project_commands", {
  commandId: uuid("command_id").primaryKey(),
  commandKind: featuredProjectCommandKindEnum("command_kind").notNull(),
  craftsmanProfileId: uuid("craftsman_profile_id")
    .notNull()
    .references(() => featuredProjectSets.craftsmanProfileId, {
      onDelete: "restrict",
    }),
  actorUserId: uuid("actor_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  expectedRevision: integer("expected_revision").notNull(),
  resultingRevision: integer("resulting_revision").notNull(),
  targetProjectId: uuid("target_project_id").references(
    () => portfolioProjects.id,
    { onDelete: "restrict" },
  ),
  resultingProjectIds: uuid("resulting_project_ids").array().notNull(),
  payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
  occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const featuredProjectRevisions = pgTable(
  "featured_project_revisions",
  {
    eventId: uuid("event_id").primaryKey(),
    commandId: uuid("command_id")
      .notNull()
      .references(() => featuredProjectCommands.commandId, {
        onDelete: "restrict",
      }),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => featuredProjectSets.craftsmanProfileId, {
        onDelete: "restrict",
      }),
    revision: integer("revision").notNull(),
    projectIds: uuid("project_ids").array().notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("featured_project_revisions_command_key").on(table.commandId),
    unique("featured_project_revisions_profile_revision_key").on(
      table.craftsmanProfileId,
      table.revision,
    ),
  ],
);

export type FeaturedProjectSetRecord = typeof featuredProjectSets.$inferSelect;
export type FeaturedProjectCommandRecord =
  typeof featuredProjectCommands.$inferSelect;
export type FeaturedProjectRevisionRecord =
  typeof featuredProjectRevisions.$inferSelect;

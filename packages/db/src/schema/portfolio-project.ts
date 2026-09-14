import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  PORTFOLIO_DURATION_UNITS,
  PORTFOLIO_PROJECT_RECORD_STATES,
} from "@portal/domain";

import { craftsmanProfiles } from "./craftsman-profile.js";
import {
  locationDistricts,
  locationMunicipalities,
} from "./craftsman-service-area.js";
import { users } from "./user.js";

export const PORTFOLIO_PROJECT_COMMAND_KINDS = Object.freeze([
  "CREATE",
  "EDIT",
  "HIDE",
  "ARCHIVE",
  "RESTORE_DRAFT",
] as const);

export const portfolioProjectProvenanceKindEnum = pgEnum(
  "portfolio_project_provenance_kind",
  ["SELF_DECLARED"],
);
export const portfolioProjectRecordStateEnum = pgEnum(
  "portfolio_project_record_state",
  PORTFOLIO_PROJECT_RECORD_STATES,
);
export const portfolioProjectDurationUnitEnum = pgEnum(
  "portfolio_project_duration_unit",
  PORTFOLIO_DURATION_UNITS,
);
export const portfolioProjectCommandKindEnum = pgEnum(
  "portfolio_project_command_kind",
  PORTFOLIO_PROJECT_COMMAND_KINDS,
);

const contentColumns = {
  title: text("title").notNull(),
  shortDescription: text("short_description").notNull(),
  contribution: text("contribution"),
  materialsAndTechnologies: text("materials_and_technologies"),
  problem: text("problem"),
  solution: text("solution"),
  durationValue: integer("duration_value"),
  durationUnit: portfolioProjectDurationUnitEnum("duration_unit"),
  indicativePriceMinCents: bigint("indicative_price_min_cents", {
    mode: "number",
  }),
  indicativePriceMaxCents: bigint("indicative_price_max_cents", {
    mode: "number",
  }),
  currency: char("currency", { length: 3 }).notNull().default("EUR"),
  municipalityCode: text("municipality_code").references(
    () => locationMunicipalities.code,
    { onDelete: "restrict" },
  ),
  districtCode: text("district_code").references(() => locationDistricts.code, {
    onDelete: "restrict",
  }),
  professionIds: uuid("profession_ids").array().notNull(),
  skillIds: uuid("skill_ids")
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`),
  specializationIds: uuid("specialization_ids")
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`),
};

export const portfolioProjects = pgTable(
  "portfolio_projects",
  {
    id: uuid("id").primaryKey(),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    provenanceKind: portfolioProjectProvenanceKindEnum("provenance_kind")
      .notNull()
      .default("SELF_DECLARED"),
    recordState: portfolioProjectRecordStateEnum("record_state")
      .notNull()
      .default("DRAFT"),
    ...contentColumns,
    revision: integer("revision").notNull().default(1),
    latestCommandId: uuid("latest_command_id").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("portfolio_projects_profile_state_idx").on(
      table.craftsmanProfileId,
      table.recordState,
      table.updatedAt,
      table.id,
    ),
    check("portfolio_projects_revision_positive", sql`${table.revision} > 0`),
  ],
);

export const portfolioProjectCommands = pgTable("portfolio_project_commands", {
  commandId: uuid("command_id").primaryKey(),
  commandKind: portfolioProjectCommandKindEnum("command_kind").notNull(),
  portfolioProjectId: uuid("portfolio_project_id")
    .notNull()
    .references(() => portfolioProjects.id, { onDelete: "restrict" }),
  craftsmanProfileId: uuid("craftsman_profile_id")
    .notNull()
    .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
  actorUserId: uuid("actor_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  expectedRevision: integer("expected_revision").notNull(),
  resultingRevision: integer("resulting_revision").notNull(),
  payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
  occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const portfolioProjectRevisions = pgTable(
  "portfolio_project_revisions",
  {
    eventId: uuid("event_id").primaryKey(),
    commandId: uuid("command_id")
      .notNull()
      .references(() => portfolioProjectCommands.commandId, {
        onDelete: "restrict",
      }),
    portfolioProjectId: uuid("portfolio_project_id")
      .notNull()
      .references(() => portfolioProjects.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    recordState: portfolioProjectRecordStateEnum("record_state").notNull(),
    ...contentColumns,
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("portfolio_project_revisions_command_key").on(table.commandId),
    unique("portfolio_project_revisions_project_revision_key").on(
      table.portfolioProjectId,
      table.revision,
    ),
  ],
);

export type PortfolioProjectRecord = typeof portfolioProjects.$inferSelect;
export type PortfolioProjectCommandRecord =
  typeof portfolioProjectCommands.$inferSelect;
export type PortfolioProjectRevisionRecord =
  typeof portfolioProjectRevisions.$inferSelect;

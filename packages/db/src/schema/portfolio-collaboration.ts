import { sql } from "drizzle-orm";
import {
  char,
  check,
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
  PORTFOLIO_COLLABORATION_STATES,
  PORTFOLIO_COLLABORATION_VISIBILITIES,
} from "@portal/domain";

import { craftsmanProfiles } from "./craftsman-profile.js";
import { portfolioProjects } from "./portfolio-project.js";
import { users } from "./user.js";

export const PORTFOLIO_COLLABORATION_ACTOR_KINDS = [
  "AUTHOR",
  "COLLABORATOR",
] as const;
export const PORTFOLIO_COLLABORATION_COMMAND_KINDS = [
  "INVITE",
  "EDIT_PENDING",
  "AUTHOR_WITHDRAW",
  "COLLABORATOR_ACCEPT",
  "COLLABORATOR_DECLINE",
  "COLLABORATOR_WITHDRAW",
  "HIDE",
  "SHOW",
] as const;

export const portfolioCollaborationStateEnum = pgEnum(
  "portfolio_collaboration_state",
  PORTFOLIO_COLLABORATION_STATES,
);
export const portfolioCollaborationVisibilityEnum = pgEnum(
  "portfolio_collaboration_visibility",
  PORTFOLIO_COLLABORATION_VISIBILITIES,
);
export const portfolioCollaborationActorKindEnum = pgEnum(
  "portfolio_collaboration_actor_kind",
  PORTFOLIO_COLLABORATION_ACTOR_KINDS,
);
export const portfolioCollaborationCommandKindEnum = pgEnum(
  "portfolio_collaboration_command_kind",
  PORTFOLIO_COLLABORATION_COMMAND_KINDS,
);

export const portfolioCollaborations = pgTable(
  "portfolio_collaborations",
  {
    id: uuid("id").primaryKey(),
    portfolioProjectId: uuid("portfolio_project_id")
      .notNull()
      .references(() => portfolioProjects.id, { onDelete: "restrict" }),
    authorProfileId: uuid("author_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    collaboratorProfileId: uuid("collaborator_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    state: portfolioCollaborationStateEnum("state")
      .notNull()
      .default("PENDING"),
    visibility: portfolioCollaborationVisibilityEnum("visibility")
      .notNull()
      .default("VISIBLE"),
    role: text("role").notNull(),
    contribution: text("contribution").notNull(),
    revision: integer("revision").notNull().default(1),
    latestCommandId: uuid("latest_command_id").notNull(),
    invitedAt: timestamp("invited_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    acceptedAt: timestamp("accepted_at", { mode: "date", withTimezone: true }),
    terminalAt: timestamp("terminal_at", { mode: "date", withTimezone: true }),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("portfolio_collaborations_one_live_pair_idx")
      .on(table.portfolioProjectId, table.collaboratorProfileId)
      .where(sql`${table.state} IN ('PENDING', 'ACCEPTED')`),
    index("portfolio_collaborations_author_timeline_idx").on(
      table.authorProfileId,
      table.updatedAt,
      table.id,
    ),
    index("portfolio_collaborations_collaborator_timeline_idx").on(
      table.collaboratorProfileId,
      table.updatedAt,
      table.id,
    ),
    check(
      "portfolio_collaborations_distinct_profiles",
      sql`${table.authorProfileId} <> ${table.collaboratorProfileId}`,
    ),
    check(
      "portfolio_collaborations_revision_positive",
      sql`${table.revision} > 0`,
    ),
  ],
);

export const portfolioCollaborationCommands = pgTable(
  "portfolio_collaboration_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    commandKind:
      portfolioCollaborationCommandKindEnum("command_kind").notNull(),
    collaborationId: uuid("collaboration_id")
      .notNull()
      .references(() => portfolioCollaborations.id, { onDelete: "restrict" }),
    portfolioProjectId: uuid("portfolio_project_id")
      .notNull()
      .references(() => portfolioProjects.id, { onDelete: "restrict" }),
    actorKind: portfolioCollaborationActorKindEnum("actor_kind").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expectedRevision: integer("expected_revision").notNull(),
    resultingRevision: integer("resulting_revision").notNull(),
    requestedRole: text("requested_role"),
    requestedContribution: text("requested_contribution"),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "portfolio_collaboration_commands_revision_valid",
      sql`${table.expectedRevision} >= 0 AND ${table.resultingRevision} > 0`,
    ),
  ],
);

export const portfolioCollaborationRevisions = pgTable(
  "portfolio_collaboration_revisions",
  {
    eventId: uuid("event_id").primaryKey().defaultRandom(),
    commandId: uuid("command_id")
      .notNull()
      .unique()
      .references(() => portfolioCollaborationCommands.commandId, {
        onDelete: "restrict",
      }),
    collaborationId: uuid("collaboration_id")
      .notNull()
      .references(() => portfolioCollaborations.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    state: portfolioCollaborationStateEnum("state").notNull(),
    visibility: portfolioCollaborationVisibilityEnum("visibility").notNull(),
    role: text("role").notNull(),
    contribution: text("contribution").notNull(),
    acceptedAt: timestamp("accepted_at", { mode: "date", withTimezone: true }),
    terminalAt: timestamp("terminal_at", { mode: "date", withTimezone: true }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("portfolio_collaboration_revisions_lineage_revision_key").on(
      table.collaborationId,
      table.revision,
    ),
    check(
      "portfolio_collaboration_revisions_revision_positive",
      sql`${table.revision} > 0`,
    ),
  ],
);

export type PortfolioCollaborationRecord =
  typeof portfolioCollaborations.$inferSelect;
export type PortfolioCollaborationCommandRecord =
  typeof portfolioCollaborationCommands.$inferSelect;
export type PortfolioCollaborationRevisionRecord =
  typeof portfolioCollaborationRevisions.$inferSelect;

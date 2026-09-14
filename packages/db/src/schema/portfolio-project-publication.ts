import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { mediaAssets, mediaAssetStorageObjects } from "./media.js";
import {
  portfolioPhotoAttachments,
  portfolioPhotoPhaseEnum,
} from "./portfolio-project-media.js";
import { portfolioProjects } from "./portfolio-project.js";
import { craftsmanProfiles } from "./craftsman-profile.js";
import { users } from "./user.js";

export const PORTFOLIO_PROJECT_PUBLICATION_STATES = Object.freeze([
  "HIDDEN",
  "PUBLIC",
] as const);
export const PORTFOLIO_PROJECT_PUBLICATION_COMMAND_KINDS = Object.freeze([
  "PUBLISH",
  "HIDE",
] as const);

export const portfolioProjectPublicationStateEnum = pgEnum(
  "portfolio_project_publication_state",
  PORTFOLIO_PROJECT_PUBLICATION_STATES,
);
export const portfolioProjectPublicationCommandKindEnum = pgEnum(
  "portfolio_project_publication_command_kind",
  PORTFOLIO_PROJECT_PUBLICATION_COMMAND_KINDS,
);

export const portfolioProjectPublications = pgTable(
  "portfolio_project_publications",
  {
    portfolioProjectId: uuid("portfolio_project_id")
      .primaryKey()
      .references(() => portfolioProjects.id, { onDelete: "restrict" }),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull().default(0),
    state: portfolioProjectPublicationStateEnum("state")
      .notNull()
      .default("HIDDEN"),
    latestCommandId: uuid("latest_command_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("portfolio_project_publications_project_profile_key").on(
      table.portfolioProjectId,
      table.craftsmanProfileId,
    ),
    check(
      "portfolio_project_publications_revision_nonnegative",
      sql`${table.revision} >= 0`,
    ),
  ],
);

export const portfolioProjectPublicationCommands = pgTable(
  "portfolio_project_publication_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    commandKind:
      portfolioProjectPublicationCommandKindEnum("command_kind").notNull(),
    portfolioProjectId: uuid("portfolio_project_id")
      .notNull()
      .references(() => portfolioProjectPublications.portfolioProjectId, {
        onDelete: "restrict",
      }),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expectedRevision: integer("expected_revision").notNull(),
    resultingRevision: integer("resulting_revision").notNull(),
    projectRevision: integer("project_revision").notNull(),
    photoSetRevision: integer("photo_set_revision").notNull(),
    resultingState:
      portfolioProjectPublicationStateEnum("resulting_state").notNull(),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    occurredAt: timestamp("occurred_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "portfolio_project_publication_commands_revision_step",
      sql`${table.resultingRevision} = ${table.expectedRevision} + 1`,
    ),
  ],
);

export const portfolioProjectPublicationRevisions = pgTable(
  "portfolio_project_publication_revisions",
  {
    eventId: uuid("event_id").primaryKey(),
    commandId: uuid("command_id")
      .notNull()
      .unique()
      .references(() => portfolioProjectPublicationCommands.commandId, {
        onDelete: "restrict",
      }),
    portfolioProjectId: uuid("portfolio_project_id")
      .notNull()
      .references(() => portfolioProjectPublications.portfolioProjectId, {
        onDelete: "restrict",
      }),
    revision: integer("revision").notNull(),
    state: portfolioProjectPublicationStateEnum("state").notNull(),
    projectRevision: integer("project_revision").notNull(),
    photoSetRevision: integer("photo_set_revision").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    occurredAt: timestamp("occurred_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    createdTransactionId: bigint("created_transaction_id", {
      mode: "number",
    }).notNull(),
  },
  (table) => [
    unique("portfolio_project_publication_revisions_project_revision_key").on(
      table.portfolioProjectId,
      table.revision,
    ),
    index("portfolio_project_publication_revisions_project_idx").on(
      table.portfolioProjectId,
      table.revision,
    ),
  ],
);

export const portfolioProjectPublicationItems = pgTable(
  "portfolio_project_publication_items",
  {
    revisionEventId: uuid("revision_event_id")
      .notNull()
      .references(() => portfolioProjectPublicationRevisions.eventId, {
        onDelete: "restrict",
      }),
    attachmentId: uuid("attachment_id")
      .notNull()
      .references(() => portfolioPhotoAttachments.id, {
        onDelete: "restrict",
      }),
    mediaAssetId: uuid("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "restrict" }),
    sourceObjectId: uuid("source_object_id")
      .notNull()
      .references(() => mediaAssetStorageObjects.id, {
        onDelete: "restrict",
      }),
    publicObjectId: uuid("public_object_id")
      .notNull()
      .unique()
      .references(() => mediaAssetStorageObjects.id, {
        onDelete: "restrict",
      }),
    phase: portfolioPhotoPhaseEnum("phase").notNull(),
    displayOrder: integer("display_order").notNull(),
    canonicalWidth: integer("canonical_width").notNull(),
    canonicalHeight: integer("canonical_height").notNull(),
    createdTransactionId: bigint("created_transaction_id", {
      mode: "number",
    }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.revisionEventId, table.attachmentId] }),
    unique("portfolio_project_publication_items_asset_key").on(
      table.revisionEventId,
      table.mediaAssetId,
    ),
    unique("portfolio_project_publication_items_order_key").on(
      table.revisionEventId,
      table.displayOrder,
    ),
  ],
);

export type PortfolioProjectPublicationRecord =
  typeof portfolioProjectPublications.$inferSelect;
export type PortfolioProjectPublicationCommandRecord =
  typeof portfolioProjectPublicationCommands.$inferSelect;
export type PortfolioProjectPublicationRevisionRecord =
  typeof portfolioProjectPublicationRevisions.$inferSelect;
export type PortfolioProjectPublicationItemRecord =
  typeof portfolioProjectPublicationItems.$inferSelect;

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

import { PORTFOLIO_PHOTO_PHASES, PORTFOLIO_PHOTO_STATES } from "@portal/domain";

import { mediaAssets } from "./media.js";
import { portfolioProjects } from "./portfolio-project.js";
import { craftsmanProfiles } from "./craftsman-profile.js";
import { users } from "./user.js";

export const PORTFOLIO_PHOTO_COMMAND_KINDS = Object.freeze([
  "ATTACH",
  "REORDER",
  "SET_PHASE",
  "HIDE",
  "RESTORE",
] as const);

export const portfolioPhotoPhaseEnum = pgEnum(
  "portfolio_photo_phase",
  PORTFOLIO_PHOTO_PHASES,
);
export const portfolioPhotoStateEnum = pgEnum(
  "portfolio_photo_state",
  PORTFOLIO_PHOTO_STATES,
);
export const portfolioPhotoCommandKindEnum = pgEnum(
  "portfolio_photo_command_kind",
  PORTFOLIO_PHOTO_COMMAND_KINDS,
);

export const portfolioProjectPhotoSets = pgTable(
  "portfolio_project_photo_sets",
  {
    portfolioProjectId: uuid("portfolio_project_id")
      .primaryKey()
      .references(() => portfolioProjects.id, { onDelete: "restrict" }),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
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
    unique("portfolio_photo_sets_project_profile_key").on(
      table.portfolioProjectId,
      table.craftsmanProfileId,
    ),
    check(
      "portfolio_photo_sets_revision_nonnegative",
      sql`${table.revision} >= 0`,
    ),
  ],
);

export const portfolioPhotoCommands = pgTable("portfolio_photo_commands", {
  commandId: uuid("command_id").primaryKey(),
  commandKind: portfolioPhotoCommandKindEnum("command_kind").notNull(),
  portfolioProjectId: uuid("portfolio_project_id")
    .notNull()
    .references(() => portfolioProjectPhotoSets.portfolioProjectId, {
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
  targetAttachmentId: uuid("target_attachment_id"),
  targetMediaAssetId: uuid("target_media_asset_id").references(
    () => mediaAssets.id,
    { onDelete: "restrict" },
  ),
  targetPhase: portfolioPhotoPhaseEnum("target_phase"),
  orderedAttachmentIds: uuid("ordered_attachment_ids").array(),
  payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
  occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const portfolioPhotoAttachments = pgTable(
  "portfolio_photo_attachments",
  {
    id: uuid("id").primaryKey(),
    portfolioProjectId: uuid("portfolio_project_id")
      .notNull()
      .references(() => portfolioProjectPhotoSets.portfolioProjectId, {
        onDelete: "restrict",
      }),
    mediaAssetId: uuid("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "restrict" }),
    attachedByUserId: uuid("attached_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    attachCommandId: uuid("attach_command_id")
      .notNull()
      .references(() => portfolioPhotoCommands.commandId, {
        onDelete: "restrict",
      }),
    attachedAt: timestamp("attached_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("portfolio_photo_attachments_media_key").on(table.mediaAssetId),
    unique("portfolio_photo_attachments_command_key").on(table.attachCommandId),
  ],
);

export const portfolioPhotoRevisions = pgTable(
  "portfolio_photo_revisions",
  {
    eventId: uuid("event_id").primaryKey(),
    commandId: uuid("command_id")
      .notNull()
      .references(() => portfolioPhotoCommands.commandId, {
        onDelete: "restrict",
      }),
    portfolioProjectId: uuid("portfolio_project_id")
      .notNull()
      .references(() => portfolioProjectPhotoSets.portfolioProjectId, {
        onDelete: "restrict",
      }),
    revision: integer("revision").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    createdTransactionId: bigint("created_transaction_id", {
      mode: "number",
    }).notNull(),
  },
  (table) => [
    unique("portfolio_photo_revisions_command_key").on(table.commandId),
    unique("portfolio_photo_revisions_project_revision_key").on(
      table.portfolioProjectId,
      table.revision,
    ),
    index("portfolio_photo_revisions_project_idx").on(
      table.portfolioProjectId,
      table.revision,
    ),
  ],
);

export const portfolioPhotoRevisionItems = pgTable(
  "portfolio_photo_revision_items",
  {
    revisionEventId: uuid("revision_event_id")
      .notNull()
      .references(() => portfolioPhotoRevisions.eventId, {
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
    state: portfolioPhotoStateEnum("state").notNull(),
    phase: portfolioPhotoPhaseEnum("phase").notNull(),
    displayOrder: integer("display_order"),
    capturedAt: timestamp("captured_at", { mode: "date", withTimezone: true }),
    canonicalWidth: integer("canonical_width").notNull(),
    canonicalHeight: integer("canonical_height").notNull(),
    createdTransactionId: bigint("created_transaction_id", {
      mode: "number",
    }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.revisionEventId, table.attachmentId] }),
    unique("portfolio_photo_revision_items_order_key").on(
      table.revisionEventId,
      table.displayOrder,
    ),
    index("portfolio_photo_revision_items_attachment_idx").on(
      table.attachmentId,
      table.revisionEventId,
    ),
  ],
);

export type PortfolioProjectPhotoSetRecord =
  typeof portfolioProjectPhotoSets.$inferSelect;
export type PortfolioPhotoCommandRecord =
  typeof portfolioPhotoCommands.$inferSelect;
export type PortfolioPhotoAttachmentRecord =
  typeof portfolioPhotoAttachments.$inferSelect;
export type PortfolioPhotoRevisionRecord =
  typeof portfolioPhotoRevisions.$inferSelect;
export type PortfolioPhotoRevisionItemRecord =
  typeof portfolioPhotoRevisionItems.$inferSelect;

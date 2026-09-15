import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { customerProfiles } from "./customer-profile.js";
import { jobRequests } from "./job-request.js";
import { users } from "./user.js";

export const jobRequestMaterialChangeCategory = pgEnum(
  "job_request_material_change_category",
  [
    "ATTACHMENTS",
    "BUDGET",
    "LOCATION",
    "MATERIAL_RESPONSIBILITY",
    "OTHER_REQUIREMENTS",
    "PROFESSION",
    "SCHEDULE",
    "SCOPE",
  ],
);
export const jobRequestActiveEditResult = pgEnum(
  "job_request_active_edit_result",
  ["APPLIED", "UNCHANGED"],
);

export const jobRequestActiveEditCommands = pgTable(
  "job_request_active_edit_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    jobRequestId: uuid("job_request_id")
      .notNull()
      .references(() => jobRequests.id, { onDelete: "restrict" }),
    customerProfileId: uuid("customer_profile_id")
      .notNull()
      .references(() => customerProfiles.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expectedContentRevision: integer("expected_content_revision").notNull(),
    resultingContentRevision: integer("resulting_content_revision").notNull(),
    resultingVisibleVersion: integer("resulting_visible_version").notNull(),
    sectionKey: varchar("section_key", { length: 64 }).notNull(),
    sectionSchemaVersion: integer("section_schema_version").notNull(),
    sectionPayload: jsonb("section_payload").notNull(),
    sectionPayloadFingerprint: char("section_payload_fingerprint", {
      length: 64,
    }).notNull(),
    intentFingerprint: char("intent_fingerprint", { length: 64 }).notNull(),
    resultKind: jobRequestActiveEditResult("result_kind").notNull(),
    materialChange: boolean("material_change").notNull(),
    changeCategories: jobRequestMaterialChangeCategory("change_categories")
      .array()
      .notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "job_request_active_edit_revision_shape",
      sql`${table.expectedContentRevision} > 0 AND ${table.resultingVisibleVersion} > 0`,
    ),
  ],
);

export const jobRequestActiveContentRevisions = pgTable(
  "job_request_active_content_revisions",
  {
    jobRequestId: uuid("job_request_id")
      .notNull()
      .references(() => jobRequests.id, { onDelete: "restrict" }),
    contentRevision: integer("content_revision").notNull(),
    visibleVersion: integer("visible_version").notNull(),
    sourceRequestRevision: integer("source_request_revision").notNull(),
    commandId: uuid("command_id").references(
      () => jobRequestActiveEditCommands.commandId,
      { onDelete: "restrict" },
    ),
    materialChange: boolean("material_change").notNull(),
    changeCategories: jobRequestMaterialChangeCategory("change_categories")
      .array()
      .notNull(),
    changedAt: timestamp("changed_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    createdTxid: bigint("created_txid", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.jobRequestId, table.contentRevision] }),
    unique("job_request_active_content_revisions_command_id_key").on(
      table.commandId,
    ),
  ],
);

export const jobRequestActiveSectionRevisions = pgTable(
  "job_request_active_section_revisions",
  {
    jobRequestId: uuid("job_request_id").notNull(),
    contentRevision: integer("content_revision").notNull(),
    commandId: uuid("command_id").references(
      () => jobRequestActiveEditCommands.commandId,
      { onDelete: "restrict" },
    ),
    sectionKey: varchar("section_key", { length: 64 }).notNull(),
    sectionSchemaVersion: integer("section_schema_version").notNull(),
    payload: jsonb("payload").notNull(),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    savedAt: timestamp("saved_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    createdTxid: bigint("created_txid", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.jobRequestId, table.contentRevision, table.sectionKey],
    }),
    unique("job_request_active_section_command_once").on(table.commandId),
  ],
);

export const JOB_REQUEST_ACTIVE_VERSION_VIEWS = Object.freeze([
  "current_job_request_active_content_versions",
  "current_job_request_active_sections",
] as const);

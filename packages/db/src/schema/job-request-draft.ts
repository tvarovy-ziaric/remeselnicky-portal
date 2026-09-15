import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { jobRequestCommands, jobRequests } from "./job-request.js";

export const jobRequestDraftSectionRevisions = pgTable(
  "job_request_draft_section_revisions",
  {
    commandId: uuid("command_id")
      .primaryKey()
      .references(() => jobRequestCommands.commandId, {
        onDelete: "restrict",
      }),
    jobRequestId: uuid("job_request_id")
      .notNull()
      .references(() => jobRequests.id, { onDelete: "restrict" }),
    requestRevision: integer("request_revision").notNull(),
    sectionKey: varchar("section_key", { length: 64 }).notNull(),
    sectionSchemaVersion: integer("section_schema_version").notNull(),
    payload: jsonb("payload").notNull(),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    savedAt: timestamp("saved_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    unique("job_request_draft_section_revision_once").on(
      table.jobRequestId,
      table.requestRevision,
    ),
    check(
      "job_request_draft_section_key_valid",
      sql`${table.sectionKey} ~ '^[a-z][a-z0-9._-]{0,63}$'`,
    ),
    check(
      "job_request_draft_section_schema_version_valid",
      sql`${table.sectionSchemaVersion} BETWEEN 1 AND 65535`,
    ),
    check(
      "job_request_draft_payload_object",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    check(
      "job_request_draft_payload_bytes_bounded",
      sql`octet_length(${table.payload}::text) <= 34816`,
    ),
    check(
      "job_request_draft_payload_fingerprint_sha256",
      sql`${table.payloadFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    index("job_request_draft_section_history_idx").on(
      table.jobRequestId,
      table.sectionKey,
      table.requestRevision,
    ),
  ],
);

export type JobRequestDraftSectionRevisionRecord =
  typeof jobRequestDraftSectionRevisions.$inferSelect;

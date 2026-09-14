import { sql } from "drizzle-orm";
import {
  check,
  char,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { customerProfiles } from "./customer-profile.js";
import { users } from "./user.js";

export const jobRequestState = pgEnum("job_request_state", ["DRAFT", "ACTIVE"]);
export const jobRequestCommandKind = pgEnum("job_request_command_kind", [
  "CREATE_DRAFT",
  "ACTIVATE",
]);
export const jobRequestSubmissionRequirement = pgEnum(
  "job_request_submission_requirement",
  ["PRIMARY_PROFESSION", "DESCRIPTION", "MUNICIPALITY"],
);

export const jobRequests = pgTable(
  "job_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerProfileId: uuid("customer_profile_id")
      .notNull()
      .references(() => customerProfiles.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("job_requests_customer_created_idx").on(
      table.customerProfileId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const jobRequestCommands = pgTable(
  "job_request_commands",
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
    commandKind: jobRequestCommandKind("command_kind").notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    resultingRevision: integer("resulting_revision").notNull(),
    targetState: jobRequestState("target_state").notNull(),
    submissionEligibilityRevision: integer("submission_eligibility_revision"),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "job_request_commands_revisions_valid",
      sql`${table.expectedRevision} >= 0 AND ${table.resultingRevision} = ${table.expectedRevision} + 1`,
    ),
    check(
      "job_request_commands_kind_state_valid",
      sql`(${table.commandKind} = 'CREATE_DRAFT'
          AND ${table.expectedRevision} = 0
          AND ${table.resultingRevision} = 1
          AND ${table.targetState} = 'DRAFT'
          AND ${table.submissionEligibilityRevision} IS NULL)
        OR (${table.commandKind} = 'ACTIVATE'
          AND ${table.expectedRevision} > 0
          AND ${table.targetState} = 'ACTIVE'
          AND ${table.submissionEligibilityRevision} = ${table.expectedRevision})`,
    ),
    check(
      "job_request_commands_fingerprint_sha256",
      sql`${table.payloadFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    index("job_request_commands_request_history_idx").on(
      table.jobRequestId,
      table.createdAt,
      table.commandId,
    ),
    index("job_request_commands_customer_history_idx").on(
      table.customerProfileId,
      table.createdAt,
      table.commandId,
    ),
  ],
);

export const jobRequestRevisions = pgTable(
  "job_request_revisions",
  {
    jobRequestId: uuid("job_request_id")
      .notNull()
      .references(() => jobRequests.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    commandId: uuid("command_id")
      .notNull()
      .references(() => jobRequestCommands.commandId, { onDelete: "restrict" }),
    state: jobRequestState("state").notNull(),
    changedAt: timestamp("changed_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    activatedAt: timestamp("activated_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (table) => [
    primaryKey({ columns: [table.jobRequestId, table.revision] }),
    unique("job_request_revisions_command_id_key").on(table.commandId),
    check("job_request_revisions_positive", sql`${table.revision} > 0`),
    check(
      "job_request_revisions_activation_consistent",
      sql`(${table.state} = 'DRAFT' AND ${table.activatedAt} IS NULL)
        OR (${table.state} = 'ACTIVE' AND ${table.activatedAt} IS NOT NULL)`,
    ),
  ],
);

export type JobRequestRecord = typeof jobRequests.$inferSelect;
export type JobRequestRevisionRecord = typeof jobRequestRevisions.$inferSelect;

import { sql } from "drizzle-orm";
import {
  boolean,
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
  varchar,
} from "drizzle-orm/pg-core";

import { craftsmanProfiles } from "./craftsman-profile.js";
import { customerProfiles } from "./customer-profile.js";
import { jobRequests } from "./job-request.js";
import { users } from "./user.js";

export const jobInvitationState = pgEnum("job_invitation_state", [
  "PENDING",
  "ENGAGED",
  "DECLINED",
  "EXPIRED",
  "WITHDRAWN",
  "NOT_SELECTED",
]);
export const jobInvitationCommandKind = pgEnum("job_invitation_command_kind", [
  "SEND",
  "ENGAGE",
  "DECLINE",
  "CUSTOMER_WITHDRAW",
  "CUSTOMER_STOP",
  "CRAFTSMAN_WITHDRAW",
  "EXPIRE",
  "REQUEST_CLOSED",
  "NOT_SELECT",
]);
export const jobInvitationDeclineReason = pgEnum(
  "job_invitation_decline_reason",
  ["NO_CAPACITY", "NOT_MY_WORK", "OTHER", "TIMING", "TOO_FAR"],
);

export const jobInvitations = pgTable(
  "job_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobRequestId: uuid("job_request_id")
      .notNull()
      .references(() => jobRequests.id, { onDelete: "restrict" }),
    customerProfileId: uuid("customer_profile_id")
      .notNull()
      .references(() => customerProfiles.id, { onDelete: "restrict" }),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    requestContentRevision: integer("request_content_revision").notNull(),
    requestVisibleVersion: integer("request_visible_version").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("job_invitations_pair_once").on(
      table.jobRequestId,
      table.craftsmanProfileId,
    ),
    check(
      "job_invitations_version_positive",
      sql`${table.requestContentRevision} > 0 AND ${table.requestVisibleVersion} > 0`,
    ),
    index("job_invitations_customer_idx").on(
      table.customerProfileId,
      table.createdAt,
      table.id,
    ),
    index("job_invitations_craftsman_idx").on(
      table.craftsmanProfileId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const jobInvitationCommands = pgTable(
  "job_invitation_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    invitationId: uuid("invitation_id")
      .notNull()
      .references(() => jobInvitations.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    commandKind: jobInvitationCommandKind("command_kind").notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    resultingRevision: integer("resulting_revision").notNull(),
    targetState: jobInvitationState("target_state").notNull(),
    systemInitiated: boolean("system_initiated").notNull().default(false),
    declineReason: jobInvitationDeclineReason("decline_reason"),
    declineNote: varchar("decline_note", { length: 500 }),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "job_invitation_commands_revision_shape",
      sql`${table.expectedRevision} >= 0 AND ${table.resultingRevision} = ${table.expectedRevision} + 1`,
    ),
    check(
      "job_invitation_commands_fingerprint_sha256",
      sql`${table.payloadFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    index("job_invitation_commands_history_idx").on(
      table.invitationId,
      table.resultingRevision,
      table.commandId,
    ),
  ],
);

export const jobInvitationRevisions = pgTable(
  "job_invitation_revisions",
  {
    invitationId: uuid("invitation_id")
      .notNull()
      .references(() => jobInvitations.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    commandId: uuid("command_id")
      .notNull()
      .references(() => jobInvitationCommands.commandId, {
        onDelete: "restrict",
      }),
    state: jobInvitationState("state").notNull(),
    changedAt: timestamp("changed_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    sentAt: timestamp("sent_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    engagedAt: timestamp("engaged_at", { mode: "date", withTimezone: true }),
    declineReason: jobInvitationDeclineReason("decline_reason"),
    declineNote: varchar("decline_note", { length: 500 }),
  },
  (table) => [
    primaryKey({ columns: [table.invitationId, table.revision] }),
    unique("job_invitation_revisions_command_id_key").on(table.commandId),
  ],
);

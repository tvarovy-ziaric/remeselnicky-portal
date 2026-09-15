import {
  bigint,
  boolean,
  char,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { conversations } from "./conversation.js";
import { users } from "./user.js";

export const CONVERSATION_JOB_MEDIA_CANDIDATE_VIEW =
  "conversation_job_media_candidates" as const;

export const conversationTimelineEntryKind = pgEnum(
  "conversation_timeline_entry_kind",
  ["HUMAN_MESSAGE", "SYSTEM_EVENT"],
);
export const conversationSystemEvent = pgEnum("conversation_system_event", [
  "ENGAGEMENT",
]);
export const conversationParticipantAction = pgEnum(
  "conversation_participant_action",
  ["MARK_READ", "ARCHIVE", "UNARCHIVE", "MUTE", "UNMUTE"],
);
export const conversationReportReason = pgEnum("conversation_report_reason", [
  "ABUSE",
  "CONTACT_CIRCUMVENTION",
  "FRAUD_OR_SCAM",
  "THREAT",
  "OTHER",
]);

export const conversationMessageCommands = pgTable(
  "conversation_message_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    replyToMessageId: uuid("reply_to_message_id"),
    resultingMessageId: uuid("resulting_message_id").notNull(),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    unique("conversation_message_commands_resulting_message_id_key").on(
      table.resultingMessageId,
    ),
  ],
);

export const conversationTimelineEntries = pgTable(
  "conversation_timeline_entries",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "restrict" }),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    entryKind: conversationTimelineEntryKind("entry_kind").notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    body: text("body"),
    replyToMessageId: uuid("reply_to_message_id"),
    messageCommandId: uuid("message_command_id").references(
      () => conversationMessageCommands.commandId,
      { onDelete: "restrict" },
    ),
    systemEvent: conversationSystemEvent("system_event"),
    sourceInvitationId: uuid("source_invitation_id"),
    sourceInvitationRevision: integer("source_invitation_revision"),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    unique("conversation_timeline_entries_conversation_id_sequence_key").on(
      table.conversationId,
      table.sequence,
    ),
    unique("conversation_timeline_entries_message_command_id_key").on(
      table.messageCommandId,
    ),
    index("conversation_timeline_entries_page_idx").on(
      table.conversationId,
      table.sequence,
    ),
  ],
);

export const conversationParticipantStateCommands = pgTable(
  "conversation_participant_state_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    action: conversationParticipantAction("action").notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    resultingRevision: integer("resulting_revision").notNull(),
    readThroughSequence: bigint("read_through_sequence", { mode: "number" }),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
  },
);

export const conversationParticipantStateRevisions = pgTable(
  "conversation_participant_state_revisions",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    commandId: uuid("command_id")
      .notNull()
      .references(() => conversationParticipantStateCommands.commandId, {
        onDelete: "restrict",
      }),
    lastReadSequence: bigint("last_read_sequence", {
      mode: "number",
    }).notNull(),
    lastReadAt: timestamp("last_read_at", {
      mode: "date",
      withTimezone: true,
    }),
    archived: boolean("archived").notNull(),
    muted: boolean("muted").notNull(),
    changedAt: timestamp("changed_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.conversationId, table.actorUserId, table.revision],
    }),
    unique("conversation_participant_state_revisions_command_id_key").on(
      table.commandId,
    ),
  ],
);

export const conversationReports = pgTable(
  "conversation_reports",
  {
    id: uuid("id").primaryKey(),
    commandId: uuid("command_id").notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "restrict" }),
    reporterUserId: uuid("reporter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    messageId: uuid("message_id"),
    reason: conversationReportReason("reason").notNull(),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    unique("conversation_reports_command_id_key").on(table.commandId),
  ],
);

export type ConversationTimelineEntryRecord =
  typeof conversationTimelineEntries.$inferSelect;
export type ConversationParticipantStateRevisionRecord =
  typeof conversationParticipantStateRevisions.$inferSelect;
export type ConversationReportRecord = typeof conversationReports.$inferSelect;

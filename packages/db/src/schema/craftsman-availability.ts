import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  CRAFTSMAN_AVAILABILITY_BLOCK_STATES,
  CRAFTSMAN_AVAILABILITY_STATES,
} from "@portal/domain";

import { craftsmanProfiles } from "./craftsman-profile.js";
import { users } from "./user.js";

export const CRAFTSMAN_AVAILABILITY_COMMAND_KINDS = [
  "ADD",
  "REPLACE",
  "ARCHIVE",
] as const;
export const CRAFTSMAN_AVAILABILITY_COMMAND_RESULTS = [
  "APPLIED",
  "UNCHANGED",
] as const;

export const craftsmanAvailabilityStateEnum = pgEnum(
  "craftsman_availability_state",
  CRAFTSMAN_AVAILABILITY_STATES,
);
export const craftsmanAvailabilityBlockStateEnum = pgEnum(
  "craftsman_availability_block_state",
  CRAFTSMAN_AVAILABILITY_BLOCK_STATES,
);
export const craftsmanAvailabilityCommandKindEnum = pgEnum(
  "craftsman_availability_command_kind",
  CRAFTSMAN_AVAILABILITY_COMMAND_KINDS,
);
export const craftsmanAvailabilityCommandResultEnum = pgEnum(
  "craftsman_availability_command_result",
  CRAFTSMAN_AVAILABILITY_COMMAND_RESULTS,
);

export const craftsmanAvailabilityCommands = pgTable(
  "craftsman_availability_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    commandKind: craftsmanAvailabilityCommandKindEnum("command_kind").notNull(),
    blockId: uuid("block_id").notNull(),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expectedRevision: integer("expected_revision").notNull(),
    resultKind: craftsmanAvailabilityCommandResultEnum("result_kind").notNull(),
    resultingRevision: integer("resulting_revision").notNull(),
    targetState: craftsmanAvailabilityBlockStateEnum("target_state").notNull(),
    availability: craftsmanAvailabilityStateEnum("availability").notNull(),
    startsAt: timestamp("starts_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    endsAt: timestamp("ends_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("craftsman_availability_commands_block_created_idx").on(
      table.blockId,
      table.createdAt,
    ),
    index("craftsman_availability_commands_profile_created_idx").on(
      table.craftsmanProfileId,
      table.createdAt,
    ),
    check(
      "craftsman_availability_commands_expected_revision_nonnegative",
      sql`${table.expectedRevision} >= 0`,
    ),
    check(
      "craftsman_availability_commands_resulting_revision_positive",
      sql`${table.resultingRevision} > 0`,
    ),
  ],
);

export const craftsmanAvailabilityRevisions = pgTable(
  "craftsman_availability_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    blockId: uuid("block_id").notNull(),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    commandId: uuid("command_id")
      .notNull()
      .unique()
      .references(() => craftsmanAvailabilityCommands.commandId, {
        onDelete: "restrict",
      }),
    revision: integer("revision").notNull(),
    state: craftsmanAvailabilityBlockStateEnum("state").notNull(),
    availability: craftsmanAvailabilityStateEnum("availability").notNull(),
    startsAt: timestamp("starts_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    endsAt: timestamp("ends_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    changedAt: timestamp("changed_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    unique("craftsman_availability_revisions_block_revision_key").on(
      table.blockId,
      table.revision,
    ),
    index("craftsman_availability_revisions_profile_range_idx").on(
      table.craftsmanProfileId,
      table.startsAt,
      table.endsAt,
    ),
    check(
      "craftsman_availability_revisions_revision_positive",
      sql`${table.revision} > 0`,
    ),
  ],
);

export type CraftsmanAvailabilityCommandRecord =
  typeof craftsmanAvailabilityCommands.$inferSelect;
export type CraftsmanAvailabilityRevisionRecord =
  typeof craftsmanAvailabilityRevisions.$inferSelect;

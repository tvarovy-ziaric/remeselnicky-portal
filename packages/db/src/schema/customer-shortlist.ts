import { sql } from "drizzle-orm";
import {
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

import { craftsmanProfiles } from "./craftsman-profile.js";
import { customerProfiles } from "./customer-profile.js";
import { users } from "./user.js";

export const CUSTOMER_SHORTLIST_STATES = ["ACTIVE", "REMOVED"] as const;
export const CUSTOMER_SHORTLIST_COMMAND_KINDS = ["ADD", "REMOVE"] as const;
export const CUSTOMER_SHORTLIST_COMMAND_RESULTS = [
  "APPLIED",
  "UNCHANGED",
] as const;

export const customerShortlistStateEnum = pgEnum(
  "customer_shortlist_state",
  CUSTOMER_SHORTLIST_STATES,
);
export const customerShortlistCommandKindEnum = pgEnum(
  "customer_shortlist_command_kind",
  CUSTOMER_SHORTLIST_COMMAND_KINDS,
);
export const customerShortlistCommandResultEnum = pgEnum(
  "customer_shortlist_command_result",
  CUSTOMER_SHORTLIST_COMMAND_RESULTS,
);

export const customerShortlistCommands = pgTable(
  "customer_shortlist_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    customerProfileId: uuid("customer_profile_id")
      .notNull()
      .references(() => customerProfiles.id, { onDelete: "restrict" }),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    commandKind: customerShortlistCommandKindEnum("command_kind").notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    resultKind: customerShortlistCommandResultEnum("result_kind").notNull(),
    resultingRevision: integer("resulting_revision").notNull(),
    targetState: customerShortlistStateEnum("target_state").notNull(),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("customer_shortlist_commands_customer_history_idx").on(
      table.customerProfileId,
      table.createdAt,
      table.commandId,
    ),
    index("customer_shortlist_commands_craftsman_reference_idx").on(
      table.craftsmanProfileId,
    ),
    check(
      "customer_shortlist_commands_revisions_valid",
      sql`${table.expectedRevision} >= 0 AND ${table.resultingRevision} >= 0`,
    ),
  ],
);

export const customerShortlistEffects = pgTable(
  "customer_shortlist_effects",
  {
    commandId: uuid("command_id")
      .primaryKey()
      .references(() => customerShortlistCommands.commandId, {
        onDelete: "restrict",
      }),
    customerProfileId: uuid("customer_profile_id")
      .notNull()
      .references(() => customerProfiles.id, { onDelete: "restrict" }),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    state: customerShortlistStateEnum("state").notNull(),
    changedAt: timestamp("changed_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    unique("customer_shortlist_effects_pair_revision_key").on(
      table.customerProfileId,
      table.craftsmanProfileId,
      table.revision,
    ),
    index("customer_shortlist_effects_craftsman_reference_idx").on(
      table.craftsmanProfileId,
    ),
  ],
);

export const customerShortlistEntries = pgTable(
  "customer_shortlist_entries",
  {
    customerProfileId: uuid("customer_profile_id")
      .notNull()
      .references(() => customerProfiles.id, { onDelete: "restrict" }),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    state: customerShortlistStateEnum("state").notNull(),
    revision: integer("revision").notNull(),
    latestCommandId: uuid("latest_command_id")
      .notNull()
      .references(() => customerShortlistEffects.commandId, {
        onDelete: "restrict",
      }),
    activeSince: timestamp("active_since", {
      mode: "date",
      withTimezone: true,
    }),
    changedAt: timestamp("changed_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.customerProfileId, table.craftsmanProfileId],
    }),
    unique("customer_shortlist_entries_latest_command_key").on(
      table.latestCommandId,
    ),
    index("customer_shortlist_entries_owner_active_idx")
      .on(
        table.customerProfileId,
        table.changedAt.desc(),
        table.craftsmanProfileId,
      )
      .where(sql`${table.state} = 'ACTIVE'`),
    index("customer_shortlist_entries_craftsman_reference_idx").on(
      table.craftsmanProfileId,
    ),
  ],
);

export type CustomerShortlistCommandRecord =
  typeof customerShortlistCommands.$inferSelect;
export type CustomerShortlistEffectRecord =
  typeof customerShortlistEffects.$inferSelect;
export type CustomerShortlistEntryRecord =
  typeof customerShortlistEntries.$inferSelect;

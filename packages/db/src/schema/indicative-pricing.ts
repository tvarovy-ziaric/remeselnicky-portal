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
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  INDICATIVE_PRICE_MODES,
  INDICATIVE_PRICING_ENTRY_STATES,
} from "@portal/domain";

import { craftsmanProfessions } from "./craftsman-profession.js";
import { craftsmanProfiles } from "./craftsman-profile.js";
import { users } from "./user.js";

export const INDICATIVE_PRICING_COMMAND_KINDS = Object.freeze([
  "ADD",
  "EDIT",
  "ARCHIVE",
] as const);

export const indicativePriceModeEnum = pgEnum(
  "indicative_price_mode",
  INDICATIVE_PRICE_MODES,
);
export const indicativePricingEntryStateEnum = pgEnum(
  "indicative_pricing_entry_state",
  INDICATIVE_PRICING_ENTRY_STATES,
);
export const indicativePricingCommandKindEnum = pgEnum(
  "indicative_pricing_command_kind",
  INDICATIVE_PRICING_COMMAND_KINDS,
);

export const indicativePricingEntries = pgTable(
  "indicative_pricing_entries",
  {
    id: uuid("id").primaryKey(),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id),
    craftsmanProfessionId: uuid("craftsman_profession_id").references(
      () => craftsmanProfessions.id,
    ),
    serviceName: text("service_name").notNull(),
    priceMode: indicativePriceModeEnum("price_mode").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("EUR"),
    note: text("note"),
    state: indicativePricingEntryStateEnum("state").notNull().default("ACTIVE"),
    revision: integer("revision").notNull().default(1),
    // The migration adds the circular FK to indicative_pricing_commands.
    latestCommandId: uuid("latest_command_id").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id")
      .notNull()
      .references(() => users.id),
    archivedByUserId: uuid("archived_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (table) => [
    index("indicative_pricing_entries_profile_order_idx").on(
      table.craftsmanProfileId,
      table.createdAt,
      table.id,
    ),
    index("indicative_pricing_entries_active_profile_order_idx")
      .on(table.craftsmanProfileId, table.createdAt, table.id)
      .where(sql`${table.state} = 'ACTIVE'`),
    check(
      "indicative_pricing_amount_positive_safe_integer",
      sql`${table.amountCents} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "indicative_pricing_currency_eur_only",
      sql`${table.currency} = 'EUR'`,
    ),
    check("indicative_pricing_revision_positive", sql`${table.revision} > 0`),
  ],
);

export const indicativePricingCommands = pgTable(
  "indicative_pricing_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    commandKind: indicativePricingCommandKindEnum("command_kind").notNull(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => indicativePricingEntries.id),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("indicative_pricing_commands_entry_history_idx").on(
      table.entryId,
      table.occurredAt,
      table.commandId,
    ),
    check(
      "indicative_pricing_command_fingerprint_safe",
      sql`${table.payloadFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const indicativePricingEntryRevisions = pgTable(
  "indicative_pricing_entry_revisions",
  {
    entryId: uuid("entry_id")
      .notNull()
      .references(() => indicativePricingEntries.id),
    revision: integer("revision").notNull(),
    commandId: uuid("command_id")
      .notNull()
      .references(() => indicativePricingCommands.commandId),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id),
    craftsmanProfessionId: uuid("craftsman_profession_id").references(
      () => craftsmanProfessions.id,
    ),
    serviceName: text("service_name").notNull(),
    priceMode: indicativePriceModeEnum("price_mode").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    note: text("note"),
    state: indicativePricingEntryStateEnum("state").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (table) => [
    unique("indicative_pricing_entry_revisions_command_id_key").on(
      table.commandId,
    ),
    primaryKey({
      columns: [table.entryId, table.revision],
      name: "indicative_pricing_entry_revisions_pkey",
    }),
  ],
);

export type IndicativePricingEntryRecord =
  typeof indicativePricingEntries.$inferSelect;
export type IndicativePricingCommandRecord =
  typeof indicativePricingCommands.$inferSelect;
export type IndicativePricingEntryRevisionRecord =
  typeof indicativePricingEntryRevisions.$inferSelect;

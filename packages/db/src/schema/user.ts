import { sql } from "drizzle-orm";
import { check, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

export const USER_ACCOUNT_STATE_VALUES = [
  "ACTIVE",
  "SUSPENDED",
  "DEACTIVATED",
] as const;

export const userAccountStateEnum = pgEnum(
  "user_account_state",
  USER_ACCOUNT_STATE_VALUES,
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountState: userAccountStateEnum("account_state")
      .notNull()
      .default("ACTIVE"),
    accountStateChangedAt: timestamp("account_state_changed_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "users_state_change_not_before_creation",
      sql`${table.accountStateChangedAt} >= ${table.createdAt}`,
    ),
    check(
      "users_update_not_before_state_change",
      sql`${table.updatedAt} >= ${table.accountStateChangedAt}`,
    ),
  ],
);

export type UserRecord = typeof users.$inferSelect;
export type NewUserRecord = typeof users.$inferInsert;

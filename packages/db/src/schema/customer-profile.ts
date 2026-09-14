import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./user.js";

export const customerProfiles = pgTable(
  "customer_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    isPublic: boolean("is_public").notNull().default(false),
    isIndexable: boolean("is_indexable").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("customer_profiles_owner_user_id_key").on(table.ownerUserId),
    check("customer_profiles_never_public", sql`NOT ${table.isPublic}`),
    check("customer_profiles_never_indexable", sql`NOT ${table.isIndexable}`),
    check(
      "customer_profiles_update_not_before_creation",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export type CustomerProfileRecord = typeof customerProfiles.$inferSelect;
export type NewCustomerProfileRecord = typeof customerProfiles.$inferInsert;

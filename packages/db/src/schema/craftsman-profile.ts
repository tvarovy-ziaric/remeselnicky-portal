import { sql } from "drizzle-orm";
import {
  char,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./user.js";

export const CRAFTSMAN_PROFILE_TYPE_VALUES = ["INDIVIDUAL", "COMPANY"] as const;

export const craftsmanProfileTypeEnum = pgEnum(
  "craftsman_profile_type",
  CRAFTSMAN_PROFILE_TYPE_VALUES,
);

export const craftsmanProfiles = pgTable(
  "craftsman_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    profileType: craftsmanProfileTypeEnum("profile_type").notNull(),
    realFirstName: text("real_first_name"),
    realLastName: text("real_last_name"),
    nickname: text("nickname"),
    officialCompanyName: text("official_company_name"),
    companyRegistrationNumber: char("company_registration_number", {
      length: 8,
    }),
    about: text("about"),
    identityVerifiedAt: timestamp("identity_verified_at", {
      mode: "date",
      withTimezone: true,
    }),
    identityVerificationReference: text("identity_verification_reference"),
    companyRegistrationVerifiedAt: timestamp(
      "company_registration_verified_at",
      { mode: "date", withTimezone: true },
    ),
    companyRegistrationVerificationReference: text(
      "company_registration_verification_reference",
    ),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("craftsman_profiles_owner_user_id_key").on(table.ownerUserId),
    check("craftsman_profiles_revision_positive", sql`${table.revision} > 0`),
    check(
      "craftsman_profiles_timestamps_ordered",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      "craftsman_profiles_individual_identity_paired",
      sql`(${table.realFirstName} IS NULL) = (${table.realLastName} IS NULL)`,
    ),
    check(
      "craftsman_profiles_fields_match_type",
      sql`(
        ${table.profileType} = 'INDIVIDUAL'
        AND ${table.officialCompanyName} IS NULL
        AND ${table.companyRegistrationNumber} IS NULL
        AND ${table.companyRegistrationVerifiedAt} IS NULL
        AND ${table.companyRegistrationVerificationReference} IS NULL
      ) OR (
        ${table.profileType} = 'COMPANY'
        AND ${table.realFirstName} IS NULL
        AND ${table.realLastName} IS NULL
        AND ${table.nickname} IS NULL
      )`,
    ),
    check(
      "craftsman_profiles_about_safe",
      sql`${table.about} IS NULL OR (
        ${table.about} = btrim(${table.about})
        AND length(${table.about}) BETWEEN 1 AND 2000
        AND ${table.about} !~ E'[\\x01-\\x09\\x0B-\\x1F\\x7F]'
      )`,
    ),
  ],
);

export type CraftsmanProfileRecord = typeof craftsmanProfiles.$inferSelect;
export type NewCraftsmanProfileRecord = typeof craftsmanProfiles.$inferInsert;

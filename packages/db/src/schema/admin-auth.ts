import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  ADMIN_MFA_FACTOR_KIND_VALUES,
  ADMIN_MFA_PURPOSE_VALUES,
  ADMIN_ROLE_VALUES,
} from "@portal/admin-auth";

import { authSessions } from "./auth.js";
import { users } from "./user.js";

const timestampWithTimezone = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const adminRoleEnum = pgEnum("admin_role", ADMIN_ROLE_VALUES);
export const adminMfaFactorKindEnum = pgEnum(
  "admin_mfa_factor_kind",
  ADMIN_MFA_FACTOR_KIND_VALUES,
);
export const adminMfaPurposeEnum = pgEnum(
  "admin_mfa_purpose",
  ADMIN_MFA_PURPOSE_VALUES,
);

export const adminRoleGrants = pgTable(
  "admin_role_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: adminRoleEnum("role").notNull(),
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id),
    grantSource: text("grant_source").notNull(),
    reason: text("reason").notNull(),
    grantedAt: timestampWithTimezone("granted_at").notNull().defaultNow(),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id),
    revokedAt: timestampWithTimezone("revoked_at"),
  },
  (table) => [
    check(
      "admin_role_grants_source_valid",
      sql`(${table.grantSource} = 'ADMIN_COMMAND' AND ${table.grantedByUserId} IS NOT NULL)
        OR (${table.grantSource} = 'BOOTSTRAP' AND ${table.grantedByUserId} IS NULL)`,
    ),
    check(
      "admin_role_grants_reason_bounded",
      sql`length(btrim(${table.reason})) BETWEEN 8 AND 500`,
    ),
    uniqueIndex("admin_role_grants_active_role_idx")
      .on(table.userId, table.role)
      .where(sql`${table.revokedAt} IS NULL`),
    index("admin_role_grants_active_user_idx")
      .on(table.userId, table.grantedAt)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const adminMfaFactors = pgTable(
  "admin_mfa_factors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: adminMfaFactorKindEnum("kind").notNull(),
    credentialReference: text("credential_reference").notNull(),
    displayLabel: text("display_label"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    activatedAt: timestampWithTimezone("activated_at").notNull().defaultNow(),
    revokedAt: timestampWithTimezone("revoked_at"),
  },
  (table) => [
    check(
      "admin_mfa_factors_reference_bounded",
      sql`${table.credentialReference} ~ '^[A-Za-z][A-Za-z0-9.-]{1,31}:[A-Za-z0-9/][A-Za-z0-9._:/-]{0,223}$'`,
    ),
    uniqueIndex("admin_mfa_factors_active_reference_idx")
      .on(table.credentialReference)
      .where(sql`${table.revokedAt} IS NULL`),
    index("admin_mfa_factors_active_user_idx")
      .on(table.userId, table.activatedAt)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const adminMfaChallenges = pgTable(
  "admin_mfa_challenges",
  {
    challengeDigest: char("challenge_digest", { length: 64 }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    factorId: uuid("factor_id")
      .notNull()
      .references(() => adminMfaFactors.id),
    purpose: adminMfaPurposeEnum("purpose").notNull(),
    providerStateReference: text("provider_state_reference"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    expiresAt: timestampWithTimezone("expires_at").notNull(),
    claimedAt: timestampWithTimezone("claimed_at"),
    verifiedAt: timestampWithTimezone("verified_at"),
  },
  (table) => [
    check(
      "admin_mfa_challenges_digest_is_sha256",
      sql`${table.challengeDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "admin_mfa_challenges_provider_state_bounded",
      sql`${table.providerStateReference} IS NULL
        OR ${table.providerStateReference} ~ '^[A-Za-z][A-Za-z0-9.-]{1,31}:[A-Za-z0-9/][A-Za-z0-9._:/-]{0,223}$'`,
    ),
    index("admin_mfa_challenges_expiry_idx").on(table.expiresAt),
  ],
);

export const adminPrivilegedSessions = pgTable(
  "admin_privileged_sessions",
  {
    sessionIdHash: char("session_id_hash", { length: 64 })
      .primaryKey()
      .references(() => authSessions.sessionIdHash, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    mfaFactorId: uuid("mfa_factor_id")
      .notNull()
      .references(() => adminMfaFactors.id),
    mfaAuthenticatedAt: timestampWithTimezone("mfa_authenticated_at").notNull(),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    expiresAt: timestampWithTimezone("expires_at").notNull(),
    revokedAt: timestampWithTimezone("revoked_at"),
  },
  (table) => [
    check(
      "admin_privileged_sessions_digest_is_sha256",
      sql`${table.sessionIdHash} ~ '^[0-9a-f]{64}$'`,
    ),
    index("admin_privileged_sessions_active_user_idx")
      .on(table.userId, table.expiresAt)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const adminRoleChangeEvents = pgTable("admin_role_change_events", {
  eventId: uuid("event_id").primaryKey(),
  actorUserId: uuid("actor_user_id")
    .notNull()
    .references(() => users.id),
  targetUserId: uuid("target_user_id")
    .notNull()
    .references(() => users.id),
  action: text("action").notNull(),
  role: adminRoleEnum("role").notNull(),
  reason: text("reason").notNull(),
  occurredAt: timestampWithTimezone("occurred_at").notNull().defaultNow(),
});

export type AdminRoleGrantRecord = typeof adminRoleGrants.$inferSelect;
export type AdminMfaFactorRecord = typeof adminMfaFactors.$inferSelect;
export type AdminMfaChallengeRecord = typeof adminMfaChallenges.$inferSelect;
export type AdminPrivilegedSessionRecord =
  typeof adminPrivilegedSessions.$inferSelect;
export type AdminRoleChangeEventRecord =
  typeof adminRoleChangeEvents.$inferSelect;

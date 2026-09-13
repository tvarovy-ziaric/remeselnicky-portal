import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./user.js";

export type AuthSessionJsonValue =
  | null
  | string
  | number
  | boolean
  | readonly AuthSessionJsonValue[]
  | { readonly [key: string]: AuthSessionJsonValue | undefined };

export type AuthSessionPayload = Readonly<
  Record<string, AuthSessionJsonValue | undefined>
>;

const timestampWithTimezone = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const authCredentials = pgTable(
  "auth_credentials",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "restrict" }),
    normalizedEmail: text("normalized_email").notNull(),
    passwordHash: text("password_hash").notNull(),
    adultAttestedAt: timestampWithTimezone("adult_attested_at")
      .notNull()
      .defaultNow(),
    passwordChangedAt: timestampWithTimezone("password_changed_at")
      .notNull()
      .defaultNow(),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("auth_credentials_normalized_email_unique").on(
      table.normalizedEmail,
    ),
    check(
      "auth_credentials_normalized_email_canonical",
      sql`${table.normalizedEmail} = lower(btrim(${table.normalizedEmail}))
        AND length(${table.normalizedEmail}) BETWEEN 3 AND 320`,
    ),
    check(
      "auth_credentials_password_hash_bounded",
      sql`length(${table.passwordHash}) BETWEEN 20 AND 1024`,
    ),
    check(
      "auth_credentials_timestamps_ordered",
      sql`${table.adultAttestedAt} >= ${table.createdAt}
        AND ${table.passwordChangedAt} >= ${table.createdAt}
        AND ${table.updatedAt} >= ${table.passwordChangedAt}`,
    ),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    sessionIdHash: char("session_id_hash", { length: 64 }).primaryKey(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    payload: jsonb("payload").$type<AuthSessionPayload>().notNull().default({}),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    lastSeenAt: timestampWithTimezone("last_seen_at").notNull().defaultNow(),
    expiresAt: timestampWithTimezone("expires_at").notNull(),
    revokedAt: timestampWithTimezone("revoked_at"),
  },
  (table) => [
    check(
      "auth_sessions_id_is_sha256_digest",
      sql`${table.sessionIdHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "auth_sessions_payload_is_object",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    check(
      "auth_sessions_timestamps_ordered",
      sql`${table.expiresAt} > ${table.createdAt}
        AND ${table.lastSeenAt} >= ${table.createdAt}
        AND (${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt})`,
    ),
    index("auth_sessions_live_user_idx")
      .on(table.userId, table.expiresAt)
      .where(sql`${table.revokedAt} IS NULL`),
    index("auth_sessions_expiry_idx").on(table.expiresAt),
  ],
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    tokenDigest: char("token_digest", { length: 64 }).notNull(),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    expiresAt: timestampWithTimezone("expires_at").notNull(),
    consumedAt: timestampWithTimezone("consumed_at"),
    invalidatedAt: timestampWithTimezone("invalidated_at"),
  },
  (table) => [
    unique("password_reset_tokens_digest_unique").on(table.tokenDigest),
    check(
      "password_reset_tokens_digest_is_sha256",
      sql`${table.tokenDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "password_reset_tokens_timestamps_ordered",
      sql`${table.expiresAt} > ${table.createdAt}
        AND (${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.createdAt})
        AND (${table.invalidatedAt} IS NULL OR ${table.invalidatedAt} >= ${table.createdAt})`,
    ),
    check(
      "password_reset_tokens_one_terminal_state",
      sql`num_nonnulls(${table.consumedAt}, ${table.invalidatedAt}) <= 1`,
    ),
    uniqueIndex("password_reset_tokens_live_user_idx")
      .on(table.userId)
      .where(
        sql`${table.consumedAt} IS NULL AND ${table.invalidatedAt} IS NULL`,
      ),
    index("password_reset_tokens_expiry_idx").on(table.expiresAt),
  ],
);

export const authRateLimitBuckets = pgTable(
  "auth_rate_limit_buckets",
  {
    scope: text("scope").notNull(),
    keyDigest: char("key_digest", { length: 64 }).notNull(),
    windowStartedAt: timestampWithTimezone("window_started_at").notNull(),
    expiresAt: timestampWithTimezone("expires_at").notNull(),
    attemptCount: integer("attempt_count").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.keyDigest] }),
    check(
      "auth_rate_limit_scope_bounded",
      sql`length(${table.scope}) BETWEEN 1 AND 80`,
    ),
    check(
      "auth_rate_limit_key_is_sha256_digest",
      sql`${table.keyDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "auth_rate_limit_window_valid",
      sql`${table.expiresAt} > ${table.windowStartedAt}`,
    ),
    check(
      "auth_rate_limit_attempt_count_positive",
      sql`${table.attemptCount} > 0`,
    ),
    index("auth_rate_limit_buckets_expiry_idx").on(table.expiresAt),
  ],
);

export type AuthCredentialRecord = typeof authCredentials.$inferSelect;
export type NewAuthCredentialRecord = typeof authCredentials.$inferInsert;
export type AuthSessionRecord = typeof authSessions.$inferSelect;
export type NewAuthSessionRecord = typeof authSessions.$inferInsert;
export type PasswordResetTokenRecord = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetTokenRecord =
  typeof passwordResetTokens.$inferInsert;
export type AuthRateLimitBucketRecord =
  typeof authRateLimitBuckets.$inferSelect;

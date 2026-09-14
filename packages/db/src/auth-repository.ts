import type { Sql } from "postgres";

import type { AuthSessionPayload } from "./schema/auth.js";
import type { UserRecord } from "./schema/user.js";

export interface RegisterAuthUserInput {
  readonly adultAttested: true;
  readonly normalizedEmail: string;
  readonly passwordHash: string;
}

export interface AuthUser {
  readonly id: string;
  readonly accountState: UserRecord["accountState"];
  readonly adultAttestedAt: Date;
  readonly emailVerifiedAt: Date | null;
  readonly phoneVerifiedAt: Date | null;
}

export interface AuthCredential extends AuthUser {
  readonly normalizedEmail: string;
  readonly passwordHash: string;
  readonly passwordChangedAt: Date;
}

export type RegisterAuthUserResult =
  | Readonly<{ status: "CREATED"; user: AuthUser }>
  | Readonly<{ status: "DUPLICATE" }>;

export interface SaveAuthSessionInput {
  readonly sessionIdHash: string;
  readonly userId: string | null;
  readonly payload: AuthSessionPayload;
  readonly expiresAt: Date;
}

export interface PersistedAuthSession extends SaveAuthSessionInput {
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

export interface CreatePasswordResetInput {
  readonly userId: string;
  readonly tokenDigest: string;
  readonly expiresAt: Date;
}

export interface PasswordResetRecord {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
}

export type ConsumePasswordResetResult = Readonly<
  | { status: "SUCCESS"; userId: string; revokedSessionCount: number }
  | { status: "INVALID" }
>;

export interface ConsumeRateLimitInput {
  readonly scope: string;
  readonly keyDigest: string;
  readonly windowStartedAt: Date;
  readonly expiresAt: Date;
  readonly limit: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly attemptCount: number;
  readonly expiresAt: Date;
}

export interface AuthRepository {
  registerUserWithCredential(
    input: RegisterAuthUserInput,
  ): Promise<RegisterAuthUserResult>;
  findCredentialByNormalizedEmail(
    normalizedEmail: string,
  ): Promise<AuthCredential | null>;
  findAuthUserById(userId: string): Promise<AuthUser | null>;
  findSession(sessionIdHash: string): Promise<PersistedAuthSession | null>;
  saveSession(
    input: SaveAuthSessionInput,
  ): Promise<PersistedAuthSession | null>;
  touchSession(sessionIdHash: string, expiresAt: Date): Promise<boolean>;
  revokeSession(sessionIdHash: string): Promise<boolean>;
  revokeAllUserSessions(userId: string): Promise<number>;
  createPasswordReset(
    input: CreatePasswordResetInput,
  ): Promise<PasswordResetRecord>;
  consumePasswordReset(
    tokenDigest: string,
    newPasswordHash: string,
  ): Promise<ConsumePasswordResetResult>;
  consumeRateLimit(input: ConsumeRateLimitInput): Promise<RateLimitResult>;
}

interface AuthUserRow {
  readonly id: string;
  readonly accountState: UserRecord["accountState"];
  readonly adultAttestedAt: Date;
  readonly emailVerifiedAt: Date | null;
  readonly phoneVerifiedAt: Date | null;
}

interface AuthCredentialRow extends AuthUserRow {
  readonly normalizedEmail: string;
  readonly passwordHash: string;
  readonly passwordChangedAt: Date;
}

interface AuthSessionRow {
  readonly sessionIdHash: string;
  readonly userId: string | null;
  readonly payload: AuthSessionPayload;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
}

interface PasswordResetRow {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
}

interface UserIdRow {
  readonly userId: string;
}

interface CountRow {
  readonly count: number;
}

interface RateLimitRow {
  readonly attemptCount: number;
  readonly expiresAt: Date;
}

/**
 * Parameterized PostgreSQL persistence for authentication. Callers provide
 * only password hashes and opaque-token digests; plaintext secrets are outside
 * this package's API by construction.
 */
export function createAuthRepository(sql: Sql): AuthRepository {
  return Object.freeze({
    async registerUserWithCredential(
      input: RegisterAuthUserInput,
    ): Promise<RegisterAuthUserResult> {
      if (input.adultAttested !== true) {
        throw new Error(
          "Explicit adult attestation is required for registration.",
        );
      }
      try {
        const result = await sql.begin(async (transaction) => {
          const [createdUser] = await transaction<AuthUserRow[]>`
            WITH inserted_user AS (
              INSERT INTO users DEFAULT VALUES
              RETURNING id, account_state
            ), inserted_credential AS (
              INSERT INTO auth_credentials (
                user_id,
                normalized_email,
                password_hash
              )
              SELECT
                id,
                ${input.normalizedEmail},
                ${input.passwordHash}
              FROM inserted_user
              RETURNING
                user_id,
                adult_attested_at,
                email_verified_at,
                phone_verified_at
            )
            SELECT
              inserted_user.id,
              inserted_user.account_state AS "accountState",
              inserted_credential.adult_attested_at AS "adultAttestedAt",
              inserted_credential.email_verified_at AS "emailVerifiedAt",
              inserted_credential.phone_verified_at AS "phoneVerifiedAt"
            FROM inserted_user
            JOIN inserted_credential
              ON inserted_credential.user_id = inserted_user.id
          `;

          if (createdUser === undefined) {
            throw new Error(
              "Authentication registration did not create a user.",
            );
          }

          return { user: createdUser };
        });

        return Object.freeze({ status: "CREATED", user: result.user });
      } catch (error: unknown) {
        if (isUniqueEmailViolation(error)) {
          return Object.freeze({ status: "DUPLICATE" });
        }
        throw error;
      }
    },

    async findCredentialByNormalizedEmail(
      normalizedEmail: string,
    ): Promise<AuthCredential | null> {
      const [credential] = await sql<AuthCredentialRow[]>`
        SELECT
          users.id,
          users.account_state AS "accountState",
          auth_credentials.normalized_email AS "normalizedEmail",
          auth_credentials.password_hash AS "passwordHash",
          auth_credentials.adult_attested_at AS "adultAttestedAt",
          auth_credentials.email_verified_at AS "emailVerifiedAt",
          auth_credentials.phone_verified_at AS "phoneVerifiedAt",
          auth_credentials.password_changed_at AS "passwordChangedAt"
        FROM auth_credentials
        JOIN users ON users.id = auth_credentials.user_id
        WHERE auth_credentials.normalized_email = ${normalizedEmail}
      `;
      return credential ?? null;
    },

    async findAuthUserById(userId: string): Promise<AuthUser | null> {
      const [user] = await sql<AuthUserRow[]>`
        SELECT
          users.id,
          users.account_state AS "accountState",
          auth_credentials.adult_attested_at AS "adultAttestedAt",
          auth_credentials.email_verified_at AS "emailVerifiedAt",
          auth_credentials.phone_verified_at AS "phoneVerifiedAt"
        FROM users
        JOIN auth_credentials ON auth_credentials.user_id = users.id
        WHERE users.id = ${userId}
      `;
      return user ?? null;
    },

    async findSession(
      sessionIdHash: string,
    ): Promise<PersistedAuthSession | null> {
      const [session] = await sql<AuthSessionRow[]>`
        SELECT
          session_id_hash AS "sessionIdHash",
          user_id AS "userId",
          payload,
          created_at AS "createdAt",
          last_seen_at AS "lastSeenAt",
          expires_at AS "expiresAt"
        FROM auth_sessions
        WHERE session_id_hash = ${sessionIdHash}
          AND revoked_at IS NULL
          AND expires_at > CURRENT_TIMESTAMP
      `;
      return session ?? null;
    },

    async saveSession(
      input: SaveAuthSessionInput,
    ): Promise<PersistedAuthSession | null> {
      const [session] = await sql<AuthSessionRow[]>`
        INSERT INTO auth_sessions (
          session_id_hash,
          user_id,
          payload,
          expires_at
        ) VALUES (
          ${input.sessionIdHash},
          ${input.userId},
          ${sql.json(input.payload)},
          ${input.expiresAt}
        )
        ON CONFLICT (session_id_hash) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          payload = EXCLUDED.payload,
          last_seen_at = CURRENT_TIMESTAMP,
          expires_at = EXCLUDED.expires_at
        WHERE auth_sessions.revoked_at IS NULL
          AND auth_sessions.expires_at > CURRENT_TIMESTAMP
        RETURNING
          session_id_hash AS "sessionIdHash",
          user_id AS "userId",
          payload,
          created_at AS "createdAt",
          last_seen_at AS "lastSeenAt",
          expires_at AS "expiresAt"
      `;
      return session ?? null;
    },

    async touchSession(
      sessionIdHash: string,
      expiresAt: Date,
    ): Promise<boolean> {
      const rows = await sql<{ readonly sessionIdHash: string }[]>`
        UPDATE auth_sessions
        SET last_seen_at = CURRENT_TIMESTAMP, expires_at = ${expiresAt}
        WHERE session_id_hash = ${sessionIdHash}
          AND revoked_at IS NULL
          AND expires_at > CURRENT_TIMESTAMP
        RETURNING session_id_hash AS "sessionIdHash"
      `;
      return rows.length === 1;
    },

    async revokeSession(sessionIdHash: string): Promise<boolean> {
      const rows = await sql<{ readonly sessionIdHash: string }[]>`
        UPDATE auth_sessions
        SET revoked_at = CURRENT_TIMESTAMP
        WHERE session_id_hash = ${sessionIdHash}
          AND revoked_at IS NULL
        RETURNING session_id_hash AS "sessionIdHash"
      `;
      return rows.length === 1;
    },

    async revokeAllUserSessions(userId: string): Promise<number> {
      const [result] = await sql<CountRow[]>`
        WITH revoked AS (
          UPDATE auth_sessions
          SET revoked_at = CURRENT_TIMESTAMP
          WHERE user_id = ${userId}
            AND revoked_at IS NULL
          RETURNING 1
        )
        SELECT count(*)::integer AS count FROM revoked
      `;
      return result?.count ?? 0;
    },

    async createPasswordReset(
      input: CreatePasswordResetInput,
    ): Promise<PasswordResetRecord> {
      const result = await sql.begin(async (transaction) => {
        const credentials = await transaction<{ readonly userId: string }[]>`
          SELECT user_id AS "userId"
          FROM auth_credentials
          WHERE user_id = ${input.userId}
          FOR UPDATE
        `;
        if (credentials.length !== 1) {
          throw new Error("Password reset credential does not exist.");
        }

        await transaction`
          UPDATE password_reset_tokens
          SET invalidated_at = CURRENT_TIMESTAMP
          WHERE user_id = ${input.userId}
            AND consumed_at IS NULL
            AND invalidated_at IS NULL
        `;

        const [reset] = await transaction<PasswordResetRow[]>`
          INSERT INTO password_reset_tokens (
            user_id,
            token_digest,
            expires_at
          ) VALUES (
            ${input.userId},
            ${input.tokenDigest},
            ${input.expiresAt}
          )
          RETURNING
            id,
            user_id AS "userId",
            expires_at AS "expiresAt"
        `;

        if (reset === undefined) {
          throw new Error("Password reset record was not created.");
        }
        return { reset };
      });
      return result.reset;
    },

    async consumePasswordReset(
      tokenDigest: string,
      newPasswordHash: string,
    ): Promise<ConsumePasswordResetResult> {
      const result = await sql.begin(async (transaction) => {
        const [consumed] = await transaction<UserIdRow[]>`
          UPDATE password_reset_tokens
          SET consumed_at = CURRENT_TIMESTAMP
          WHERE token_digest = ${tokenDigest}
            AND consumed_at IS NULL
            AND invalidated_at IS NULL
            AND expires_at > CURRENT_TIMESTAMP
          RETURNING user_id AS "userId"
        `;

        if (consumed === undefined) {
          return { value: Object.freeze({ status: "INVALID" } as const) };
        }

        const credentials = await transaction<{ readonly userId: string }[]>`
          UPDATE auth_credentials
          SET
            password_hash = ${newPasswordHash},
            password_changed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ${consumed.userId}
          RETURNING user_id AS "userId"
        `;
        if (credentials.length !== 1) {
          throw new Error("Password reset credential does not exist.");
        }

        const [revoked] = await transaction<CountRow[]>`
          WITH revoked_sessions AS (
            UPDATE auth_sessions
            SET revoked_at = CURRENT_TIMESTAMP
            WHERE user_id = ${consumed.userId}
              AND revoked_at IS NULL
            RETURNING 1
          )
          SELECT count(*)::integer AS count FROM revoked_sessions
        `;

        return {
          value: Object.freeze({
            status: "SUCCESS",
            userId: consumed.userId,
            revokedSessionCount: revoked?.count ?? 0,
          } as const),
        };
      });
      return result.value;
    },

    async consumeRateLimit(
      input: ConsumeRateLimitInput,
    ): Promise<RateLimitResult> {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
        throw new RangeError("Rate limit must be a positive safe integer.");
      }

      const [bucket] = await sql<RateLimitRow[]>`
        INSERT INTO auth_rate_limit_buckets (
          scope,
          key_digest,
          window_started_at,
          expires_at,
          attempt_count
        ) VALUES (
          ${input.scope},
          ${input.keyDigest},
          ${input.windowStartedAt},
          ${input.expiresAt},
          1
        )
        ON CONFLICT (scope, key_digest) DO UPDATE SET
          window_started_at = CASE
            WHEN auth_rate_limit_buckets.expires_at <= CURRENT_TIMESTAMP
              THEN EXCLUDED.window_started_at
            ELSE auth_rate_limit_buckets.window_started_at
          END,
          expires_at = CASE
            WHEN auth_rate_limit_buckets.expires_at <= CURRENT_TIMESTAMP
              THEN EXCLUDED.expires_at
            ELSE auth_rate_limit_buckets.expires_at
          END,
          attempt_count = CASE
            WHEN auth_rate_limit_buckets.expires_at <= CURRENT_TIMESTAMP THEN 1
            ELSE auth_rate_limit_buckets.attempt_count + 1
          END
        RETURNING
          attempt_count AS "attemptCount",
          expires_at AS "expiresAt"
      `;

      if (bucket === undefined) {
        throw new Error("Rate-limit bucket was not persisted.");
      }
      return Object.freeze({
        allowed: bucket.attemptCount <= input.limit,
        attemptCount: bucket.attemptCount,
        expiresAt: bucket.expiresAt,
      });
    },
  });
}

function isUniqueEmailViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as {
    readonly code?: unknown;
    constraint_name?: unknown;
  };
  return (
    candidate.code === "23505" &&
    candidate.constraint_name === "auth_credentials_normalized_email_unique"
  );
}

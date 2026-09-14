import type { Sql } from "postgres";

import type { UserRecord } from "./schema/user.js";

export interface IssueEmailVerificationInput {
  readonly expiresAt: Date;
  readonly tokenDigest: string;
  readonly userId: string;
}

export type IssueEmailVerificationResult =
  | Readonly<{
      normalizedEmail: string;
      status: "ISSUED";
    }>
  | Readonly<{ status: "NOT_ELIGIBLE" }>;

export type ConsumeEmailVerificationResult = Readonly<
  { status: "VERIFIED"; userId: string } | { status: "INVALID" }
>;

export interface EmailVerificationRepository {
  consume(tokenDigest: string): Promise<ConsumeEmailVerificationResult>;
  issue(
    input: IssueEmailVerificationInput,
  ): Promise<IssueEmailVerificationResult>;
}

interface VerificationTargetRow {
  readonly accountState: UserRecord["accountState"];
  readonly emailVerifiedAt: Date | null;
  readonly normalizedEmail: string;
  readonly userId: string;
}

interface UserIdRow {
  readonly userId: string;
}

/**
 * Owns the atomic lifecycle of email-verification challenges. The public API
 * accepts digests only, so plaintext verification secrets cannot reach SQL.
 */
export function createEmailVerificationRepository(
  sql: Sql,
): EmailVerificationRepository {
  return Object.freeze({
    async consume(
      tokenDigest: string,
    ): Promise<ConsumeEmailVerificationResult> {
      const result = await sql.begin(async (transaction) => {
        const [consumed] = await transaction<UserIdRow[]>`
          UPDATE email_verification_tokens AS token
          SET consumed_at = CURRENT_TIMESTAMP
          FROM users
          WHERE token.token_digest = ${tokenDigest}
            AND token.user_id = users.id
            AND users.account_state = 'ACTIVE'
            AND token.consumed_at IS NULL
            AND token.invalidated_at IS NULL
            AND token.expires_at > CURRENT_TIMESTAMP
          RETURNING token.user_id AS "userId"
        `;
        if (consumed === undefined) {
          return Object.freeze({ status: "INVALID" } as const);
        }

        const credentials = await transaction<UserIdRow[]>`
          UPDATE auth_credentials
          SET
            email_verified_at = COALESCE(
              email_verified_at,
              CURRENT_TIMESTAMP
            ),
            updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ${consumed.userId}
          RETURNING user_id AS "userId"
        `;
        if (credentials.length !== 1) {
          throw new Error("Email-verification credential does not exist.");
        }

        return Object.freeze({
          status: "VERIFIED",
          userId: consumed.userId,
        } as const);
      });
      return result;
    },

    async issue(
      input: IssueEmailVerificationInput,
    ): Promise<IssueEmailVerificationResult> {
      const result = await sql.begin(async (transaction) => {
        const [target] = await transaction<VerificationTargetRow[]>`
          SELECT
            auth_credentials.user_id AS "userId",
            auth_credentials.normalized_email AS "normalizedEmail",
            auth_credentials.email_verified_at AS "emailVerifiedAt",
            users.account_state AS "accountState"
          FROM auth_credentials
          JOIN users ON users.id = auth_credentials.user_id
          WHERE auth_credentials.user_id = ${input.userId}
          FOR UPDATE OF auth_credentials
        `;

        if (
          target === undefined ||
          target.accountState !== "ACTIVE" ||
          target.emailVerifiedAt !== null
        ) {
          return Object.freeze({ status: "NOT_ELIGIBLE" } as const);
        }

        await transaction`
          UPDATE email_verification_tokens
          SET invalidated_at = clock_timestamp()
          WHERE user_id = ${input.userId}
            AND consumed_at IS NULL
            AND invalidated_at IS NULL
        `;

        await transaction`
          INSERT INTO email_verification_tokens (
            user_id,
            token_digest,
            expires_at
          ) VALUES (
            ${input.userId},
            ${input.tokenDigest},
            ${input.expiresAt}
          )
        `;

        return Object.freeze({
          normalizedEmail: target.normalizedEmail,
          status: "ISSUED",
        } as const);
      });
      return result;
    },
  });
}

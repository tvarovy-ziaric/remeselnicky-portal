import type { Sql } from "postgres";

export interface IssuePhoneVerificationInput {
  readonly challengeId: string;
  readonly expiresAt: Date;
  readonly maxAttempts: number;
  readonly normalizedPhone: string;
  readonly otpDigest: string;
  readonly otpSalt: string;
  readonly userId: string;
}

export type IssuePhoneVerificationResult = Readonly<
  { status: "ISSUED" } | { status: "NOT_ELIGIBLE" }
>;

export interface PhoneVerificationDigestMaterial {
  readonly otpSalt: string;
}

export type VerifyPhoneOtpResult = Readonly<
  { status: "VERIFIED"; userId: string } | { status: "INVALID" }
>;

export interface PhoneVerificationRepository {
  findDigestMaterial(input: {
    readonly challengeId: string;
    readonly userId: string;
  }): Promise<PhoneVerificationDigestMaterial | null>;
  invalidate(input: {
    readonly challengeId: string;
    readonly userId: string;
  }): Promise<void>;
  issue(
    input: IssuePhoneVerificationInput,
  ): Promise<IssuePhoneVerificationResult>;
  verifyAttempt(input: {
    readonly challengeId: string;
    readonly otpDigest: string;
    readonly userId: string;
  }): Promise<VerifyPhoneOtpResult>;
}

interface VerificationTargetRow {
  readonly accountState: "ACTIVE" | "DEACTIVATED" | "SUSPENDED";
  readonly normalizedPhone: string | null;
  readonly phoneVerifiedAt: Date | null;
}

interface DigestMaterialRow {
  readonly otpSalt: string;
}

interface VerificationAttemptRow {
  readonly matched: boolean;
  readonly normalizedPhone: string;
  readonly userId: string;
}

/**
 * Owns the atomic phone-challenge lifecycle. Its API accepts only an HMAC
 * digest and salt, keeping plaintext OTP values outside the persistence layer.
 */
export function createPhoneVerificationRepository(
  sql: Sql,
): PhoneVerificationRepository {
  return Object.freeze({
    async findDigestMaterial(input: {
      readonly challengeId: string;
      readonly userId: string;
    }) {
      const [challenge] = await sql<DigestMaterialRow[]>`
        SELECT challenge.otp_salt AS "otpSalt"
        FROM phone_verification_challenges AS challenge
        JOIN users ON users.id = challenge.user_id
        WHERE challenge.id = ${input.challengeId}
          AND challenge.user_id = ${input.userId}
          AND users.account_state = 'ACTIVE'
          AND challenge.consumed_at IS NULL
          AND challenge.invalidated_at IS NULL
          AND challenge.expires_at > CURRENT_TIMESTAMP
          AND challenge.attempt_count < challenge.max_attempts
      `;
      return challenge ?? null;
    },

    async invalidate(input: {
      readonly challengeId: string;
      readonly userId: string;
    }) {
      await sql`
        UPDATE phone_verification_challenges
        SET invalidated_at = CURRENT_TIMESTAMP
        WHERE id = ${input.challengeId}
          AND user_id = ${input.userId}
          AND consumed_at IS NULL
          AND invalidated_at IS NULL
      `;
    },

    async issue(input: IssuePhoneVerificationInput) {
      return sql.begin(async (transaction) => {
        const [target] = await transaction<VerificationTargetRow[]>`
          SELECT
            users.account_state AS "accountState",
            auth_credentials.normalized_phone AS "normalizedPhone",
            auth_credentials.phone_verified_at AS "phoneVerifiedAt"
          FROM auth_credentials
          JOIN users ON users.id = auth_credentials.user_id
          WHERE auth_credentials.user_id = ${input.userId}
          FOR UPDATE OF auth_credentials
        `;

        if (
          target === undefined ||
          target.accountState !== "ACTIVE" ||
          (target.phoneVerifiedAt !== null &&
            target.normalizedPhone === input.normalizedPhone)
        ) {
          return Object.freeze({ status: "NOT_ELIGIBLE" } as const);
        }

        await transaction`
          UPDATE phone_verification_challenges
          SET invalidated_at = CURRENT_TIMESTAMP
          WHERE user_id = ${input.userId}
            AND consumed_at IS NULL
            AND invalidated_at IS NULL
        `;

        await transaction`
          INSERT INTO phone_verification_challenges (
            id,
            user_id,
            normalized_phone,
            otp_digest,
            otp_salt,
            max_attempts,
            expires_at
          ) VALUES (
            ${input.challengeId},
            ${input.userId},
            ${input.normalizedPhone},
            ${input.otpDigest},
            ${input.otpSalt},
            ${input.maxAttempts},
            ${input.expiresAt}
          )
        `;

        return Object.freeze({ status: "ISSUED" } as const);
      });
    },

    async verifyAttempt(input: {
      readonly challengeId: string;
      readonly otpDigest: string;
      readonly userId: string;
    }) {
      return sql.begin(async (transaction) => {
        const [attempt] = await transaction<VerificationAttemptRow[]>`
          UPDATE phone_verification_challenges AS challenge
          SET
            attempt_count = challenge.attempt_count + 1,
            consumed_at = CASE
              WHEN challenge.otp_digest = ${input.otpDigest}
                THEN CURRENT_TIMESTAMP
              ELSE challenge.consumed_at
            END,
            invalidated_at = CASE
              WHEN challenge.otp_digest <> ${input.otpDigest}
                AND challenge.attempt_count + 1 >= challenge.max_attempts
                THEN CURRENT_TIMESTAMP
              ELSE challenge.invalidated_at
            END
          FROM users
          WHERE challenge.id = ${input.challengeId}
            AND challenge.user_id = ${input.userId}
            AND users.id = challenge.user_id
            AND users.account_state = 'ACTIVE'
            AND challenge.consumed_at IS NULL
            AND challenge.invalidated_at IS NULL
            AND challenge.expires_at > CURRENT_TIMESTAMP
            AND challenge.attempt_count < challenge.max_attempts
          RETURNING
            challenge.user_id AS "userId",
            challenge.normalized_phone AS "normalizedPhone",
            challenge.otp_digest = ${input.otpDigest} AS matched
        `;

        if (attempt === undefined || !attempt.matched) {
          return Object.freeze({ status: "INVALID" } as const);
        }

        const updated = await transaction<{ readonly userId: string }[]>`
          UPDATE auth_credentials
          SET
            normalized_phone = ${attempt.normalizedPhone},
            phone_verified_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ${attempt.userId}
          RETURNING user_id AS "userId"
        `;
        if (updated.length !== 1) {
          throw new Error("Phone-verification credential does not exist.");
        }

        return Object.freeze({
          status: "VERIFIED",
          userId: attempt.userId,
        } as const);
      });
    },
  });
}

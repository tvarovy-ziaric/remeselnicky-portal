import { createHash, randomUUID } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

import type { AuthUser } from "./auth-repository.js";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const digest = /^[a-f0-9]{64}$/u;
const cohort = /^[A-Z0-9][A-Z0-9_-]{1,63}$/u;

export type AlphaRegistrationIntakeState = "OPEN" | "PAUSED";

export interface AlphaRegistrationIntakeStatus {
  readonly revision: number;
  readonly state: AlphaRegistrationIntakeState;
  readonly recordedAt: Date;
}

export type AlphaRegistrationCommandResult =
  | Readonly<{ status: "APPLIED" | "DEDUPLICATED" }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_STATE" }>;

export type AlphaRegistrationIssueResult =
  | Readonly<{
      status: "APPLIED" | "DEDUPLICATED";
      invitationId: string;
      expiresAt: Date;
    }>
  | Readonly<{ status: "STALE_STATE" }>;

export type InvitedRegistrationResult =
  | Readonly<{
      status: "CREATED";
      invitationId: string;
      user: AuthUser;
    }>
  | Readonly<{ status: "DUPLICATE" | "NOT_AVAILABLE" }>;

export interface AlphaRegistrationIntakeRepository {
  issue(input: {
    readonly actorUserId: string;
    readonly cohortCode: string;
    readonly commandId: string;
    readonly emailHmacDigest: string;
    readonly expiresAt: Date;
  }): Promise<AlphaRegistrationIssueResult>;
  readStatus(): Promise<AlphaRegistrationIntakeStatus>;
  registerInvitedUser(input: {
    readonly adultAttested: true;
    readonly emailHmacDigest: string;
    readonly normalizedEmail: string;
    readonly passwordHash: string;
  }): Promise<InvitedRegistrationResult>;
  revoke(input: {
    readonly actorUserId: string;
    readonly commandId: string;
    readonly invitationId: string;
    readonly reason: string;
  }): Promise<AlphaRegistrationCommandResult>;
  setState(input: {
    readonly actorUserId: string;
    readonly commandId: string;
    readonly reason: string;
    readonly state: AlphaRegistrationIntakeState;
  }): Promise<AlphaRegistrationCommandResult>;
}

export class AlphaRegistrationIntakeIdempotencyError extends Error {
  public constructor() {
    super("Alpha registration intake command ID was reused.");
    this.name = "AlphaRegistrationIntakeIdempotencyError";
  }
}

interface IntakeRow {
  readonly revision: string;
  readonly state: AlphaRegistrationIntakeState;
  readonly recordedAt: Date;
}

interface InvitationRow {
  readonly invitationId: string;
  readonly actorUserId: string;
  readonly cohortCode: string;
  readonly emailHmacDigest: string;
  readonly expiresAt: Date;
  readonly payloadFingerprint: string;
}

interface RevocationRow {
  readonly actorUserId: string;
  readonly invitationId: string;
  readonly payloadFingerprint: string;
  readonly reason: string;
}

interface StateCommandRow {
  readonly actorUserId: string | null;
  readonly payloadFingerprint: string;
  readonly reason: string;
  readonly state: AlphaRegistrationIntakeState;
}

type CreatedUserRow = AuthUser;

export function createAlphaRegistrationIntakeRepository(
  sql: Sql,
): AlphaRegistrationIntakeRepository {
  return Object.freeze({
    async readStatus() {
      const [current] = await sql<IntakeRow[]>`
        SELECT revision, state::text, recorded_at AS "recordedAt"
        FROM current_alpha_registration_intake
      `;
      if (current === undefined)
        throw new Error("Alpha registration intake state is unavailable.");
      return Object.freeze({
        recordedAt: current.recordedAt,
        revision: parseRevision(current.revision),
        state: current.state,
      });
    },

    async setState(
      input: Parameters<AlphaRegistrationIntakeRepository["setState"]>[0],
    ) {
      validateActorCommand(input.actorUserId, input.commandId);
      validateReason(input.reason);
      if (input.state !== "OPEN" && input.state !== "PAUSED")
        throw new TypeError("Invalid alpha registration intake state.");
      const fingerprint = payloadFingerprint(input);
      return sql.begin(async (tx) => {
        await intakeLock(tx);
        await commandLock(tx, input.commandId);
        const [existing] = await tx<StateCommandRow[]>`
          SELECT actor_user_id AS "actorUserId", state::text, reason,
            payload_fingerprint AS "payloadFingerprint"
          FROM alpha_registration_intake_events
          WHERE command_id = ${input.commandId}
        `;
        if (existing !== undefined) {
          if (
            existing.actorUserId !== input.actorUserId ||
            existing.payloadFingerprint !== fingerprint ||
            existing.reason !== input.reason ||
            existing.state !== input.state
          )
            throw new AlphaRegistrationIntakeIdempotencyError();
          return Object.freeze({ status: "DEDUPLICATED" as const });
        }
        const [current] = await tx<IntakeRow[]>`
          SELECT revision, state::text, recorded_at AS "recordedAt"
          FROM alpha_registration_intake_events
          ORDER BY revision DESC LIMIT 1 FOR UPDATE
        `;
        if (current === undefined)
          throw new Error("Alpha registration intake state is unavailable.");
        if (current.state === input.state)
          return Object.freeze({ status: "STALE_STATE" as const });
        await tx`
          INSERT INTO alpha_registration_intake_events (
            command_id, revision, state, actor_user_id, reason,
            payload_fingerprint
          ) VALUES (
            ${input.commandId}, ${parseRevision(current.revision) + 1}, ${input.state},
            ${input.actorUserId}, ${input.reason}, ${fingerprint}
          )
        `;
        return Object.freeze({ status: "APPLIED" as const });
      });
    },

    async issue(
      input: Parameters<AlphaRegistrationIntakeRepository["issue"]>[0],
    ) {
      validateActorCommand(input.actorUserId, input.commandId);
      if (!digest.test(input.emailHmacDigest) || !cohort.test(input.cohortCode))
        throw new TypeError("Invalid alpha registration invitation.");
      if (!Number.isFinite(input.expiresAt.valueOf()))
        throw new TypeError("Invalid alpha registration invitation expiry.");
      const fingerprint = payloadFingerprint({
        actorUserId: input.actorUserId,
        cohortCode: input.cohortCode,
        emailHmacDigest: input.emailHmacDigest,
        expiresAt: input.expiresAt.toISOString(),
      });
      return sql.begin(async (tx) => {
        await intakeLock(tx);
        await commandLock(tx, input.commandId);
        const [existing] = await tx<InvitationRow[]>`
          SELECT invitation_id AS "invitationId",
            issued_by_user_id AS "actorUserId", cohort_code AS "cohortCode",
            email_hmac_digest AS "emailHmacDigest", expires_at AS "expiresAt",
            payload_fingerprint AS "payloadFingerprint"
          FROM alpha_registration_invitations
          WHERE command_id = ${input.commandId}
        `;
        if (existing !== undefined) {
          if (
            existing.actorUserId !== input.actorUserId ||
            existing.payloadFingerprint !== fingerprint
          )
            throw new AlphaRegistrationIntakeIdempotencyError();
          return Object.freeze({
            status: "DEDUPLICATED" as const,
            invitationId: existing.invitationId,
            expiresAt: existing.expiresAt,
          });
        }
        const [current] = await tx<IntakeRow[]>`
          SELECT revision, state::text, recorded_at AS "recordedAt"
          FROM alpha_registration_intake_events
          ORDER BY revision DESC LIMIT 1 FOR SHARE
        `;
        if (current?.state !== "OPEN")
          return Object.freeze({ status: "STALE_STATE" as const });
        const invitationId = randomUUID();
        const [created] = await tx<Array<{ readonly issuedAt: Date }>>`
          INSERT INTO alpha_registration_invitations (
            invitation_id, command_id, email_hmac_digest, cohort_code,
            issued_by_user_id, expires_at, payload_fingerprint
          ) VALUES (
            ${invitationId}, ${input.commandId}, ${input.emailHmacDigest},
            ${input.cohortCode}, ${input.actorUserId}, ${input.expiresAt},
            ${fingerprint}
          )
          RETURNING issued_at AS "issuedAt"
        `;
        if (created === undefined)
          throw new Error("Alpha registration invitation was not issued.");
        return Object.freeze({
          status: "APPLIED" as const,
          invitationId,
          expiresAt: input.expiresAt,
        });
      });
    },

    async revoke(
      input: Parameters<AlphaRegistrationIntakeRepository["revoke"]>[0],
    ) {
      validateActorCommand(input.actorUserId, input.commandId);
      if (!uuid.test(input.invitationId))
        throw new TypeError("Invalid alpha registration invitation.");
      validateReason(input.reason);
      const fingerprint = payloadFingerprint(input);
      return sql.begin(async (tx) => {
        await commandLock(tx, input.commandId);
        const [existing] = await tx<RevocationRow[]>`
          SELECT invitation_id AS "invitationId",
            revoked_by_user_id AS "actorUserId", reason,
            payload_fingerprint AS "payloadFingerprint"
          FROM alpha_registration_invitation_revocations
          WHERE command_id = ${input.commandId}
        `;
        if (existing !== undefined) {
          if (
            existing.actorUserId !== input.actorUserId ||
            existing.payloadFingerprint !== fingerprint
          )
            throw new AlphaRegistrationIntakeIdempotencyError();
          return Object.freeze({ status: "DEDUPLICATED" as const });
        }
        const [invitation] = await tx<Array<{ readonly invitationId: string }>>`
          SELECT invitation_id AS "invitationId"
          FROM alpha_registration_invitations
          WHERE invitation_id = ${input.invitationId}
          FOR UPDATE
        `;
        if (invitation === undefined)
          return Object.freeze({ status: "NOT_FOUND" as const });
        const [closed] = await tx<Array<{ readonly closed: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM alpha_registration_invitation_revocations
            WHERE invitation_id = ${input.invitationId}
            UNION ALL
            SELECT 1 FROM alpha_registration_invitation_claims
            WHERE invitation_id = ${input.invitationId}
          ) AS closed
        `;
        if (closed?.closed !== false)
          return Object.freeze({ status: "STALE_STATE" as const });
        await tx`
          INSERT INTO alpha_registration_invitation_revocations (
            invitation_id, command_id, revoked_by_user_id, reason,
            payload_fingerprint
          ) VALUES (
            ${input.invitationId}, ${input.commandId}, ${input.actorUserId},
            ${input.reason}, ${fingerprint}
          )
        `;
        return Object.freeze({ status: "APPLIED" as const });
      });
    },

    async registerInvitedUser(
      input: Parameters<
        AlphaRegistrationIntakeRepository["registerInvitedUser"]
      >[0],
    ) {
      if (
        input.adultAttested !== true ||
        !digest.test(input.emailHmacDigest) ||
        input.normalizedEmail.length < 3 ||
        input.normalizedEmail.length > 254 ||
        input.passwordHash.length < 1
      )
        throw new TypeError("Invalid invited registration.");
      try {
        return await sql.begin(async (tx) => {
          await intakeLock(tx);
          const [current] = await tx<IntakeRow[]>`
            SELECT revision, state::text, recorded_at AS "recordedAt"
            FROM alpha_registration_intake_events
            ORDER BY revision DESC LIMIT 1 FOR UPDATE
          `;
          if (current?.state !== "OPEN")
            return Object.freeze({ status: "NOT_AVAILABLE" as const });
          const [invitation] = await tx<
            Array<{ readonly invitationId: string }>
          >`
            SELECT invitation.invitation_id AS "invitationId"
            FROM alpha_registration_invitations invitation
            WHERE invitation.email_hmac_digest = ${input.emailHmacDigest}
              AND invitation.expires_at > clock_timestamp()
              AND NOT EXISTS (
                SELECT 1 FROM alpha_registration_invitation_revocations revoked
                WHERE revoked.invitation_id = invitation.invitation_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM alpha_registration_invitation_claims claimed
                WHERE claimed.invitation_id = invitation.invitation_id
              )
            ORDER BY invitation.issued_at DESC, invitation.invitation_id
            LIMIT 1 FOR UPDATE OF invitation
          `;
          if (invitation === undefined)
            return Object.freeze({ status: "NOT_AVAILABLE" as const });
          const [createdUser] = await tx<CreatedUserRow[]>`
            WITH inserted_user AS (
              INSERT INTO users DEFAULT VALUES
              RETURNING id, account_state
            ), inserted_credential AS (
              INSERT INTO auth_credentials (
                user_id, normalized_email, password_hash
              )
              SELECT id, ${input.normalizedEmail}, ${input.passwordHash}
              FROM inserted_user
              RETURNING user_id, adult_attested_at, email_verified_at,
                phone_verified_at
            )
            SELECT ARRAY[]::text[] AS "activeModerationScopes",
              inserted_user.id,
              inserted_user.account_state AS "accountState",
              inserted_credential.adult_attested_at AS "adultAttestedAt",
              inserted_credential.email_verified_at AS "emailVerifiedAt",
              inserted_credential.phone_verified_at AS "phoneVerifiedAt"
            FROM inserted_user
            JOIN inserted_credential
              ON inserted_credential.user_id = inserted_user.id
          `;
          if (createdUser === undefined)
            throw new Error("Invited registration did not create a user.");
          await tx`
            INSERT INTO alpha_registration_invitation_claims (
              invitation_id, user_id
            ) VALUES (${invitation.invitationId}, ${createdUser.id})
          `;
          return Object.freeze({
            status: "CREATED" as const,
            invitationId: invitation.invitationId,
            user: createdUser,
          });
        });
      } catch (error: unknown) {
        if (isUniqueEmailViolation(error))
          return Object.freeze({ status: "DUPLICATE" as const });
        throw error;
      }
    },
  });
}

function validateActorCommand(actorUserId: string, commandId: string): void {
  if (!uuid.test(actorUserId) || !uuid.test(commandId))
    throw new TypeError("Invalid alpha registration intake command.");
}

function validateReason(reason: string): void {
  if (
    reason !== reason.trim() ||
    reason.length < 8 ||
    reason.length > 500 ||
    /[\p{Cc}]/u.test(reason)
  )
    throw new TypeError("Invalid alpha registration intake reason.");
}

function payloadFingerprint(input: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function commandLock(
  sql: TransactionSql,
  commandId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${commandId}, 0))`;
}

async function intakeLock(sql: TransactionSql): Promise<void> {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended('alpha-registration-intake-state', 0)
    )
  `;
}

function isUniqueEmailViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly constraint_name?: unknown;
  };
  return (
    candidate.code === "23505" &&
    candidate.constraint_name === "auth_credentials_normalized_email_unique"
  );
}

function parseRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error("Invalid alpha registration intake revision.");
  return revision;
}

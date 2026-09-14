import type {
  AdminAccessRepository,
  AdminMfaFactorKind,
  AdminMfaPurpose,
  AdminRole,
  AdminRoleChangeEvent,
  ClaimedMfaChallenge,
  PrivilegedIdentity,
  PrivilegedSessionRecord,
} from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import type { Sql } from "postgres";

interface IdentityRow {
  readonly credentialReference: string;
  readonly factorId: string;
  readonly kind: AdminMfaFactorKind;
  readonly roles: AdminRole[];
  readonly userId: UserId;
}

interface ChallengeRow {
  readonly credentialReference: string;
  readonly factorId: string;
  readonly kind: AdminMfaFactorKind;
  readonly providerStateReference: string | null;
  readonly purpose: AdminMfaPurpose;
  readonly userId: UserId;
}

interface PrivilegedSessionRow {
  readonly expiresAt: Date;
  readonly factorId: string;
  readonly mfaAuthenticatedAt: Date;
  readonly roles: AdminRole[];
  readonly userId: UserId;
}

interface RoleEventRow {
  readonly action: AdminRoleChangeEvent["action"];
  readonly actorUserId: UserId;
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly reason: string;
  readonly role: AdminRole;
  readonly targetUserId: UserId;
}

interface MutationRow {
  readonly id: string;
}

/**
 * Privileged persistence keeps MFA verification secrets outside PostgreSQL.
 * Credential and challenge state references are opaque handles owned by the
 * configured MFA provider.
 */
export function createAdminAccessRepository(sql: Sql): AdminAccessRepository {
  return Object.freeze({
    async changeRole(
      change: Parameters<AdminAccessRepository["changeRole"]>[0],
    ): Promise<AdminRoleChangeEvent | undefined> {
      validateRoleChange(change);
      return sql.begin(async (transaction) => {
        const [actor] = await transaction<MutationRow[]>`
          SELECT users.id
          FROM users
          JOIN auth_sessions AS base
            ON base.user_id = users.id
            AND base.session_id_hash = ${change.actorSessionIdDigest}
            AND base.revoked_at IS NULL
            AND base.expires_at > CURRENT_TIMESTAMP
          JOIN admin_privileged_sessions AS privileged
            ON privileged.session_id_hash = base.session_id_hash
            AND privileged.user_id = users.id
            AND privileged.revoked_at IS NULL
            AND privileged.expires_at > CURRENT_TIMESTAMP
            AND privileged.mfa_authenticated_at >=
              CURRENT_TIMESTAMP - (${change.reauthenticationMaxAgeMs} * interval '1 millisecond')
          JOIN admin_mfa_factors AS factor
            ON factor.id = privileged.mfa_factor_id
            AND factor.user_id = users.id
            AND factor.revoked_at IS NULL
          JOIN admin_role_grants AS role
            ON role.user_id = users.id
            AND role.role = 'SUPER_ADMIN'
            AND role.revoked_at IS NULL
          WHERE users.id = ${change.actorUserId}
            AND users.account_state = 'ACTIVE'
          FOR UPDATE OF users, base, privileged, factor, role
        `;
        if (actor === undefined || change.actorUserId === change.targetUserId) {
          return undefined;
        }

        let changed: boolean;
        if (change.action === "GRANT") {
          const inserted = await transaction<MutationRow[]>`
            INSERT INTO admin_role_grants (
              user_id,
              role,
              granted_by_user_id,
              grant_source,
              reason
            )
            SELECT
              users.id,
              ${change.role},
              ${change.actorUserId},
              'ADMIN_COMMAND',
              ${change.reason}
            FROM users
            WHERE users.id = ${change.targetUserId}
              AND users.account_state = 'ACTIVE'
            ON CONFLICT (user_id, role) WHERE revoked_at IS NULL DO NOTHING
            RETURNING id
          `;
          changed = inserted.length === 1;
        } else {
          const revoked = await transaction<MutationRow[]>`
            UPDATE admin_role_grants
            SET
              revoked_at = CURRENT_TIMESTAMP,
              revoked_by_user_id = ${change.actorUserId}
            WHERE user_id = ${change.targetUserId}
              AND role = ${change.role}
              AND revoked_at IS NULL
            RETURNING id
          `;
          changed = revoked.length === 1;
        }
        if (!changed) return undefined;

        await transaction`
          UPDATE admin_privileged_sessions
          SET revoked_at = CURRENT_TIMESTAMP
          WHERE user_id = ${change.targetUserId}
            AND revoked_at IS NULL
        `;

        const action =
          change.action === "GRANT"
            ? "ADMIN_ROLE_GRANTED"
            : "ADMIN_ROLE_REVOKED";
        const [event] = await transaction<RoleEventRow[]>`
          INSERT INTO admin_role_change_events (
            event_id,
            actor_user_id,
            target_user_id,
            action,
            role,
            reason
          ) VALUES (
            ${change.eventId},
            ${change.actorUserId},
            ${change.targetUserId},
            ${action},
            ${change.role},
            ${change.reason}
          )
          RETURNING
            event_id AS "eventId",
            actor_user_id AS "actorUserId",
            target_user_id AS "targetUserId",
            action,
            role,
            reason,
            occurred_at AS "occurredAt"
        `;
        if (event === undefined) {
          throw new Error("Admin role event was not recorded atomically.");
        }
        return Object.freeze(event);
      });
    },

    async claimMfaChallenge(
      claim: Parameters<AdminAccessRepository["claimMfaChallenge"]>[0],
    ): Promise<ClaimedMfaChallenge | undefined> {
      const [challenge] = await sql<ChallengeRow[]>`
        UPDATE admin_mfa_challenges AS challenge
        SET claimed_at = CURRENT_TIMESTAMP
        FROM admin_mfa_factors AS factor, users
        WHERE challenge.challenge_digest = ${claim.challengeDigest}
          AND challenge.user_id = ${claim.userId}
          AND challenge.user_id = users.id
          AND users.account_state = 'ACTIVE'
          AND challenge.factor_id = factor.id
          AND factor.user_id = challenge.user_id
          AND factor.revoked_at IS NULL
          AND challenge.claimed_at IS NULL
          AND challenge.verified_at IS NULL
          AND challenge.expires_at > CURRENT_TIMESTAMP
          AND challenge.expires_at > ${claim.now}
          AND EXISTS (
            SELECT 1
            FROM admin_role_grants AS role
            WHERE role.user_id = challenge.user_id
              AND role.revoked_at IS NULL
          )
        RETURNING
          challenge.user_id AS "userId",
          challenge.factor_id AS "factorId",
          challenge.purpose,
          challenge.provider_state_reference AS "providerStateReference",
          factor.kind,
          factor.credential_reference AS "credentialReference"
      `;
      return challenge === undefined ? undefined : Object.freeze(challenge);
    },

    async completeMfaChallenge(
      completion: Parameters<AdminAccessRepository["completeMfaChallenge"]>[0],
    ): Promise<boolean> {
      return sql
        .begin(async (transaction) => {
          const [verified] = await transaction<{ factorId: string }[]>`
          UPDATE admin_mfa_challenges AS challenge
          SET verified_at = CURRENT_TIMESTAMP
          FROM admin_mfa_factors AS factor, users
          WHERE challenge.challenge_digest = ${completion.challengeDigest}
            AND challenge.user_id = ${completion.userId}
            AND challenge.user_id = users.id
            AND users.account_state = 'ACTIVE'
            AND challenge.factor_id = factor.id
            AND factor.user_id = challenge.user_id
            AND factor.revoked_at IS NULL
            AND challenge.claimed_at IS NOT NULL
            AND challenge.verified_at IS NULL
            AND challenge.expires_at > CURRENT_TIMESTAMP
            AND challenge.expires_at > ${completion.now}
            AND EXISTS (
              SELECT 1
              FROM admin_role_grants AS role
              WHERE role.user_id = challenge.user_id
                AND role.revoked_at IS NULL
            )
          RETURNING challenge.factor_id AS "factorId"
        `;
          if (verified === undefined) return false;

          const sessions = await transaction<MutationRow[]>`
          INSERT INTO admin_privileged_sessions (
            session_id_hash,
            user_id,
            mfa_factor_id,
            mfa_authenticated_at,
            expires_at
          )
          SELECT
            auth_sessions.session_id_hash,
            auth_sessions.user_id,
            ${verified.factorId},
            CURRENT_TIMESTAMP,
            LEAST(${completion.expiresAt}, auth_sessions.expires_at)
          FROM auth_sessions
          WHERE auth_sessions.session_id_hash = ${completion.sessionIdDigest}
            AND auth_sessions.user_id = ${completion.userId}
            AND auth_sessions.revoked_at IS NULL
            AND auth_sessions.expires_at > CURRENT_TIMESTAMP
            AND LEAST(${completion.expiresAt}, auth_sessions.expires_at) > CURRENT_TIMESTAMP
          ON CONFLICT (session_id_hash) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            mfa_factor_id = EXCLUDED.mfa_factor_id,
            mfa_authenticated_at = EXCLUDED.mfa_authenticated_at,
            created_at = CURRENT_TIMESTAMP,
            expires_at = EXCLUDED.expires_at,
            revoked_at = NULL
          RETURNING session_id_hash AS id
        `;
          if (sessions.length !== 1) {
            throw new Error("MFA passed but the base session is unavailable.");
          }
          return true;
        })
        .catch(() => false);
    },

    async createMfaChallenge(
      challenge: Parameters<AdminAccessRepository["createMfaChallenge"]>[0],
    ): Promise<boolean> {
      return sql.begin(async (transaction) => {
        const eligible = await transaction<MutationRow[]>`
          SELECT factor.id
          FROM admin_mfa_factors AS factor
          JOIN users ON users.id = factor.user_id
          WHERE factor.id = ${challenge.factorId}
            AND factor.user_id = ${challenge.userId}
            AND factor.revoked_at IS NULL
            AND users.account_state = 'ACTIVE'
            AND EXISTS (
              SELECT 1
              FROM admin_role_grants AS role
              WHERE role.user_id = factor.user_id
                AND role.revoked_at IS NULL
            )
          FOR UPDATE OF factor
        `;
        if (eligible.length !== 1) return false;

        await transaction`
          UPDATE admin_mfa_challenges
          SET claimed_at = CURRENT_TIMESTAMP
          WHERE user_id = ${challenge.userId}
            AND claimed_at IS NULL
            AND verified_at IS NULL
        `;
        const inserted = await transaction<MutationRow[]>`
          INSERT INTO admin_mfa_challenges (
            challenge_digest,
            user_id,
            factor_id,
            purpose,
            provider_state_reference,
            expires_at
          ) VALUES (
            ${challenge.challengeDigest},
            ${challenge.userId},
            ${challenge.factorId},
            ${challenge.purpose},
            ${challenge.providerStateReference},
            ${challenge.expiresAt}
          )
          RETURNING challenge_digest AS id
        `;
        return inserted.length === 1;
      });
    },

    async findPrivilegedIdentity(
      userId: UserId,
    ): Promise<PrivilegedIdentity | undefined> {
      const rows = await sql<IdentityRow[]>`
        SELECT
          users.id AS "userId",
          factor.id AS "factorId",
          factor.kind,
          factor.credential_reference AS "credentialReference",
          array_agg(DISTINCT role.role ORDER BY role.role)::text[] AS roles
        FROM users
        JOIN admin_role_grants AS role
          ON role.user_id = users.id
          AND role.revoked_at IS NULL
        JOIN admin_mfa_factors AS factor
          ON factor.user_id = users.id
          AND factor.revoked_at IS NULL
        WHERE users.id = ${userId}
          AND users.account_state = 'ACTIVE'
        GROUP BY users.id, factor.id
        ORDER BY factor.activated_at, factor.id
      `;
      if (rows.length === 0) return undefined;
      return Object.freeze({
        factors: Object.freeze(
          rows.map((row) =>
            Object.freeze({
              credentialReference: row.credentialReference,
              factorId: row.factorId,
              kind: row.kind,
            }),
          ),
        ),
        roles: Object.freeze([...(rows[0]?.roles ?? [])]),
        userId,
      });
    },

    async findPrivilegedSession(
      session: Parameters<AdminAccessRepository["findPrivilegedSession"]>[0],
    ): Promise<PrivilegedSessionRecord | undefined> {
      const [row] = await sql<PrivilegedSessionRow[]>`
        SELECT
          privileged.user_id AS "userId",
          privileged.mfa_factor_id AS "factorId",
          privileged.mfa_authenticated_at AS "mfaAuthenticatedAt",
          privileged.expires_at AS "expiresAt",
          array_agg(DISTINCT role.role ORDER BY role.role)::text[] AS roles
        FROM admin_privileged_sessions AS privileged
        JOIN auth_sessions AS base
          ON base.session_id_hash = privileged.session_id_hash
          AND base.user_id = privileged.user_id
          AND base.revoked_at IS NULL
          AND base.expires_at > CURRENT_TIMESTAMP
        JOIN users
          ON users.id = privileged.user_id
          AND users.account_state = 'ACTIVE'
        JOIN admin_mfa_factors AS factor
          ON factor.id = privileged.mfa_factor_id
          AND factor.user_id = privileged.user_id
          AND factor.revoked_at IS NULL
        JOIN admin_role_grants AS role
          ON role.user_id = privileged.user_id
          AND role.revoked_at IS NULL
        WHERE privileged.session_id_hash = ${session.sessionIdDigest}
          AND privileged.user_id = ${session.userId}
          AND privileged.revoked_at IS NULL
          AND privileged.expires_at > CURRENT_TIMESTAMP
          AND privileged.expires_at > ${session.now}
        GROUP BY privileged.session_id_hash
      `;
      return row === undefined ? undefined : Object.freeze(row);
    },

    async revokePrivilegedSession(sessionIdDigest: string): Promise<void> {
      await sql`
        UPDATE admin_privileged_sessions
        SET revoked_at = CURRENT_TIMESTAMP
        WHERE session_id_hash = ${sessionIdDigest}
          AND revoked_at IS NULL
      `;
    },
  });
}

function validateRoleChange(
  change: Parameters<AdminAccessRepository["changeRole"]>[0],
): void {
  if (!/^[0-9a-f]{64}$/u.test(change.actorSessionIdDigest)) {
    throw new TypeError("actorSessionIdDigest must be a SHA-256 digest");
  }
  if (
    !Number.isSafeInteger(change.reauthenticationMaxAgeMs) ||
    change.reauthenticationMaxAgeMs < 30_000 ||
    change.reauthenticationMaxAgeMs > 3_600_000
  ) {
    throw new RangeError("reauthenticationMaxAgeMs is outside the safe range");
  }
  if (change.role !== "ADMIN" && change.role !== "SUPER_ADMIN") {
    throw new TypeError("role must be a supported privileged role");
  }
  if (change.reason.trim().length < 8 || change.reason.length > 500) {
    throw new TypeError("role change reason must be meaningful and bounded");
  }
}

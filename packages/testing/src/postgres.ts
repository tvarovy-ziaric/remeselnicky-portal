import type { Sql, TransactionSql } from "postgres";

import type {
  PersistSyntheticAccountInput,
  SyntheticSeedPersistence,
} from "./model.js";

export { withIsolatedPostgresDatabase } from "./isolated-postgres.js";
export type {
  IsolatedDatabaseEnvironment,
  IsolatedPostgresContext,
} from "./isolated-postgres.js";

interface EnvironmentRow {
  readonly environment: string;
}

interface ExistingAccountRow {
  readonly accountState: string;
  readonly adminRole: string | null;
  readonly emailVerified: boolean;
  readonly factorReference: string | null;
  readonly normalizedEmail: string;
  readonly passwordHashMatches: boolean;
  readonly phoneVerified: boolean;
}

/**
 * Idempotent PostgreSQL adapter for R0 identity tables. Profile/location and
 * profession rows are intentionally left to their R1-owned schemas.
 */
export function createPostgresSyntheticSeedPersistence(
  sql: Sql,
): SyntheticSeedPersistence {
  const persistence: SyntheticSeedPersistence = {
    kind: "SYNTHETIC_SEED_PERSISTENCE" as const,

    async assertTargetEnvironment(
      environment: "development" | "staging" | "test",
    ) {
      const [row] = await sql<EnvironmentRow[]>`
        SELECT COALESCE(current_setting('portal.environment', true), '') AS environment
      `;
      if (row?.environment !== environment) {
        throw new Error(
          "Database environment marker does not match the non-production seed target.",
        );
      }
    },

    async upsertAccount(input: PersistSyntheticAccountInput) {
      return sql.begin(async (transaction) => {
        const created = await transaction<{ readonly id: string }[]>`
          INSERT INTO users (
            id,
            account_state,
            account_state_changed_at,
            created_at,
            updated_at
          ) VALUES (
            ${input.account.userId},
            ${input.account.accountState},
            ${input.account.createdAt},
            ${input.account.createdAt},
            ${input.account.createdAt}
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `;

        const createdCredentials = await transaction<
          { readonly userId: string }[]
        >`
          INSERT INTO auth_credentials (
            user_id,
            normalized_email,
            password_hash,
            email_verified_at,
            normalized_phone,
            phone_verified_at,
            adult_attested_at,
            password_changed_at,
            created_at,
            updated_at
          ) VALUES (
            ${input.account.userId},
            ${input.account.normalizedEmail},
            ${input.passwordHash},
            ${input.account.emailVerifiedAt},
            ${input.account.normalizedPhone},
            ${input.account.phoneVerifiedAt},
            ${input.account.adultAttestedAt},
            ${input.account.createdAt},
            ${input.account.createdAt},
            ${input.account.createdAt}
          )
          ON CONFLICT (user_id) DO NOTHING
          RETURNING user_id AS "userId"
        `;

        let createdAdminRecords = 0;
        if (
          input.account.adminRole !== null &&
          input.account.mfaFactor !== null
        ) {
          createdAdminRecords = await insertAdminAccess(transaction, input);
        }

        const persistedRows = await transaction<ExistingAccountRow[]>`
          SELECT
            users.account_state AS "accountState",
            credentials.normalized_email AS "normalizedEmail",
            credentials.password_hash = ${input.passwordHash} AS "passwordHashMatches",
            credentials.email_verified_at IS NOT NULL AS "emailVerified",
            credentials.phone_verified_at IS NOT NULL AS "phoneVerified",
            role.role::text AS "adminRole",
            factor.credential_reference AS "factorReference"
          FROM users
          JOIN auth_credentials AS credentials ON credentials.user_id = users.id
          LEFT JOIN admin_role_grants AS role
            ON role.user_id = users.id
            AND role.revoked_at IS NULL
          LEFT JOIN admin_mfa_factors AS factor
            ON factor.user_id = users.id
            AND factor.revoked_at IS NULL
          WHERE users.id = ${input.account.userId}
        `;
        assertPersistedAccountMatches(input, persistedRows);
        return created.length +
          createdCredentials.length +
          createdAdminRecords >
          0
          ? "CREATED"
          : "UNCHANGED";
      });
    },
  };
  return Object.freeze(persistence);
}

async function insertAdminAccess(
  transaction: TransactionSql,
  input: PersistSyntheticAccountInput,
): Promise<number> {
  const role = input.account.adminRole;
  const factor = input.account.mfaFactor;
  if (role === null || factor === null) return 0;
  const createdRoles = await transaction<{ readonly id: string }[]>`
    INSERT INTO admin_role_grants (
      user_id,
      role,
      grant_source,
      reason,
      granted_at
    ) VALUES (
      ${input.account.userId},
      ${role},
      'BOOTSTRAP',
      'Synthetic non-production test fixture',
      ${input.account.createdAt}
    )
    ON CONFLICT (user_id, role) WHERE revoked_at IS NULL DO NOTHING
    RETURNING id
  `;
  const createdFactors = await transaction<{ readonly id: string }[]>`
    INSERT INTO admin_mfa_factors (
      id,
      user_id,
      kind,
      credential_reference,
      display_label,
      created_at,
      activated_at
    ) VALUES (
      ${factorIdFor(input.account.userId)},
      ${input.account.userId},
      ${factor.kind},
      ${factor.credentialReference},
      ${factor.displayLabel},
      ${input.account.createdAt},
      ${input.account.createdAt}
    )
    ON CONFLICT (credential_reference) WHERE revoked_at IS NULL DO NOTHING
    RETURNING id
  `;
  return createdRoles.length + createdFactors.length;
}

function assertPersistedAccountMatches(
  input: PersistSyntheticAccountInput,
  rows: readonly ExistingAccountRow[],
): void {
  const row = rows[0];
  const expectedRole = input.account.adminRole;
  const expectedFactor = input.account.mfaFactor?.credentialReference ?? null;
  if (
    rows.length !== 1 ||
    row === undefined ||
    row.accountState !== input.account.accountState ||
    row.normalizedEmail !== input.account.normalizedEmail ||
    !row.passwordHashMatches ||
    !row.emailVerified ||
    !row.phoneVerified ||
    row.adminRole !== expectedRole ||
    row.factorReference !== expectedFactor
  ) {
    throw new Error(
      "Existing identity conflicts with the deterministic synthetic fixture.",
    );
  }
}

function factorIdFor(userId: string): string {
  const suffix = Number(userId.slice(-3)) + 100;
  return `00000000-0000-4000-8000-000000000${String(suffix).padStart(3, "0")}`;
}

import type {
  CustomerProfile,
  CustomerProfileId,
  CustomerProfilePersistence,
  EnsureCustomerProfilePersistenceResult,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";

interface OwnerStateRow {
  readonly accountState: "ACTIVE" | "DEACTIVATED" | "SUSPENDED";
}

interface CustomerProfileRow {
  readonly createdAt: Date;
  readonly id: string;
  readonly isIndexable: false;
  readonly isPublic: false;
  readonly ownerUserId: string;
  readonly updatedAt: Date;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Creates the private customer capability lazily while serializing against
 * account-state changes and concurrent first-use attempts on the owner row.
 */
export function createCustomerProfileRepository(
  sql: Sql,
): CustomerProfilePersistence {
  return Object.freeze({
    async ensureForActiveOwner(
      ownerUserId: UserId,
    ): Promise<EnsureCustomerProfilePersistenceResult> {
      assertUserId(ownerUserId);
      return sql.begin(async (transaction) => {
        const [owner] = await transaction<OwnerStateRow[]>`
          SELECT account_state AS "accountState"
          FROM users
          WHERE id = ${ownerUserId}
          FOR UPDATE
        `;
        if (owner?.accountState !== "ACTIVE") {
          return Object.freeze({ status: "ACCOUNT_NOT_ACTIVE" as const });
        }

        const [created] = await transaction<CustomerProfileRow[]>`
          INSERT INTO customer_profiles (owner_user_id)
          VALUES (${ownerUserId})
          ON CONFLICT (owner_user_id) DO NOTHING
          RETURNING
            id,
            owner_user_id AS "ownerUserId",
            is_public AS "isPublic",
            is_indexable AS "isIndexable",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `;
        if (created !== undefined) {
          return Object.freeze({
            profile: toCustomerProfile(created),
            status: "CREATED" as const,
          });
        }

        const [existing] = await transaction<CustomerProfileRow[]>`
          SELECT
            id,
            owner_user_id AS "ownerUserId",
            is_public AS "isPublic",
            is_indexable AS "isIndexable",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM customer_profiles
          WHERE owner_user_id = ${ownerUserId}
        `;
        if (existing === undefined) {
          throw new Error("Customer profile uniqueness invariant failed.");
        }
        return Object.freeze({
          profile: toCustomerProfile(existing),
          status: "EXISTING" as const,
        });
      });
    },
  });
}

function toCustomerProfile(row: CustomerProfileRow): CustomerProfile {
  if (row.isPublic || row.isIndexable) {
    throw new Error("Customer profile privacy invariant failed.");
  }
  return Object.freeze({
    createdAt: row.createdAt,
    id: row.id as CustomerProfileId,
    ownerUserId: row.ownerUserId as UserId,
    publicVisibility: "PRIVATE",
    searchIndexing: "DISALLOWED",
    updatedAt: row.updatedAt,
  });
}

function assertUserId(value: string): void {
  if (!uuidPattern.test(value)) {
    throw new TypeError("Customer profile owner user id must be a UUID.");
  }
}

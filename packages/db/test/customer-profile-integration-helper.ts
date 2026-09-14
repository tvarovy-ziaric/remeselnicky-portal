import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCustomerProfileService, type UserId } from "@portal/domain";

import { createCustomerProfileRepository } from "../src/customer-profile-repository.js";

/** Called by the clean-migration integration suite after migration 0014 exists. */
export async function runCustomerProfileIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const ownerUserId = randomUUID() as UserId;
  await sql`INSERT INTO users (id) VALUES (${ownerUserId})`;
  const persistence = createCustomerProfileRepository(sql);
  const service = createCustomerProfileService({ persistence });

  const attempts = await Promise.all(
    Array.from({ length: 8 }, () => service.ensureForCustomerUse(ownerUserId)),
  );
  expect(attempts.filter(({ status }) => status === "CREATED")).toHaveLength(1);
  expect(attempts.filter(({ status }) => status === "EXISTING")).toHaveLength(
    7,
  );
  expect(new Set(attempts.map(({ profile }) => profile.id)).size).toBe(1);
  expect(attempts[0]?.profile).toMatchObject({
    ownerUserId,
    publicVisibility: "PRIVATE",
    searchIndexing: "DISALLOWED",
  });

  const [profileCount] = await sql<{ readonly count: number }[]>`
    SELECT count(*)::integer AS count
    FROM customer_profiles
    WHERE owner_user_id = ${ownerUserId}
  `;
  expect(profileCount?.count).toBe(1);
  await expect(
    sql`INSERT INTO customer_profiles (owner_user_id) VALUES (${ownerUserId})`,
  ).rejects.toThrow(/customer_profiles_owner_user_id_key/u);

  const privacyOwnerId = randomUUID();
  await sql`INSERT INTO users (id) VALUES (${privacyOwnerId})`;
  await expect(sql`
    INSERT INTO customer_profiles (owner_user_id, is_public)
    VALUES (${privacyOwnerId}, true)
  `).rejects.toThrow(/customer_profiles_never_public/u);
  await expect(sql`
    INSERT INTO customer_profiles (owner_user_id, is_indexable)
    VALUES (${privacyOwnerId}, true)
  `).rejects.toThrow(/customer_profiles_never_indexable/u);

  const suspendedUserId = randomUUID() as UserId;
  const deactivatedUserId = randomUUID() as UserId;
  await sql`
    INSERT INTO users (id, account_state)
    VALUES
      (${suspendedUserId}, 'SUSPENDED'),
      (${deactivatedUserId}, 'DEACTIVATED')
  `;
  for (const inactiveUserId of [suspendedUserId, deactivatedUserId]) {
    await expect(
      service.ensureForCustomerUse(inactiveUserId),
    ).rejects.toMatchObject({
      code: "CUSTOMER_PROFILE_ACCOUNT_NOT_ACTIVE",
    });
  }
  const inactiveCount = await sql<{ readonly count: number }[]>`
    SELECT count(*)::integer AS count
    FROM customer_profiles
    WHERE owner_user_id IN (${suspendedUserId}, ${deactivatedUserId})
  `;
  expect(inactiveCount[0]?.count).toBe(0);
  await expect(sql`
    INSERT INTO customer_profiles (owner_user_id)
    VALUES (${suspendedUserId})
  `).rejects.toThrow(/owner account must be active/u);
  await expect(sql`
    INSERT INTO customer_profiles (owner_user_id)
    VALUES (${deactivatedUserId})
  `).rejects.toThrow(/owner account must be active/u);
  await expect(sql`
    INSERT INTO customer_profiles (owner_user_id)
    VALUES (${randomUUID()})
  `).rejects.toThrow(/owner account must be active/u);

  const racingOwnerId = randomUUID() as UserId;
  await sql`INSERT INTO users (id) VALUES (${racingOwnerId})`;
  let pendingEnsure:
    ReturnType<typeof service.ensureForCustomerUse> | undefined;
  await sql.begin(async (stateChange) => {
    await stateChange`
      SELECT id FROM users WHERE id = ${racingOwnerId} FOR UPDATE
    `;
    pendingEnsure = service.ensureForCustomerUse(racingOwnerId);
    void pendingEnsure.catch(() => undefined);
    await stateChange`
      UPDATE users
      SET
        account_state = 'SUSPENDED',
        account_state_changed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${racingOwnerId}
    `;
    await stateChange`SELECT pg_sleep(0.01)`;
  });
  if (pendingEnsure === undefined) {
    throw new Error("Expected a concurrent customer-profile attempt.");
  }
  await expect(pendingEnsure).rejects.toMatchObject({
    code: "CUSTOMER_PROFILE_ACCOUNT_NOT_ACTIVE",
  });
  const [racingCount] = await sql<{ readonly count: number }[]>`
    SELECT count(*)::integer AS count
    FROM customer_profiles
    WHERE owner_user_id = ${racingOwnerId}
  `;
  expect(racingCount?.count).toBe(0);

  const [persisted] = await sql<
    {
      readonly createdAt: Date;
      readonly id: string;
      readonly ownerUserId: string;
    }[]
  >`
    SELECT
      id,
      owner_user_id AS "ownerUserId",
      created_at AS "createdAt"
    FROM customer_profiles
    WHERE owner_user_id = ${ownerUserId}
  `;
  if (persisted === undefined) throw new Error("Expected customer profile.");
  await expect(sql`
    UPDATE customer_profiles
    SET owner_user_id = ${privacyOwnerId}
    WHERE id = ${persisted.id}
  `).rejects.toThrow(/customer profile identity is immutable/u);
  await expect(sql`
    UPDATE customer_profiles
    SET created_at = ${new Date(persisted.createdAt.valueOf() + 1_000)}
    WHERE id = ${persisted.id}
  `).rejects.toThrow(/customer profile identity is immutable/u);
  await expect(sql`
    DELETE FROM customer_profiles
    WHERE id = ${persisted.id}
  `).rejects.toThrow(/history cannot be deleted by ordinary operation/u);
}

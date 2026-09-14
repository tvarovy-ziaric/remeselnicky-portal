import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createSyntheticAccountFixture } from "../src/index.js";
import { createPostgresSyntheticSeedPersistence } from "../src/postgres.js";

const injectedHash = "opaque-injected-hash-material";

describe("PostgreSQL synthetic seed persistence", () => {
  it("requires an exact database-side non-production marker", async () => {
    const sql = scriptedSql([[{ environment: "production" }]]);
    const persistence = createPostgresSyntheticSeedPersistence(sql);
    await expect(
      persistence.assertTargetEnvironment("staging"),
    ).rejects.toThrow(/marker/u);
  });

  it("reports a completed identity as created and an exact repeat unchanged", async () => {
    const account = createSyntheticAccountFixture("CUSTOMER");
    const matching = persistedRow(account);
    const sql = scriptedSql([
      [{ id: account.userId }],
      [{ userId: account.userId }],
      [matching],
      [],
      [],
      [matching],
    ]);
    const persistence = createPostgresSyntheticSeedPersistence(sql);
    await expect(
      persistence.upsertAccount({ account, passwordHash: injectedHash }),
    ).resolves.toBe("CREATED");
    await expect(
      persistence.upsertAccount({ account, passwordHash: injectedHash }),
    ).resolves.toBe("UNCHANGED");
  });

  it("treats filling an absent credential as a created seed record", async () => {
    const account = createSyntheticAccountFixture("CUSTOMER");
    const sql = scriptedSql([
      [],
      [{ userId: account.userId }],
      [persistedRow(account)],
    ]);
    const persistence = createPostgresSyntheticSeedPersistence(sql);
    await expect(
      persistence.upsertAccount({ account, passwordHash: injectedHash }),
    ).resolves.toBe("CREATED");
  });

  it("fails on an identity collision or any extra active admin join", async () => {
    const account = createSyntheticAccountFixture("ADMIN");
    const matching = persistedRow(account);
    const sql = scriptedSql([
      [],
      [],
      [],
      [],
      [matching, { ...matching, adminRole: "SUPER_ADMIN" }],
    ]);
    const persistence = createPostgresSyntheticSeedPersistence(sql);
    await expect(
      persistence.upsertAccount({ account, passwordHash: injectedHash }),
    ).rejects.toThrow(/conflicts/u);
  });
});

function persistedRow(
  account: ReturnType<typeof createSyntheticAccountFixture>,
) {
  return {
    accountState: account.accountState,
    adminRole: account.adminRole,
    emailVerified: true,
    factorReference: account.mfaFactor?.credentialReference ?? null,
    normalizedEmail: account.normalizedEmail,
    passwordHashMatches: true,
    phoneVerified: true,
  };
}

function scriptedSql(responses: readonly unknown[][]): Sql {
  const queue = [...responses];
  const tagged = vi.fn(() =>
    Promise.resolve(queue.shift() ?? []),
  ) as unknown as Sql;
  Object.assign(tagged, {
    begin: (work: (transaction: Sql) => Promise<unknown>) => work(tagged),
  });
  return tagged;
}

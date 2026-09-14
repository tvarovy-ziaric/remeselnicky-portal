import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import type { UserId } from "@portal/domain";

import { createCustomerProfileRepository } from "../src/index.js";

const ownerUserId = "00000000-0000-4000-8000-000000000221" as UserId;
const row = {
  createdAt: new Date("2026-09-14T10:00:00.000Z"),
  id: "00000000-0000-4000-8000-000000000222",
  isIndexable: false as const,
  isPublic: false as const,
  ownerUserId,
  updatedAt: new Date("2026-09-14T10:00:00.000Z"),
};

describe("CustomerProfile repository", () => {
  it("locks an active owner and lazily creates a private profile", async () => {
    const harness = transactionHarness([[{ accountState: "ACTIVE" }], [row]]);
    const repository = createCustomerProfileRepository(harness.sql);

    await expect(repository.ensureForActiveOwner(ownerUserId)).resolves.toEqual(
      {
        profile: {
          createdAt: row.createdAt,
          id: row.id,
          ownerUserId,
          publicVisibility: "PRIVATE",
          searchIndexing: "DISALLOWED",
          updatedAt: row.updatedAt,
        },
        status: "CREATED",
      },
    );
    expect(harness.begin).toHaveBeenCalledOnce();
    expect(harness.statements[0]).toMatch(/FROM users[\s\S]*FOR UPDATE/u);
    expect(harness.statements[1]).toMatch(
      /ON CONFLICT \(owner_user_id\) DO NOTHING/u,
    );
  });

  it("returns the same existing profile after an idempotent conflict", async () => {
    const harness = transactionHarness([
      [{ accountState: "ACTIVE" }],
      [],
      [row],
    ]);
    const repository = createCustomerProfileRepository(harness.sql);

    const result = await repository.ensureForActiveOwner(ownerUserId);

    expect(result.status).toBe("EXISTING");
    if (result.status !== "EXISTING") {
      throw new Error("Expected an existing customer profile.");
    }
    expect(result.profile.id).toBe(row.id);
    expect(result.profile.ownerUserId).toBe(ownerUserId);
    expect(harness.statements).toHaveLength(3);
  });

  it.each(["SUSPENDED", "DEACTIVATED", undefined] as const)(
    "does not create a profile when owner state is %s",
    async (accountState) => {
      const harness = transactionHarness([
        accountState === undefined ? [] : [{ accountState }],
      ]);
      const repository = createCustomerProfileRepository(harness.sql);

      await expect(
        repository.ensureForActiveOwner(ownerUserId),
      ).resolves.toEqual({ status: "ACCOUNT_NOT_ACTIVE" });
      expect(harness.statements).toHaveLength(1);
    },
  );

  it("rejects malformed owner identity before opening a transaction", async () => {
    const harness = transactionHarness([]);
    const repository = createCustomerProfileRepository(harness.sql);

    await expect(
      repository.ensureForActiveOwner("not-a-user-id" as UserId),
    ).rejects.toThrow(/owner user id must be a UUID/u);
    expect(harness.begin).not.toHaveBeenCalled();
  });

  it("rejects any persisted privacy invariant violation", async () => {
    const harness = transactionHarness([
      [{ accountState: "ACTIVE" }],
      [{ ...row, isPublic: true }],
    ]);
    const repository = createCustomerProfileRepository(harness.sql);

    await expect(repository.ensureForActiveOwner(ownerUserId)).rejects.toThrow(
      /privacy invariant/u,
    );
  });
});

function transactionHarness(responses: readonly unknown[][]): {
  readonly begin: ReturnType<typeof vi.fn>;
  readonly sql: Sql;
  readonly statements: string[];
} {
  const queue = [...responses];
  const statements: string[] = [];
  const transaction = vi.fn((strings: TemplateStringsArray) => {
    statements.push(strings.join("?"));
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as Sql;
  const begin = vi.fn((work: (transaction: Sql) => Promise<unknown>) =>
    work(transaction),
  );
  const sql = Object.assign(vi.fn(), { begin }) as unknown as Sql;
  return { begin, sql, statements };
}

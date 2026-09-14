import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import type { CraftsmanProfileId, UserId } from "@portal/domain";

import { createCraftsmanProfileRepository } from "../src/index.js";

const ownerUserId = "00000000-0000-4000-8000-000000001521" as UserId;
const otherUserId = "00000000-0000-4000-8000-000000001522" as UserId;
const profileId = "00000000-0000-4000-8000-000000001523" as CraftsmanProfileId;
const createdAt = new Date("2026-09-14T10:00:00.000Z");
const individualRow = {
  about: null,
  companyRegistrationNumber: null,
  companyRegistrationVerificationReference: null,
  companyRegistrationVerifiedAt: null,
  createdAt,
  id: profileId,
  identityVerificationReference: null,
  identityVerifiedAt: null,
  nickname: null,
  officialCompanyName: null,
  ownerUserId,
  profileType: "INDIVIDUAL" as const,
  realFirstName: null,
  realLastName: null,
  revision: 1,
  updatedAt: createdAt,
};

describe("CraftsmanProfile repository", () => {
  it("locks an ACTIVE owner and creates one incomplete private draft", async () => {
    const harness = transactionHarness([
      [{ accountState: "ACTIVE" }],
      [],
      [individualRow],
    ]);
    const repository = createCraftsmanProfileRepository(harness.sql);

    const result = await repository.createPrivateDraft({
      actorUserId: ownerUserId,
      profileType: "INDIVIDUAL",
    });
    expect(result.status).toBe("CREATED");
    if (!("profile" in result)) {
      throw new Error("Expected a created unit-test profile.");
    }
    expect(result.profile).toMatchObject({
      id: profileId,
      identityVerification: null,
      ownerUserId,
      profileType: "INDIVIDUAL",
      revision: 1,
    });
    expect(harness.statements[0]).toMatch(/FROM users[\s\S]*FOR UPDATE/u);
    expect(harness.statements[1]).toMatch(
      /FROM craftsman_profiles[\s\S]*owner_user_id/u,
    );
    expect(harness.statements[2]).toContain("INSERT INTO craftsman_profiles");
    expect(harness.statements.join("\n")).not.toMatch(
      /identity_verification_reference\s*\)/u,
    );
  });

  it.each(["SUSPENDED", "DEACTIVATED", undefined] as const)(
    "refuses draft creation when owner state is %s",
    async (accountState) => {
      const harness = transactionHarness([
        accountState === undefined ? [] : [{ accountState }],
      ]);
      const repository = createCraftsmanProfileRepository(harness.sql);

      await expect(
        repository.createPrivateDraft({
          actorUserId: ownerUserId,
          profileType: "COMPANY",
        }),
      ).resolves.toEqual({ status: "OWNER_NOT_ACTIVE" });
      expect(harness.statements).toHaveLength(1);
    },
  );

  it("is idempotent for the same owner and rejects a conflicting second type", async () => {
    const same = transactionHarness([
      [{ accountState: "ACTIVE" }],
      [individualRow],
    ]);
    await expect(
      createCraftsmanProfileRepository(same.sql).createPrivateDraft({
        actorUserId: ownerUserId,
        profileType: "INDIVIDUAL",
      }),
    ).resolves.toMatchObject({ status: "UNCHANGED" });

    const conflict = transactionHarness([
      [{ accountState: "ACTIVE" }],
      [individualRow],
    ]);
    await expect(
      createCraftsmanProfileRepository(conflict.sql).createPrivateDraft({
        actorUserId: ownerUserId,
        profileType: "COMPANY",
      }),
    ).resolves.toEqual({ status: "ALREADY_EXISTS" });
  });

  it("replaces owner draft details with a locked compare-and-set command", async () => {
    const updatedAt = new Date("2026-09-14T10:01:00.000Z");
    const updated = {
      ...individualRow,
      about: "Poctivá remeselná práca",
      nickname: "Majster Jano",
      realFirstName: "Ján",
      realLastName: "Remeselník",
      revision: 2,
      updatedAt,
    };
    const harness = transactionHarness([
      [{ ...individualRow, ownerAccountState: "ACTIVE" }],
      [updated],
    ]);
    const repository = createCraftsmanProfileRepository(harness.sql);

    const result = await repository.replacePrivateDraft({
      about: updated.about,
      actorUserId: ownerUserId,
      expectedRevision: 1,
      nickname: updated.nickname,
      profileId,
      profileType: "INDIVIDUAL",
      realFirstName: updated.realFirstName,
      realLastName: updated.realLastName,
    });
    expect(result.status).toBe("UPDATED");
    if (!("profile" in result)) {
      throw new Error("Expected an updated unit-test profile.");
    }
    expect(result.profile).toMatchObject({
      about: updated.about,
      nickname: updated.nickname,
      revision: 2,
    });
    expect(harness.statements[0]).toMatch(
      /FOR UPDATE OF craftsman_profiles, users/u,
    );
    expect(harness.statements[1]).toMatch(
      /WHERE id = [\s\S]*owner_user_id = [\s\S]*revision =/u,
    );
    expect(harness.statements[1]).toContain(
      "identity_verification_reference = CASE",
    );
  });

  it("treats an exact retry as unchanged even after its original revision advanced", async () => {
    const committed = {
      ...individualRow,
      about: "Uložené",
      ownerAccountState: "ACTIVE" as const,
      revision: 2,
    };
    const harness = transactionHarness([[committed]]);
    const repository = createCraftsmanProfileRepository(harness.sql);

    await expect(
      repository.replacePrivateDraft({
        about: "Uložené",
        actorUserId: ownerUserId,
        expectedRevision: 1,
        nickname: null,
        profileId,
        profileType: "INDIVIDUAL",
        realFirstName: null,
        realLastName: null,
      }),
    ).resolves.toMatchObject({ status: "UNCHANGED" });
    expect(harness.statements).toHaveLength(1);
  });

  it("returns explicit inactive, stale and type mismatch outcomes", async () => {
    const inactive = transactionHarness([
      [{ ...individualRow, ownerAccountState: "SUSPENDED" }],
    ]);
    await expect(
      createCraftsmanProfileRepository(inactive.sql).replacePrivateDraft(
        individualReplacement(),
      ),
    ).resolves.toEqual({ status: "OWNER_NOT_ACTIVE" });

    const stale = transactionHarness([
      [{ ...individualRow, ownerAccountState: "ACTIVE", revision: 2 }],
    ]);
    await expect(
      createCraftsmanProfileRepository(stale.sql).replacePrivateDraft(
        individualReplacement(),
      ),
    ).resolves.toEqual({ status: "STALE_REVISION" });

    const mismatch = transactionHarness([
      [{ ...individualRow, ownerAccountState: "ACTIVE" }],
    ]);
    await expect(
      createCraftsmanProfileRepository(mismatch.sql).replacePrivateDraft({
        about: null,
        actorUserId: ownerUserId,
        companyRegistrationNumber: null,
        expectedRevision: 1,
        officialCompanyName: null,
        profileId,
        profileType: "COMPANY",
      }),
    ).resolves.toEqual({ status: "PROFILE_TYPE_MISMATCH" });
  });

  it("uses owner scoping as the object authorization boundary", async () => {
    const notOwned = transactionHarness([[]]);
    await expect(
      createCraftsmanProfileRepository(notOwned.sql).replacePrivateDraft({
        ...individualReplacement(),
        actorUserId: otherUserId,
      }),
    ).resolves.toEqual({ status: "NOT_FOUND" });

    const statements: string[] = [];
    const sql = vi.fn((strings: TemplateStringsArray) => {
      statements.push(strings.join("?"));
      return Promise.resolve([]);
    }) as unknown as Sql;
    await expect(
      createCraftsmanProfileRepository(sql).findOwnedPrivateDraft(
        otherUserId,
        profileId,
      ),
    ).resolves.toBeNull();
    expect(statements[0]).toMatch(
      /JOIN users[\s\S]*account_state = 'ACTIVE'[\s\S]*id = [\s\S]*owner_user_id =/u,
    );
  });
});

function individualReplacement() {
  return {
    about: "Novší obsah",
    actorUserId: ownerUserId,
    expectedRevision: 1,
    nickname: null,
    profileId,
    profileType: "INDIVIDUAL" as const,
    realFirstName: null,
    realLastName: null,
  };
}

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

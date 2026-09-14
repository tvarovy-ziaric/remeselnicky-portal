import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  SYNTHETIC_ACCOUNT_KINDS,
  applySyntheticSeedCatalog,
  createSyntheticAccountFixture,
  createSyntheticSeedCatalog,
  prepareProfessionTaxonomySeeds,
  prepareSlovakLocationSeeds,
  type PersistSyntheticAccountInput,
  type SeedWriteResult,
  type SyntheticSeedPersistence,
} from "../src/index.js";

describe("deterministic synthetic account factories", () => {
  it("covers every D30 identity/account-state scenario deterministically", () => {
    const first = createSyntheticSeedCatalog();
    const second = createSyntheticSeedCatalog();

    expect(first).toEqual(second);
    expect(first.accounts.map(({ accountKind }) => accountKind)).toEqual(
      SYNTHETIC_ACCOUNT_KINDS,
    );
    expect(first.accounts).toHaveLength(7);
    expect(first.accounts.every(({ synthetic }) => synthetic)).toBe(true);
    expect(
      first.accounts.every(({ analyticsActor }) => analyticsActor.is_test),
    ).toBe(true);
    expect(
      first.accounts.every(
        ({ emailVerifiedAt, phoneVerifiedAt }) =>
          emailVerifiedAt instanceof Date && phoneVerifiedAt instanceof Date,
      ),
    ).toBe(true);
    expect(
      first.accounts.find(({ accountKind }) => accountKind === "SUSPENDED"),
    ).toMatchObject({ accountState: "SUSPENDED" });
  });

  it("models customer and craftsman capabilities as non-exclusive profiles", () => {
    expect(
      createSyntheticAccountFixture("CUSTOMER").profileCapabilities,
    ).toEqual({
      craftsman: false,
      craftsmanProfileKind: null,
      customer: true,
    });
    expect(
      createSyntheticAccountFixture("CRAFTSMAN_INDIVIDUAL").profileCapabilities,
    ).toEqual({
      craftsman: true,
      craftsmanProfileKind: "INDIVIDUAL",
      customer: false,
    });
    expect(
      createSyntheticAccountFixture("CRAFTSMAN_COMPANY").profileCapabilities,
    ).toEqual({
      craftsman: true,
      craftsmanProfileKind: "COMPANY",
      customer: false,
    });
    expect(
      createSyntheticAccountFixture("COMBINED").profileCapabilities,
    ).toEqual({
      craftsman: true,
      craftsmanProfileKind: "INDIVIDUAL",
      customer: true,
    });
  });

  it("uses only opaque MFA references and no credential material in fixtures", () => {
    for (const kind of ["ADMIN", "SUPERADMIN"] as const) {
      const fixture = createSyntheticAccountFixture(kind);
      expect(fixture.adminRole).toBe(
        kind === "ADMIN" ? "ADMIN" : "SUPER_ADMIN",
      );
      expect(fixture.mfaFactor?.credentialReference).toMatch(
        /^test-fixture:mfa\/\d{3}$/u,
      );
      expect(JSON.stringify(fixture)).not.toMatch(
        /password|token|otp|secret|private.?key/iu,
      );
    }
  });

  it("returns immutable independent factory values", () => {
    const first = createSyntheticAccountFixture("CUSTOMER");
    const second = createSyntheticAccountFixture("CUSTOMER");
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.analyticsActor)).toBe(true);
    expect(first.createdAt).not.toBe(second.createdAt);
  });
});

describe("location and profession seed mechanisms", () => {
  it("keeps R0 locations Slovak and profession entries explicit placeholders", () => {
    const catalog = createSyntheticSeedCatalog();
    expect(
      catalog.locations.every(({ countryCode }) => countryCode === "SK"),
    ).toBe(true);
    expect(
      catalog.professions.every(
        ({ placeholder, synthetic }) => placeholder && synthetic,
      ),
    ).toBe(true);
  });

  it("rejects duplicate, orphaned and cyclic Slovak location data", () => {
    const base = {
      code: "SK:ROOT",
      countryCode: "SK" as const,
      displayName: "Synthetic root",
      kind: "REGION" as const,
      parentCode: null,
      synthetic: true,
    };
    expect(() => prepareSlovakLocationSeeds([base, base])).toThrow(
      /Duplicate/u,
    );
    expect(() =>
      prepareSlovakLocationSeeds([{ ...base, parentCode: "SK:MISSING" }]),
    ).toThrow(/Unknown/u);
    expect(() =>
      prepareSlovakLocationSeeds([
        { ...base, parentCode: "SK:CHILD" },
        { ...base, code: "SK:CHILD", parentCode: "SK:ROOT" },
      ]),
    ).toThrow(/cycle/u);
  });

  it("rejects profession content that pretends to be final in R0", () => {
    expect(() =>
      prepareProfessionTaxonomySeeds([
        {
          code: "TEST:PLUMBER",
          displayName: "Placeholder",
          placeholder: false,
          synthetic: true,
        },
      ]),
    ).toThrow(/placeholders/u);
  });

  it("keeps the checked-in interchange fixtures aligned with validated constants", () => {
    const catalog = createSyntheticSeedCatalog();
    const locations: unknown = JSON.parse(
      readFileSync(
        new URL("../fixtures/slovak-locations.synthetic.json", import.meta.url),
        "utf8",
      ),
    );
    const professions: unknown = JSON.parse(
      readFileSync(
        new URL(
          "../fixtures/profession-taxonomy.placeholder.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(locations).toMatchObject({
      dataClass: "synthetic",
      locations: catalog.locations,
      schemaVersion: 1,
    });
    expect(professions).toMatchObject({
      dataClass: "synthetic",
      professions: catalog.professions,
      schemaVersion: 1,
    });
  });
});

describe("synthetic seed runner", () => {
  it.each(["production", undefined, "preview"])(
    "fails closed for environment %s before persistence or hash access",
    async (environment) => {
      const persistence = memoryPersistence();
      const passwordHashFor = vi.fn(() =>
        Promise.resolve("opaque-injected-hash-material"),
      );
      await expect(
        applySyntheticSeedCatalog({
          catalog: createSyntheticSeedCatalog(),
          credentialHashes: {
            kind: "TEST_ONLY_HASH_PROVIDER",
            passwordHashFor,
          },
          environment,
          persistence,
        }),
      ).rejects.toThrow(/allowed only/u);
      expect(persistence.assertTargetEnvironmentMock).not.toHaveBeenCalled();
      expect(passwordHashFor).not.toHaveBeenCalled();
    },
  );

  it("checks the database-side marker before requesting credential hashes", async () => {
    const passwordHashFor = vi.fn(() =>
      Promise.resolve("opaque-injected-hash-material"),
    );
    const persistence = memoryPersistence(true);
    await expect(
      applySyntheticSeedCatalog({
        catalog: createSyntheticSeedCatalog(),
        credentialHashes: { kind: "TEST_ONLY_HASH_PROVIDER", passwordHashFor },
        environment: "staging",
        persistence,
      }),
    ).rejects.toThrow(/marker/u);
    expect(passwordHashFor).not.toHaveBeenCalled();
    expect(persistence.upsertAccountMock).not.toHaveBeenCalled();
  });

  it("is repeatable and reports unchanged deterministic records", async () => {
    const persistence = memoryPersistence();
    const input = {
      catalog: createSyntheticSeedCatalog(),
      credentialHashes: {
        kind: "TEST_ONLY_HASH_PROVIDER" as const,
        passwordHashFor: () => Promise.resolve("opaque-injected-hash-material"),
      },
      environment: "test",
      persistence,
    };
    await expect(applySyntheticSeedCatalog(input)).resolves.toEqual({
      created: 7,
      environment: "test",
      unchanged: 0,
    });
    await expect(applySyntheticSeedCatalog(input)).resolves.toEqual({
      created: 0,
      environment: "test",
      unchanged: 7,
    });
  });

  it("rejects malformed injected hashes without persisting them", async () => {
    const persistence = memoryPersistence();
    await expect(
      applySyntheticSeedCatalog({
        catalog: createSyntheticSeedCatalog(),
        credentialHashes: {
          kind: "TEST_ONLY_HASH_PROVIDER",
          passwordHashFor: () => Promise.resolve("not-a-hash"),
        },
        environment: "development",
        persistence,
      }),
    ).rejects.toThrow(/opaque/u);
    expect(persistence.upsertAccountMock).not.toHaveBeenCalled();
  });
});

function memoryPersistence(markerFailure = false): SyntheticSeedPersistence & {
  readonly assertTargetEnvironmentMock: ReturnType<typeof vi.fn>;
  readonly upsertAccountMock: ReturnType<typeof vi.fn>;
} {
  const ids = new Set<string>();
  const assertTargetEnvironment = vi.fn(() =>
    markerFailure
      ? Promise.reject(new Error("Database environment marker mismatch"))
      : Promise.resolve(),
  );
  const upsertAccountMock = vi.fn(
    (input: PersistSyntheticAccountInput): Promise<SeedWriteResult> => {
      const exists = ids.has(input.account.userId);
      ids.add(input.account.userId);
      return Promise.resolve(exists ? "UNCHANGED" : "CREATED");
    },
  );
  return {
    assertTargetEnvironment: () => assertTargetEnvironment(),
    assertTargetEnvironmentMock: assertTargetEnvironment,
    kind: "SYNTHETIC_SEED_PERSISTENCE",
    upsertAccount: (input) => upsertAccountMock(input),
    upsertAccountMock,
  };
}

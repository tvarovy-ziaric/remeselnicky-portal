import { describe, expect, it, vi } from "vitest";

import {
  createManagedCatalogV1Release,
  PLACEHOLDER_ALPHA_TAXONOMY,
  createProfessionTaxonomyService,
  prepareProfessionTaxonomyRelease,
  type ProfessionTaxonomyPersistence,
  type ProfessionTaxonomyReleaseSeed,
  type PreparedProfessionTaxonomyRelease,
  type TaxonomyActivationInput,
} from "../src/index.js";

describe("managed profession/service catalog v1", () => {
  it("ships a bounded deterministic Slovak catalog with a richer alias layer", () => {
    const identity = {
      releaseId: "10000000-0000-4000-8000-000000000001",
      supersedesReleaseId: null,
      version: 1,
    } as const;
    const first = prepareProfessionTaxonomyRelease(
      createManagedCatalogV1Release(identity),
    );
    const second = prepareProfessionTaxonomyRelease(
      createManagedCatalogV1Release(identity),
    );

    expect(first.professions).toHaveLength(45);
    expect(first.services).toHaveLength(180);
    expect(first.aliases.length).toBeGreaterThan(450);
    expect(first.checksumSha256).toBe(second.checksumSha256);
    expect(first.professions).toContainEqual(
      expect.objectContaining({
        code: "PROF:ELECTRICIAN",
        labelSk: "Elektrikár",
      }),
    );
    expect(first.services).toContainEqual(
      expect.objectContaining({
        code: "SERV:VINYL_FLOOR",
        labelSk: "Pokládka vinylovej podlahy",
      }),
    );
    expect(first.aliases).toContainEqual(
      expect.objectContaining({
        alias: "elektro",
        targetCode: "PROF:ELECTRICIAN",
        targetKind: "PROFESSION",
      }),
    );
  });

  it("keeps staging-only synthetic content out unless explicitly requested", () => {
    const base = {
      releaseId: "10000000-0000-4000-8000-000000000001",
      supersedesReleaseId: null,
      version: 1,
    } as const;
    expect(
      createManagedCatalogV1Release(base).professions.some(
        ({ code }) => code === "PROF:ALPHA_SYNTHETIC",
      ),
    ).toBe(false);
    expect(
      createManagedCatalogV1Release({
        ...base,
        includeSyntheticFixture: true,
      }).professions.some(({ code }) => code === "PROF:ALPHA_SYNTHETIC"),
    ).toBe(true);
  });

  it("requires every service routing profession to be an explicit service link", () => {
    const release = createManagedCatalogV1Release({
      releaseId: "10000000-0000-4000-8000-000000000001",
      supersedesReleaseId: null,
      version: 1,
    });
    expect(() =>
      prepareProfessionTaxonomyRelease({
        ...release,
        services: release.services.map((service, index) =>
          index === 0
            ? { ...service, primaryProfessionCode: "PROF:NOT_LINKED" }
            : service,
        ),
      }),
    ).toThrow(/Service profession links are invalid/u);
  });
});

describe("profession taxonomy release governance", () => {
  it("produces a deterministic, immutable placeholder seed", () => {
    const prepared = prepareProfessionTaxonomyRelease(reverseSeed());
    expect(prepared.checksumSha256).toBe(
      PLACEHOLDER_ALPHA_TAXONOMY.checksumSha256,
    );
    expect(prepared.contentClass).toBe("PLACEHOLDER");
    expect(prepared.reviewState).toBe("HUMAN_REVIEW_PENDING");
    expect(Object.isFrozen(prepared.professions)).toBe(true);
  });

  it("rejects duplicate codes and slugs", () => {
    expect(() =>
      prepareProfessionTaxonomyRelease({
        ...baseSeed(),
        professions: [
          ...baseSeed().professions,
          { ...baseSeed().professions[0]!, code: "TEST:PROFESSION_C" },
        ],
      }),
    ).toThrow(/Duplicate profession slug/u);
    expect(() =>
      prepareProfessionTaxonomyRelease({
        ...baseSeed(),
        professions: [
          ...baseSeed().professions,
          { ...baseSeed().professions[0]! },
        ],
      }),
    ).toThrow(/Duplicate profession identifier/u);
  });

  it("rejects invalid hierarchy and replacement history", () => {
    expect(() =>
      prepareProfessionTaxonomyRelease({
        ...baseSeed(),
        specializations: [
          {
            ...baseSeed().specializations[0]!,
            professionCode: "TEST:UNKNOWN",
          },
        ],
      }),
    ).toThrow(/unknown profession/u);
    expect(() =>
      prepareProfessionTaxonomyRelease({
        ...baseSeed(),
        professions: [
          {
            ...baseSeed().professions[0]!,
            replacedByCode: "TEST:PROFESSION_A",
            state: "DEPRECATED",
          },
          baseSeed().professions[1]!,
        ],
      }),
    ).toThrow(/replacement target/u);
    expect(() =>
      prepareProfessionTaxonomyRelease({
        ...baseSeed(),
        professions: [
          {
            ...baseSeed().professions[0]!,
            replacedByCode: "TEST:PROFESSION_B",
            state: "DEPRECATED",
          },
          {
            ...baseSeed().professions[1]!,
            replacedByCode: "TEST:PROFESSION_A",
            state: "DEPRECATED",
          },
        ],
      }),
    ).toThrow(/cycle/u);
  });

  it("rejects aliases that conflict with canonical slugs or unknown targets", () => {
    expect(() =>
      prepareProfessionTaxonomyRelease({
        ...baseSeed(),
        aliases: [
          {
            alias: "synteticke-remeslo-a",
            kind: "SEARCH_TERM",
            targetCode: "TEST:PROFESSION_A",
            targetKind: "PROFESSION",
          },
        ],
      }),
    ).toThrow(/conflicts/u);
    expect(() =>
      prepareProfessionTaxonomyRelease({
        ...baseSeed(),
        aliases: [
          {
            alias: "stary-nazov",
            kind: "LEGACY_SLUG",
            targetCode: "TEST:MISSING",
            targetKind: "SPECIALIZATION",
          },
        ],
      }),
    ).toThrow(/target/u);
  });

  it("rejects invalid versions and unreviewed canonical content", () => {
    expect(() =>
      prepareProfessionTaxonomyRelease({ ...baseSeed(), version: 2 }),
    ).toThrow(/supersession/u);
    expect(() =>
      prepareProfessionTaxonomyRelease({
        ...baseSeed(),
        contentClass: "CANONICAL",
      }),
    ).toThrow(/governance/u);
  });

  it("keeps credentials and reputation out of capability criteria", () => {
    expect(JSON.stringify(PLACEHOLDER_ALPHA_TAXONOMY)).not.toMatch(
      /licen|credential|rating|reputation|hviezd/iu,
    );
    expect(
      PLACEHOLDER_ALPHA_TAXONOMY.capabilityCriteria.every(({ level }) =>
        ["ADVANCED", "MASTER"].includes(level),
      ),
    ).toBe(true);
  });
});

describe("taxonomy service", () => {
  it("prepares a release before persistence and supports idempotent result", async () => {
    const persistence = memoryPersistence();
    const service = createProfessionTaxonomyService({ persistence });
    await expect(service.installRelease(baseSeed())).resolves.toBe("CREATED");
    await expect(service.installRelease(baseSeed())).resolves.toBe("UNCHANGED");
    expect(persistence.install).toHaveBeenCalledTimes(2);
  });

  it("validates activation references before persistence", () => {
    const persistence = memoryPersistence();
    const service = createProfessionTaxonomyService({ persistence });
    expect(() =>
      service.activateRelease({
        activationId: PLACEHOLDER_ALPHA_TAXONOMY.releaseId,
        actorReference: "invalid space",
        previousReleaseId: null,
        releaseId: PLACEHOLDER_ALPHA_TAXONOMY.releaseId,
        reviewReference: "review:approved/1301",
      }),
    ).toThrow(/invalid/u);
    expect(persistence.activate).not.toHaveBeenCalled();
  });
});

function baseSeed(): ProfessionTaxonomyReleaseSeed {
  const source = PLACEHOLDER_ALPHA_TAXONOMY;
  return structuredClone({
    aliases: source.aliases,
    capabilityCriteria: source.capabilityCriteria,
    contentClass: source.contentClass,
    professions: source.professions,
    releaseId: source.releaseId,
    reviewReference: source.reviewReference,
    reviewState: source.reviewState,
    services: source.services,
    specializations: source.specializations,
    supersedesReleaseId: source.supersedesReleaseId,
    version: source.version,
  });
}

function reverseSeed(): ProfessionTaxonomyReleaseSeed {
  const seed = baseSeed();
  return {
    ...seed,
    professions: [...seed.professions].reverse(),
  };
}

function memoryPersistence(): ProfessionTaxonomyPersistence & {
  activate: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
} {
  let installed = false;
  const activate = vi.fn<(input: TaxonomyActivationInput) => Promise<boolean>>(
    () => Promise.resolve(true),
  );
  const install = vi.fn<
    (
      release: PreparedProfessionTaxonomyRelease,
    ) => Promise<"CREATED" | "UNCHANGED">
  >(() => {
    const result: "CREATED" | "UNCHANGED" = installed ? "UNCHANGED" : "CREATED";
    installed = true;
    return Promise.resolve(result);
  });
  return {
    activate,
    activateRelease: (input) => activate(input),
    install,
    installRelease: (release) => install(release),
    listCurrentProfessions: () => Promise.resolve([]),
  };
}

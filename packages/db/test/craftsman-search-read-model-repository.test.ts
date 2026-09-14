import type { CraftsmanProfileId } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createCraftsmanSearchReadModelRepository } from "../src/craftsman-search-read-model-repository.js";

const profileId = "91000000-0000-4000-8000-000000000001" as CraftsmanProfileId;
const mediaAssetId = "91000000-0000-4000-8000-000000000002";

describe("craftsman search read model repository", () => {
  it("rejects malformed input before opening a snapshot", async () => {
    const sql = scriptedSql([]);
    await expect(sqlRepository(sql).search({ limit: 51 })).rejects.toThrow();
    expect(sql.beginOptions).toEqual([]);
    expect(sql.queries).toEqual([]);
  });

  it("returns only the allowlisted, cold-start-neutral candidate DTO", async () => {
    const sql = scriptedSql(completeResponses());
    const result = await sqlRepository(sql).search({
      identityQuery: "  Ďuriš  ",
      limit: 10,
    });

    expect(sql.beginOptions).toEqual([
      "isolation level repeatable read read only",
    ]);
    expect(result).toMatchObject({
      items: [
        {
          profileId,
          identity: { primaryName: "Majster Ďuriš" },
          experience: { source: "SELF_DECLARED", workingSinceYear: 2012 },
          indicativePricing: [
            { amountCents: 2500, currency: "EUR", mode: "HOURLY" },
          ],
          professions: [
            {
              declaredLevel: "MASTER",
              evidenceSupportedLevel: null,
            },
          ],
          signals: {
            availability: { hasDeclaredAvailability: false },
            portfolio: { representativeMediaAssetId: mediaAssetId },
            trust: {
              customerScore: null,
              reviewCount: 0,
              reviewSampleSufficient: false,
              verifiedWorkCount: 0,
            },
          },
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /ownerUser|email|phone|address|centroid|latitude|longitude|storage|sha256|customerName|completeness|rankScore/iu,
    );
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0]?.professions)).toBe(true);
    expect(Object.isFrozen(result.items[0]?.signals.portfolio.skillCodes)).toBe(
      true,
    );

    const baseQuery = sql.queries[0] ?? "";
    expect(baseQuery).toContain("current_searchable_craftsman_profiles");
    expect(baseQuery).toContain("craftsman_search_normalize_text");
    expect(baseQuery).toContain("ORDER BY profile.craftsman_profile_id");
    expect(baseQuery).not.toContain("Ďuriš");
    expect(sql.queries.join("\n")).not.toMatch(
      /credential_claim_evidence|current_craftsman_availability_blocks|storage_key|public_url|content_sha256/iu,
    );
  });

  it("fails closed for unsafe display data without leaking the row", async () => {
    const responses = completeResponses();
    responses[0] = [
      {
        ...(responses[0]?.[0] as Record<string, unknown>),
        primaryName: "Kontakt owner@example.test",
      },
    ];
    await expect(
      sqlRepository(scriptedSql(responses)).search({}),
    ).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("uses the last raw row as an opaque deterministic cursor", async () => {
    const secondId = "91000000-0000-4000-8000-000000000003";
    const responses = completeResponses();
    responses[0] = [
      responses[0]?.[0],
      {
        ...(responses[0]?.[0] as Record<string, unknown>),
        profileId: secondId,
      },
    ];
    const result = await sqlRepository(scriptedSql(responses)).search({
      limit: 1,
    });
    expect(result.nextCursor).toBe(profileId);
    expect(result.items).toHaveLength(1);
  });

  it("advances the cursor even when a corrupt row is filtered fail-closed", async () => {
    const responses = completeResponses();
    responses[0] = [
      {
        ...(responses[0]?.[0] as Record<string, unknown>),
        identityVerified: "true",
      },
      {
        ...(responses[0]?.[0] as Record<string, unknown>),
        profileId: "91000000-0000-4000-8000-000000000003",
      },
    ];
    const result = await sqlRepository(scriptedSql(responses)).search({
      limit: 1,
    });
    expect(result).toEqual({ items: [], nextCursor: profileId });
  });

  it.each([
    [
      "boolean",
      (responses: unknown[][]) => setBase(responses, "identityVerified", 1),
    ],
    [
      "score",
      (responses: unknown[][]) => setBase(responses, "customerScore", 6),
    ],
    [
      "radius",
      (responses: unknown[][]) =>
        setBase(responses, "normalRadiusMeters", 20_040_001),
    ],
    [
      "experience",
      (responses: unknown[][]) => setBase(responses, "workingSinceYear", 1799),
    ],
    [
      "municipality",
      (responses: unknown[][]) =>
        setBase(responses, "baseMunicipalityCode", "owner@example.test"),
    ],
    [
      "profession code",
      (responses: unknown[][]) =>
        setChild(responses, 1, "code", "owner@example.test"),
    ],
    [
      "credential code",
      (responses: unknown[][]) =>
        setChild(responses, 4, "credentialTypeCode", "Owner Email"),
    ],
    [
      "zero price",
      (responses: unknown[][]) => setChild(responses, 5, "amountCents", 0),
    ],
  ])("filters a corrupt %s field", async (_name, mutate) => {
    const responses = completeResponses();
    mutate(responses);
    await expect(
      sqlRepository(scriptedSql(responses)).search({}),
    ).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });
});

interface ScriptedSql extends Sql {
  readonly beginOptions: string[];
  readonly queries: string[];
}

function sqlRepository(sql: Sql) {
  return createCraftsmanSearchReadModelRepository(sql);
}

function scriptedSql(responses: unknown[][]): ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  const beginOptions: string[] = [];
  const tagged = vi.fn((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as ScriptedSql;
  Object.assign(tagged, {
    begin: (options: string, work: (transaction: Sql) => Promise<unknown>) => {
      beginOptions.push(options);
      return work(tagged);
    },
    beginOptions,
    queries,
  });
  return tagged;
}

function completeResponses(): unknown[][] {
  return [
    [
      {
        profileId,
        profileType: "INDIVIDUAL",
        primaryName: "Majster Ďuriš",
        secondaryName: "Jozef Ďuriš",
        baseMunicipalityCode: "SK0101528595",
        baseMunicipalityName: "Bratislava",
        normalRadiusMeters: 25_000,
        maximumRadiusMeters: 50_000,
        extraMunicipalityCodes: ["SK0102528596"],
        identityVerified: true,
        companyRegistrationVerified: false,
        hasDeclaredAvailability: false,
        hasVerifiedEvidence: false,
        hasUnverifiedContent: true,
        portfolioProfessionCodes: ["PROF:CARPENTER"],
        portfolioSpecializationCodes: ["SPEC:CABINET"],
        portfolioSkillCodes: ["SKILL:FURNITURE"],
        representativeMediaAssetId: mediaAssetId,
        customerScore: null,
        reviewCount: 0,
        reviewSampleSufficient: false,
        verifiedWorkCount: 0,
        workingSinceYear: 2012,
        ownerUserId: "must-not-pass",
        exactAddress: "must-not-pass",
      },
    ],
    [
      {
        profileId,
        code: "PROF:CARPENTER",
        label: "Stolár",
        declaredLevel: "MASTER",
        evidenceSupportedLevel: null,
      },
    ],
    [
      {
        profileId,
        code: "SPEC:CABINET",
        label: "Nábytkárstvo",
        professionCode: "PROF:CARPENTER",
        evidenceSupported: false,
      },
    ],
    [
      {
        profileId,
        canonicalCode: "SKILL:FURNITURE",
        label: "Výroba nábytku",
        professionCodes: ["PROF:CARPENTER"],
        evidenceSupported: false,
      },
    ],
    [
      {
        profileId,
        credentialTypeCode: "trade.woodwork",
        professionCode: "PROF:CARPENTER",
        expiresOn: null,
      },
    ],
    [
      {
        profileId,
        serviceName: "Hodinová práca",
        mode: "HOURLY",
        amountCents: "2500",
        currency: "EUR",
        professionCode: "PROF:CARPENTER",
      },
    ],
  ];
}

function setBase(responses: unknown[][], field: string, value: unknown): void {
  responses[0] = [{ ...(responses[0]?.[0] as object), [field]: value }];
}

function setChild(
  responses: unknown[][],
  responseIndex: number,
  field: string,
  value: unknown,
): void {
  responses[responseIndex] = [
    { ...(responses[responseIndex]?.[0] as object), [field]: value },
  ];
}

import { describe, expect, it } from "vitest";

import { prepareSkillCatalogRelease } from "../src/skill-catalog-repository.js";

describe("skill catalog release preparation", () => {
  it("makes profession mappings part of the governed checksum", () => {
    const base = seed(["PROF:ALPHA"]);
    const overlap = seed(["PROF:ALPHA", "PROF:BETA"]);
    expect(prepareSkillCatalogRelease(base).checksumSha256).not.toBe(
      prepareSkillCatalogRelease(overlap).checksumSha256,
    );
  });

  it("sorts many-to-many profession links deterministically", () => {
    const left = prepareSkillCatalogRelease(seed(["PROF:BETA", "PROF:ALPHA"]));
    const right = prepareSkillCatalogRelease(seed(["PROF:ALPHA", "PROF:BETA"]));
    expect(left.checksumSha256).toBe(right.checksumSha256);
  });

  it("does not invent or permit unreviewed canonical content", () => {
    expect(() =>
      prepareSkillCatalogRelease({
        ...seed(["PROF:ALPHA"]),
        reviewReference: null,
        reviewState: "HUMAN_REVIEW_PENDING",
      }),
    ).toThrow(/governance/u);
  });

  it.each([
    "Volajte +421 900 123 456",
    "majster@example.sk",
    "www.example.sk",
    "@majster_jano",
  ])("rejects unsafe future-public governed labels: %s", (labelSk) => {
    const input = seed(["PROF:ALPHA"]);
    expect(() =>
      prepareSkillCatalogRelease({
        ...input,
        skills: input.skills.map((skill) => ({ ...skill, labelSk })),
      }),
    ).toThrow(/presentation/u);
  });
});

function seed(professionCodes: readonly string[]) {
  return {
    contentClass: "CANONICAL" as const,
    professionTaxonomyReleaseId: "62000000-0000-4000-8000-000000000001",
    releaseId: "62000000-0000-4000-8000-000000000002",
    reviewReference: "review:test/skill-catalog",
    reviewState: "HUMAN_REVIEW_APPROVED" as const,
    skills: [
      {
        code: "SKILL:SAFE_TEST",
        labelSk: "Testovacia zručnosť",
        professionCodes,
        replacedByCode: null,
        slug: "testovacia-zrucnost",
        state: "ACTIVE" as const,
      },
    ],
    supersedesReleaseId: null,
    version: 1,
  };
}

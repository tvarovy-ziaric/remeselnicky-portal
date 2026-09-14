import type { SearchableCraftsmanCandidate } from "@portal/domain";
import { describe, expect, it } from "vitest";

import {
  composeGovernedTaxonomyRelevanceQuery,
  createTaxonomyAutocompleteService,
  projectTaxonomyRelevanceFacts,
  TAXONOMY_RELEVANCE_MAX_SKILL_TARGETS,
  TaxonomyRelevanceIntegrityError,
  type TaxonomyAutocompleteSuggestion,
} from "../src/index.js";

describe("taxonomy relevance facts", () => {
  it("supports a governed synthetic taxonomy release without weakening provenance", async () => {
    const governedProfession = await governSuggestion(
      professionSuggestion("TEST:PROFESSION_A"),
    );
    const candidate = searchableCandidate({
      professions: [profession({ code: "TEST:PROFESSION_A" })],
    });
    expect(
      projectTaxonomyRelevanceFacts(
        composeGovernedTaxonomyRelevanceQuery({
          profession: governedProfession,
        }),
        candidate,
      ).taxonomyEligibility,
    ).toBe("EXACT_PROFESSION");
  });

  it("keeps exact profession as the prerequisite and exposes evidence separately", async () => {
    const candidate = searchableCandidate({
      professions: [
        profession({
          declaredLevel: "MASTER",
          evidenceSupportedLevel: "ADVANCED",
        }),
      ],
      skills: [
        skill({ canonicalCode: "SKILL:GROUTING" }),
        skill({
          canonicalCode: "SKILL:LARGE_FORMAT",
          evidenceSupported: true,
        }),
      ],
      specializations: [specialization()],
    });
    const facts = projectTaxonomyRelevanceFacts(
      await query({
        skills: [
          skillSuggestion("SKILL:GROUTING"),
          skillSuggestion("SKILL:LARGE_FORMAT"),
        ],
        specialization: specializationSuggestion(),
      }),
      candidate,
    );

    expect(facts).toEqual({
      profileId: candidate.profileId,
      taxonomyEligibility: "EXACT_PROFESSION",
      profession: {
        code: "PROF:TILER",
        declaredLevel: "MASTER",
        declaredLevelInfluence: "WEAK_CONTEXT_ONLY",
        evidenceSupportedLevel: "ADVANCED",
        support: "EVIDENCE_SUPPORTED",
      },
      specialization: {
        code: "SPEC:TILING",
        matched: true,
        support: "SELF_DECLARED",
      },
      skill: {
        aggregation: "PRESENCE_ONLY",
        matched: true,
        representativeCode: "SKILL:LARGE_FORMAT",
        support: "EVIDENCE_SUPPORTED",
      },
    });
  });

  it("does not turn the number of matching skills into a stronger signal", async () => {
    const candidate = searchableCandidate({
      skills: [
        skill({ canonicalCode: "SKILL:GROUTING" }),
        skill({ canonicalCode: "SKILL:LARGE_FORMAT" }),
      ],
    });
    const oneSkill = projectTaxonomyRelevanceFacts(
      await query({ skills: [skillSuggestion("SKILL:GROUTING")] }),
      candidate,
    );
    const twoSkills = projectTaxonomyRelevanceFacts(
      await query({
        skills: [
          skillSuggestion("SKILL:GROUTING"),
          skillSuggestion("SKILL:LARGE_FORMAT"),
        ],
      }),
      candidate,
    );

    expect(oneSkill.skill).toEqual(twoSkills.skill);
    expect(twoSkills.skill).toEqual({
      aggregation: "PRESENCE_ONLY",
      matched: true,
      representativeCode: "SKILL:GROUTING",
      support: "SELF_DECLARED",
    });
  });

  it("does not let self-declared MASTER manufacture a taxonomy match", async () => {
    const candidate = searchableCandidate({
      professions: [
        profession({ code: "PROF:MASON", declaredLevel: "MASTER" }),
      ],
      skills: [
        skill({
          canonicalCode: "SKILL:LARGE_FORMAT",
          professionCodes: ["PROF:MASON"],
        }),
      ],
      specializations: [specialization({ professionCode: "PROF:MASON" })],
    });
    const facts = projectTaxonomyRelevanceFacts(
      await query({
        skills: [skillSuggestion("SKILL:LARGE_FORMAT")],
        specialization: specializationSuggestion(),
      }),
      candidate,
    );

    expect(facts.taxonomyEligibility).toBe("NO_EXACT_PROFESSION");
    expect(facts.profession).toMatchObject({
      declaredLevel: null,
      evidenceSupportedLevel: null,
      support: "NONE",
    });
    expect(facts.specialization).toMatchObject({
      matched: false,
      support: "NONE",
    });
    expect(facts.skill).toMatchObject({ matched: false, support: "NONE" });
  });

  it("ignores capabilities linked only to another owned profession", async () => {
    const candidate = searchableCandidate({
      professions: [profession(), profession({ code: "PROF:MASON" })],
      skills: [
        skill({
          canonicalCode: "SKILL:LARGE_FORMAT",
          evidenceSupported: true,
          professionCodes: ["PROF:MASON"],
        }),
      ],
      specializations: [
        specialization({
          evidenceSupported: true,
          professionCode: "PROF:MASON",
        }),
      ],
    });
    const facts = projectTaxonomyRelevanceFacts(
      await query({
        skills: [skillSuggestion("SKILL:LARGE_FORMAT")],
        specialization: specializationSuggestion(),
      }),
      candidate,
    );

    expect(facts.taxonomyEligibility).toBe("EXACT_PROFESSION");
    expect(facts.specialization).toMatchObject({
      matched: false,
      support: "NONE",
    });
    expect(facts.skill).toMatchObject({ matched: false, support: "NONE" });
  });

  it("uses code-point order as the deterministic self-declared tie break", async () => {
    const candidate = searchableCandidate({
      skills: [
        skill({ canonicalCode: "SKILL:ZETA" }),
        skill({ canonicalCode: "SKILL:ALPHA" }),
      ],
    });
    const facts = projectTaxonomyRelevanceFacts(
      await query({
        skills: [skillSuggestion("SKILL:ZETA"), skillSuggestion("SKILL:ALPHA")],
      }),
      candidate,
    );
    expect(facts.skill?.representativeCode).toBe("SKILL:ALPHA");
  });

  it("rejects forged, duplicate, cross-profession, and oversized targets", async () => {
    const profession = await governSuggestion(professionSuggestion());
    const skill = await governSuggestion(skillSuggestion("SKILL:ONE"));
    const crossProfessionSkill = await governSuggestion(
      skillSuggestion("SKILL:OTHER", ["PROF:MASON"]),
    );
    const tooManySkills = await Promise.all(
      Array.from(
        { length: TAXONOMY_RELEVANCE_MAX_SKILL_TARGETS + 1 },
        (_, index) => governSuggestion(skillSuggestion(`SKILL:VALUE_${index}`)),
      ),
    );

    expect(() =>
      composeGovernedTaxonomyRelevanceQuery({
        profession: professionSuggestion(),
      }),
    ).toThrow(TaxonomyRelevanceIntegrityError);
    expect(() =>
      composeGovernedTaxonomyRelevanceQuery({
        profession,
        skills: [skill, skill],
      }),
    ).toThrow(TaxonomyRelevanceIntegrityError);
    expect(() =>
      composeGovernedTaxonomyRelevanceQuery({
        profession,
        skills: [crossProfessionSkill],
      }),
    ).toThrow(TaxonomyRelevanceIntegrityError);
    expect(() =>
      composeGovernedTaxonomyRelevanceQuery({
        profession,
        skills: tooManySkills,
      }),
    ).toThrow(TaxonomyRelevanceIntegrityError);
  });

  it("fails closed for inconsistent candidate taxonomy relationships", async () => {
    const candidate = searchableCandidate({
      skills: [
        skill({
          canonicalCode: "SKILL:LARGE_FORMAT",
          professionCodes: ["PROF:MASON"],
        }),
      ],
    });
    const governedQuery = await query();
    expect(() =>
      projectTaxonomyRelevanceFacts(governedQuery, candidate),
    ).toThrow(TaxonomyRelevanceIntegrityError);
  });

  it("returns an allowlist without labels, popularity, completeness, or PII", async () => {
    const candidate = {
      ...searchableCandidate({
        professions: [profession()],
        skills: [skill({ canonicalCode: "SKILL:LARGE_FORMAT" })],
      }),
      email: "private@example.test",
      founderBadge: true,
      paidPlacement: true,
      popularityCount: 999_999,
      profileCompleteness: 100,
    };
    const facts = projectTaxonomyRelevanceFacts(
      await query({ skills: [skillSuggestion("SKILL:LARGE_FORMAT")] }),
      candidate,
    );
    expect(JSON.stringify(facts)).not.toMatch(
      /private|example|founder|paid|popular|complete|Obkladač|Veľkoformát/iu,
    );
  });
});

async function query(
  changes: Partial<{
    profession: TaxonomyAutocompleteSuggestion;
    skills: readonly TaxonomyAutocompleteSuggestion[];
    specialization: TaxonomyAutocompleteSuggestion | null;
  }> = {},
) {
  const profession = await governSuggestion(
    changes.profession ?? professionSuggestion(),
  );
  const specialization =
    changes.specialization === undefined || changes.specialization === null
      ? changes.specialization
      : await governSuggestion(changes.specialization);
  const skills = await Promise.all(
    (changes.skills ?? []).map(governSuggestion),
  );
  return composeGovernedTaxonomyRelevanceQuery({
    profession,
    skills,
    ...(specialization === undefined ? {} : { specialization }),
  });
}

async function governSuggestion(
  value: TaxonomyAutocompleteSuggestion,
): Promise<TaxonomyAutocompleteSuggestion> {
  const autocomplete = createTaxonomyAutocompleteService({
    findCandidates: () =>
      Promise.resolve([
        {
          ...value,
          governance: {
            activated: true,
            contentClass: "CANONICAL",
            entryState: "ACTIVE",
            reviewState: "HUMAN_REVIEW_APPROVED",
          },
        },
      ]),
  });
  const result = await autocomplete.autocomplete({ query: "test" });
  if (result.status !== "OK" || result.suggestions[0] === undefined) {
    throw new Error("Test autocomplete did not produce a governed suggestion.");
  }
  return result.suggestions[0];
}

function professionSuggestion(
  code = "PROF:TILER",
): TaxonomyAutocompleteSuggestion {
  return {
    code,
    kind: "PROFESSION",
    label: "Obkladač",
    matchedBy: "EXACT_CANONICAL",
    professionCodes: [code],
  };
}

function specializationSuggestion(): TaxonomyAutocompleteSuggestion {
  return {
    code: "SPEC:TILING",
    kind: "SPECIALIZATION",
    label: "Obkladanie",
    matchedBy: "EXACT_CANONICAL",
    professionCodes: ["PROF:TILER"],
  };
}

function skillSuggestion(
  code: string,
  professionCodes: readonly string[] = ["PROF:TILER"],
): TaxonomyAutocompleteSuggestion {
  return {
    code,
    kind: "SKILL",
    label: "Veľkoformátové obklady",
    matchedBy: "EXACT_CANONICAL",
    professionCodes,
  };
}

function searchableCandidate(
  changes: Partial<SearchableCraftsmanCandidate> = {},
): SearchableCraftsmanCandidate {
  return {
    profileId:
      "91000000-0000-4000-8000-000000000001" as SearchableCraftsmanCandidate["profileId"],
    credentials: [],
    experience: null,
    identity: {
      companyRegistrationVerified: false,
      identityVerified: true,
      primaryName: "Majster Jano",
      profileType: "INDIVIDUAL",
      secondaryName: "Ján Remeselný",
    },
    indicativePricing: [],
    location: {
      baseMunicipalityCode: "SK0101528595",
      baseMunicipalityName: "Bratislava",
      extraMunicipalityCodes: [],
      maximumRadiusMeters: 50_000,
      normalRadiusMeters: 25_000,
    },
    professions: [profession()],
    signals: {
      availability: { hasDeclaredAvailability: false },
      portfolio: {
        hasUnverifiedContent: false,
        hasVerifiedEvidence: false,
        professionCodes: [],
        representativeMediaAssetId: null,
        skillCodes: [],
        specializationCodes: [],
      },
      trust: {
        customerScore: null,
        reviewCount: 0,
        reviewSampleSufficient: false,
        verifiedWorkCount: 0,
      },
    },
    skills: [],
    specializations: [],
    ...changes,
  };
}

function profession(
  changes: Partial<SearchableCraftsmanCandidate["professions"][number]> = {},
): SearchableCraftsmanCandidate["professions"][number] {
  return {
    code: "PROF:TILER",
    declaredLevel: "ADVANCED",
    evidenceSupportedLevel: null,
    label: "Obkladač",
    ...changes,
  };
}

function specialization(
  changes: Partial<
    SearchableCraftsmanCandidate["specializations"][number]
  > = {},
): SearchableCraftsmanCandidate["specializations"][number] {
  return {
    code: "SPEC:TILING",
    evidenceSupported: false,
    label: "Obkladanie",
    professionCode: "PROF:TILER",
    ...changes,
  };
}

function skill(
  changes: Partial<SearchableCraftsmanCandidate["skills"][number]> = {},
): SearchableCraftsmanCandidate["skills"][number] {
  return {
    canonicalCode: "SKILL:LARGE_FORMAT",
    evidenceSupported: false,
    label: "Veľkoformátové obklady",
    professionCodes: ["PROF:TILER"],
    ...changes,
  };
}

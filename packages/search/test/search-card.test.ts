import {
  createCraftsmanServiceAreaMatch,
  serializeCraftsmanTrustEvidence,
  type CraftsmanProfileId,
  type SearchableCraftsmanCandidate,
} from "@portal/domain";
import { describe, expect, it } from "vitest";

import {
  composePublicSearchCards,
  createPublicSearchCardSearch,
  parsePublicSearchCardQuery,
  type PublicSearchPreparedCohort,
  PublicSearchCardIntegrityError,
} from "../src/search-card.js";
import type { TaxonomyAutocompleteSuggestion } from "../src/model.js";
import { createTaxonomyAutocompleteService } from "../src/service.js";
import { composeGovernedTaxonomyRelevanceQuery } from "../src/taxonomy-relevance.js";
import type {
  RecommendedQualificationContextResolver,
  RecommendedRankingCandidate,
  RecommendedRankingResult,
} from "../src/recommended-ranking.js";

const firstId = "99000000-0000-4000-8000-000000000001";
const secondId = "99000000-0000-4000-8000-000000000002";

describe("public search cards", () => {
  it("projects the exact privacy-safe allowlist and ordered human reasons", () => {
    const result = composePublicSearchCards({
      candidates: [
        publicCandidate(firstId, {
          extra: {
            email: "private@example.test",
            exactAddress: "Súkromná 12",
            storageKey: "private/key",
            skills: [
              {
                canonicalCode: "SKILL:LARGE_FORMAT",
                evidenceSupported: true,
                label: "Veľkoformátová dlažba",
                professionCodes: ["PROF:TILER"],
              },
            ],
          },
          portfolioImage: "99000000-0000-4000-8000-000000000099",
          prices: [
            {
              amountCents: 12_000,
              currency: "EUR",
              mode: "FROM",
              professionCode: "PROF:TILER",
              serviceName: "Pokládka dlažby",
            },
          ],
        }),
      ],
      professionCode: "PROF:TILER",
      ranked: [
        ranking(firstId, {
          availability: "SOFT_POSITIVE",
          qualification: "REQUIRED_APPROVED",
          relevantSkillSupported: true,
        }),
      ],
      skillCodes: ["SKILL:LARGE_FORMAT"],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      availability: "INDICATIVELY_AVAILABLE",
      identity: {
        primaryName: "Majster Ján",
        profileType: "INDIVIDUAL",
        secondaryName: "Ján Remeselný",
      },
      indicativePrice: null,
      location: { approximateDistanceKm: 18, municipalityName: "Bratislava" },
      rating: { reviewCount: 0, score: null },
      verifiedWorkCount: 0,
    });
    expect(result[0]?.whyMatched.map(({ kind }) => kind)).toEqual([
      "PROFESSION",
      "SKILL",
      "GEO",
      "REQUIRED_QUALIFICATION",
      "AVAILABILITY",
    ]);
    expect(result[0]?.badges).toEqual([
      {
        kind: "EVIDENCE_SUPPORTED_SKILL",
        label: "Zručnosť podporená dôkazmi",
      },
      {
        kind: "VERIFIED_CREDENTIAL",
        label: "Profesijné oprávnenie overené",
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /private@example|Súkromná|storage|rankingDistance|credentialType|weight|coefficient|amountCents/iu,
    );
  });

  it("drops a malformed row wholly and never returns partial unsafe labels", () => {
    const result = composePublicSearchCards({
      candidates: [
        publicCandidate(firstId, { primaryName: "Kontakt +421 900 123 456" }),
        publicCandidate(secondId),
      ],
      professionCode: "PROF:TILER",
      ranked: [ranking(firstId), ranking(secondId)],
    });
    expect(result.map(({ profileId }) => profileId)).toEqual([secondId]);
    expect(JSON.stringify(result)).not.toContain("+421");
  });

  it("rejects duplicate or mismatched internal profile/fact alignment", () => {
    expect(() =>
      composePublicSearchCards({
        candidates: [publicCandidate(firstId)],
        professionCode: "PROF:TILER",
        ranked: [ranking(secondId)],
      }),
    ).toThrow(PublicSearchCardIntegrityError);
    expect(() =>
      composePublicSearchCards({
        candidates: [publicCandidate(firstId), publicCandidate(firstId)],
        professionCode: "PROF:TILER",
        ranked: [ranking(firstId)],
      }),
    ).toThrow(/identity/u);
  });

  it("requires the exact profession and valid REQUIRED-qualified ranking row", () => {
    const base = publicCandidate(firstId);
    const missingProfession = {
      ...base,
      professions: base.professions.map((profession) => ({
        ...profession,
        code: "PROF:PAINTER",
      })),
    };
    expect(
      composePublicSearchCards({
        candidates: [missingProfession],
        professionCode: "PROF:TILER",
        ranked: [ranking(firstId)],
      }),
    ).toEqual([]);
    expect(
      composePublicSearchCards({
        candidates: [publicCandidate(firstId)],
        professionCode: "PROF:TILER",
        ranked: [
          {
            ...ranking(firstId),
            qualification: "REQUIRED_MISSING",
          } as unknown as RecommendedRankingResult,
        ],
      }),
    ).toEqual([]);
    expect(
      composePublicSearchCards({
        candidates: [publicCandidate(firstId)],
        professionCode: "PROF:TILER",
        ranked: [
          {
            ...ranking(firstId),
            evidence: null,
          } as unknown as RecommendedRankingResult,
        ],
      }),
    ).toEqual([]);
  });

  it("does not invent rating, work, availability or price facts for cold start", () => {
    const [card] = composePublicSearchCards({
      candidates: [publicCandidate(firstId)],
      professionCode: "PROF:TILER",
      ranked: [
        ranking(firstId, {
          distanceKm: null,
          geoBand: "DISTANCE_UNAVAILABLE",
        }),
      ],
    });
    expect(card).toMatchObject({
      availability: "NO_POSITIVE_SIGNAL",
      badges: [],
      indicativePrice: null,
      rating: { reviewCount: 0, score: null },
      representativePortfolioImage: null,
      verifiedWorkCount: 0,
      whyMatched: [{ kind: "PROFESSION" }],
    });
  });

  it("does not badge verified portfolio evidence from an unrelated profession", () => {
    const candidate = publicCandidate(firstId, {
      extra: {
        signals: {
          ...publicCandidate(firstId).signals,
          portfolio: {
            ...publicCandidate(firstId).signals.portfolio,
            hasVerifiedEvidence: true,
            professionCodes: ["PROF:PAINTER"],
          },
        },
      },
    });
    const [card] = composePublicSearchCards({
      candidates: [candidate],
      professionCode: "PROF:TILER",
      ranked: [ranking(firstId)],
    });
    expect(card?.badges).not.toContainEqual(
      expect.objectContaining({ kind: "VERIFIED_PORTFOLIO" }),
    );
  });

  it("uses the frozen Recommended pipeline and alternate sorter over server facts", async () => {
    const source = {
      withAuthoritativeCohort: async <Result>(
        _query: unknown,
        _maximum: number,
        use: (value: PublicSearchPreparedCohort | null) => Promise<Result>,
      ) =>
        use({
          batch: {
            distanceFacts: [
              distance(firstId, 20_000),
              distance(secondId, 5_000),
            ],
            publicCandidates: [
              publicCandidate(firstId),
              publicCandidate(secondId),
            ],
            rankingCandidates: [
              rankingCandidate(firstId, 20_000),
              rankingCandidate(secondId, 5_000),
            ],
            ratingFacts: [rating(firstId), rating(secondId)],
          },
          qualificationResolver: nonRegulatedResolver(),
          taxonomy: await governedQuery(),
        }),
    };
    const result = await createPublicSearchCardSearch(source).search({
      municipalityCode: "SK0101528595",
      professionCode: "PROF:TILER",
      sort: "NEAREST",
    });
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.page.items.map(({ profileId }) => profileId)).toEqual([
        secondId,
        firstId,
      ]);
    }
  });

  it("rejects unknown query fields instead of accepting client fact DTOs", () => {
    expect(
      parsePublicSearchCardQuery({
        candidates: [{ profileId: firstId }],
        professionCode: "PROF:TILER",
      }),
    ).toBeNull();
    expect(
      parsePublicSearchCardQuery({
        professionCode: "PROF:TILER",
        sort: ["NEAREST", "BEST_RATED"],
      }),
    ).toBeNull();
    expect(
      parsePublicSearchCardQuery({ professionCode: "PROF:TILER" }),
    ).toEqual({
      afterProfileId: null,
      filterIndicativelyAvailable: false,
      identityQuery: null,
      includeOutsideDeclaredArea: false,
      limit: 20,
      municipalityCode: null,
      professionCode: "PROF:TILER",
      skillCodes: [],
      sort: "RECOMMENDED",
      specializationCode: null,
      timing: null,
    });
  });

  it("ranks the complete bounded cohort before applying the outward cursor", async () => {
    const source = {
      withAuthoritativeCohort: async <Result>(
        _query: unknown,
        _maximum: number,
        use: (value: PublicSearchPreparedCohort | null) => Promise<Result>,
      ) =>
        use({
          batch: {
            // Simulates weak page 1 followed by the strongest row on base-repo page 2.
            distanceFacts: [
              distance(firstId, 20_000),
              distance(secondId, 1_000),
            ],
            publicCandidates: [
              publicCandidate(firstId),
              publicCandidate(secondId),
            ],
            rankingCandidates: [
              rankingCandidate(firstId, 20_000),
              rankingCandidate(secondId, 1_000),
            ],
            ratingFacts: [rating(firstId), rating(secondId)],
          },
          qualificationResolver: nonRegulatedResolver(),
          taxonomy: await governedQuery(),
        }),
    };
    const result = await createPublicSearchCardSearch(source).search({
      limit: 1,
      professionCode: "PROF:TILER",
    });
    expect(result).toMatchObject({
      page: { items: [{ profileId: secondId }], nextCursor: secondId },
      status: "OK",
    });
  });
});

async function governedQuery() {
  const profession = await governSuggestion({
    code: "PROF:TILER",
    kind: "PROFESSION",
    label: "Obkladač",
    matchedBy: "EXACT_CANONICAL",
    professionCodes: ["PROF:TILER"],
  });
  return composeGovernedTaxonomyRelevanceQuery({ profession });
}

async function governSuggestion(
  value: TaxonomyAutocompleteSuggestion,
): Promise<TaxonomyAutocompleteSuggestion> {
  const result = await createTaxonomyAutocompleteService({
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
  }).autocomplete({ query: "test" });
  if (result.status !== "OK" || result.suggestions[0] === undefined) {
    throw new Error("Expected a governed test target.");
  }
  return result.suggestions[0];
}

function publicCandidate(
  profileId: string,
  options: {
    readonly extra?: Record<string, unknown>;
    readonly portfolioImage?: string;
    readonly prices?: SearchableCraftsmanCandidate["indicativePricing"];
    readonly primaryName?: string;
  } = {},
): SearchableCraftsmanCandidate {
  const candidate: SearchableCraftsmanCandidate = {
    profileId: profileId as CraftsmanProfileId,
    identity: {
      companyRegistrationVerified: false,
      identityVerified: true,
      primaryName: options.primaryName ?? "Majster Ján",
      profileType: "INDIVIDUAL",
      secondaryName: "Ján Remeselný",
    },
    location: {
      baseMunicipalityCode: "SK0101528595",
      baseMunicipalityName: "Bratislava",
      extraMunicipalityCodes: [],
      maximumRadiusMeters: null,
      normalRadiusMeters: 25_000,
    },
    professions: [
      {
        code: "PROF:TILER",
        declaredLevel: "ADVANCED",
        evidenceSupportedLevel: null,
        label: "Obkladač",
      },
    ],
    specializations: [],
    skills: [],
    credentials: [],
    experience: null,
    indicativePricing: options.prices ?? [],
    signals: {
      availability: { hasDeclaredAvailability: false },
      portfolio: {
        hasUnverifiedContent: options.portfolioImage !== undefined,
        hasVerifiedEvidence: false,
        professionCodes: [],
        representativeMediaAssetId: options.portfolioImage ?? null,
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
  };
  return Object.assign(candidate, options.extra);
}

function ranking(
  profileId: string,
  options: {
    readonly availability?: "SOFT_POSITIVE" | "NEUTRAL";
    readonly distanceKm?: number | null;
    readonly geoBand?: RecommendedRankingResult["geo"]["band"];
    readonly qualification?: RecommendedRankingResult["qualification"];
    readonly relevantSkillSupported?: boolean;
  } = {},
): RecommendedRankingResult {
  const relevantSkillSupported = options.relevantSkillSupported ?? false;
  const qualification = options.qualification ?? "NOT_REGULATED";
  const supported =
    relevantSkillSupported ||
    qualification === "REQUIRED_APPROVED" ||
    qualification === "OPTIONAL_APPROVED";
  return {
    availability: options.availability ?? "NEUTRAL",
    evidence: {
      approvedCredentialPresent:
        qualification === "REQUIRED_APPROVED" ||
        qualification === "OPTIONAL_APPROVED",
      category: supported ? "SUPPORTED" : "COLD_START_NEUTRAL",
      professionLevelSupported: false,
      relevantSkillSupported,
      relevantSpecializationSupported: false,
      verifiedWorkPresent: false,
    },
    geo: {
      approximateDistanceKm:
        options.distanceKm === undefined ? 18 : options.distanceKm,
      band: options.geoBand ?? "STRONG_SERVICE_AREA",
    },
    profileId,
    qualification,
    secondary: { declaredLevel: "ADVANCED", influence: "WEAK_CONTEXT_ONLY" },
    taxonomy: {
      profession: "EXACT_PROFESSION",
      skill: relevantSkillSupported ? "MATCHED" : "NOT_REQUESTED",
      specialization: "NOT_REQUESTED",
    },
  };
}

function rankingCandidate(
  profileId: string,
  distanceMeters: number,
): RecommendedRankingCandidate {
  const volume = {
    approvedCredentialTypeCount: 0,
    customerReviewCount: 0,
    independentEvidenceSourceCount: 0,
    supervisorEvaluationCount: 0,
    verifiedJobCount: 0,
    verifiedPortfolioProjectCount: 0,
  };
  const quality = {
    customerQualityAvailable: false,
    customerScore: null,
    supervisorQualityAvailable: false,
  };
  const confidence = {
    customerScore: "INSUFFICIENT_SAMPLE",
    sourceDiversity: "INSUFFICIENT_SAMPLE",
    supervisorEvidence: "INSUFFICIENT_SAMPLE",
  };
  const trust = serializeCraftsmanTrustEvidence({
    confidence,
    profileId,
    professions: [
      {
        confidence,
        evidenceSupportedLevel: null,
        hasEvidenceSupportedSkill: false,
        hasEvidenceSupportedSpecialization: false,
        professionCode: "PROF:TILER",
        quality,
        volume,
      },
    ],
    quality,
    volume,
  });
  if (trust === null) throw new Error("Expected test trust.");
  return {
    availability: {
      matchKind: "NO_OVERLAPPING_DECLARATION",
      profileId,
      relevance: "NEUTRAL",
    },
    profileId,
    serviceArea: createCraftsmanServiceAreaMatch({
      approximateDistanceKm: Math.round(distanceMeters / 1000),
      craftsmanProfileId: profileId,
      matchKind: "WITHIN_NORMAL_RADIUS",
      rankingDistanceMeters: distanceMeters,
    }),
    taxonomy: {
      profileId,
      profession: {
        code: "PROF:TILER",
        declaredLevel: "ADVANCED",
        declaredLevelInfluence: "WEAK_CONTEXT_ONLY",
        evidenceSupportedLevel: null,
        support: "SELF_DECLARED",
      },
      skill: null,
      specialization: null,
      taxonomyEligibility: "EXACT_PROFESSION",
    },
    trust,
  };
}

function nonRegulatedResolver(): RecommendedQualificationContextResolver {
  return {
    evaluateForGovernedQuery: () => Promise.resolve(null),
    resolveForGovernedQuery: () =>
      Promise.resolve({
        professionCode: "PROF:TILER",
        regulation: "NOT_REGULATED",
      }),
  };
}

function distance(profileId: string, metres: number) {
  return {
    approximateDistanceKm: Math.round(metres / 1000),
    craftsmanProfileId: profileId as CraftsmanProfileId,
    rankingDistanceMeters: metres,
  };
}

function rating(profileId: string) {
  return {
    customerScore: null,
    profileId,
    reviewCount: 0,
    reviewSampleSufficient: false,
  };
}

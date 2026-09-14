import {
  createCraftsmanServiceAreaMatch,
  serializeCraftsmanTrustEvidence,
  type CraftsmanServiceAreaMatchKind,
  type CraftsmanTrustEvidenceSummary,
  type ProfessionProficiencyLevel,
} from "@portal/domain";
import { describe, expect, it, vi } from "vitest";

import type { CredentialQualificationResult } from "../src/credential-qualification.js";
import {
  createRecommendedRankingPipeline,
  RECOMMENDED_RANKING_MAX_CANDIDATES,
  RecommendedRankingIntegrityError,
  type RecommendedQualificationContextCandidate,
  type RecommendedQualificationContextResolver,
  type RecommendedRankingCandidate,
} from "../src/recommended-ranking.js";
import type {
  TaxonomyEvidenceSupport,
  TaxonomyRelevanceFacts,
} from "../src/taxonomy-relevance.js";

const ids = Array.from(
  { length: RECOMMENDED_RANKING_MAX_CANDIDATES + 1 },
  (_, index) => `94000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
);

describe("recommended organic ranking", () => {
  it("rejects a malformed server qualification resolver without a native error", () => {
    expect(() =>
      createRecommendedRankingPipeline(
        null as unknown as RecommendedQualificationContextResolver,
      ),
    ).toThrow(RecommendedRankingIntegrityError);
  });

  it("requires the exact profession and orders specialization then skill presence", async () => {
    const result = await nonRegulatedPipeline().rank([
      candidate(ids[3]!, { distanceMeters: 1_000 }),
      candidate(ids[2]!, { distanceMeters: 50_000, skill: "SELF_DECLARED" }),
      candidate(ids[1]!, {
        distanceMeters: 100_000,
        specialization: "SELF_DECLARED",
      }),
      candidate(ids[0]!, {
        distanceMeters: 1,
        taxonomyEligibility: "NO_EXACT_PROFESSION",
      }),
    ]);

    expect(result.map(({ profileId }) => profileId)).toEqual([
      ids[1],
      ids[2],
      ids[3],
    ]);
  });

  it("orders strong geo matches by distance before farther and broadened matches", async () => {
    const result = await nonRegulatedPipeline().rank([
      candidate(ids[3]!, {
        distanceMeters: 1_000,
        matchKind: "OUTSIDE_DECLARED_AREA",
      }),
      candidate(ids[2]!, {
        distanceMeters: 500,
        matchKind: "WITHIN_MAXIMUM_RADIUS",
      }),
      candidate(ids[1]!, {
        distanceMeters: 20_000,
        matchKind: "WITHIN_NORMAL_RADIUS",
      }),
      candidate(ids[0]!, {
        distanceMeters: 10_000,
        matchKind: "ADDITIONAL_SERVICE_AREA",
      }),
    ]);

    expect(result.map(({ profileId }) => profileId)).toEqual([
      ids[0],
      ids[1],
      ids[2],
      ids[3],
    ]);
    expect(result[0]?.geo).toEqual({
      approximateDistanceKm: 10,
      band: "STRONG_SERVICE_AREA",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /rankingDistance|metres|meters/iu,
    );
  });

  it("uses REQUIRED qualification only as a hard eligibility gate", async () => {
    const result = await regulatedPipeline("REQUIRED", {
      [ids[0]!]: required(true),
      [ids[1]!]: required(false),
      [ids[2]!]: unavailableQualification(),
    }).rank([candidate(ids[0]!), candidate(ids[1]!), candidate(ids[2]!)]);

    expect(result.map(({ profileId }) => profileId)).toEqual([ids[0]]);
    expect(result[0]?.qualification).toBe("REQUIRED_APPROVED");
    expect(result[0]?.evidence.approvedCredentialPresent).toBe(true);
  });

  it("places optional approval in evidence after availability", async () => {
    const result = await regulatedPipeline("OPTIONAL", {
      [ids[0]!]: optional(false),
      [ids[1]!]: optional(true),
      [ids[2]!]: optional(false),
    }).rank([
      candidate(ids[1]!),
      candidate(ids[2]!),
      candidate(ids[0]!, { available: true }),
    ]);

    expect(result.map(({ profileId }) => profileId)).toEqual([
      ids[0],
      ids[1],
      ids[2],
    ]);
    expect(result[1]?.evidence.approvedCredentialPresent).toBe(true);
    expect(result[2]?.evidence.category).toBe("COLD_START_NEUTRAL");
  });

  it("keeps cold start neutral and lets earlier geo or availability relevance win", async () => {
    const result = await nonRegulatedPipeline().rank([
      candidate(ids[2]!, {
        distanceMeters: 50_000,
        evidenceCredentialTypes: 1,
      }),
      candidate(ids[0]!, { distanceMeters: 1_000 }),
      candidate(ids[1]!, { available: true, distanceMeters: 50_000 }),
    ]);

    expect(result.map(({ profileId }) => profileId)).toEqual([
      ids[0],
      ids[1],
      ids[2],
    ]);
    expect(result[0]?.evidence.category).toBe("COLD_START_NEUTRAL");
  });

  it("uses evidence presence but never rewards the number of facts", async () => {
    const result = await nonRegulatedPipeline().rank([
      candidate(ids[1]!, { evidenceCredentialTypes: 1 }),
      candidate(ids[0]!, {
        evidenceCredentialTypes: 99,
        verifiedPortfolioProjects: 99,
      }),
      candidate(ids[2]!),
    ]);

    expect(result.map(({ profileId }) => profileId)).toEqual([
      ids[0],
      ids[1],
      ids[2],
    ]);
    expect(result[0]?.evidence.category).toBe("SUPPORTED");
    expect(result[1]?.evidence.category).toBe("SUPPORTED");
    expect(JSON.stringify(result)).not.toMatch(/count|99/iu);
  });

  it("keeps declared MASTER as the last weak context only", async () => {
    const result = await nonRegulatedPipeline().rank([
      candidate(ids[1]!, { declaredLevel: "MASTER" }),
      candidate(ids[0]!, { available: true, declaredLevel: "BEGINNER" }),
      candidate(ids[3]!, { declaredLevel: "BEGINNER" }),
      candidate(ids[2]!, { declaredLevel: "MASTER" }),
    ]);

    expect(result.map(({ profileId }) => profileId)).toEqual([
      ids[0],
      ids[1],
      ids[2],
      ids[3],
    ]);
    expect(result[1]?.secondary).toEqual({
      declaredLevel: "MASTER",
      influence: "WEAK_CONTEXT_ONLY",
    });
  });

  it("uses the profile UUID as the deterministic final tie-break", async () => {
    const result = await nonRegulatedPipeline().rank([
      candidate(ids[2]!),
      candidate(ids[0]!),
      candidate(ids[1]!),
    ]);
    expect(result.map(({ profileId }) => profileId)).toEqual([
      ids[0],
      ids[1],
      ids[2],
    ]);
  });

  it("treats a no-location query as neutral and rejects a mixed geo snapshot", async () => {
    const result = await nonRegulatedPipeline().rank([
      candidate(ids[1]!, { matchKind: "DISTANCE_UNAVAILABLE" }),
      candidate(ids[0]!, { matchKind: "DISTANCE_UNAVAILABLE" }),
    ]);
    expect(result.map(({ profileId }) => profileId)).toEqual([ids[0], ids[1]]);

    await expect(
      nonRegulatedPipeline().rank([
        candidate(ids[0]!, { matchKind: "DISTANCE_UNAVAILABLE" }),
        candidate(ids[1]!),
      ]),
    ).rejects.toBeInstanceOf(RecommendedRankingIntegrityError);
  });

  it("cannot accept caller-crafted NOT_APPLICABLE when governed context is unavailable", async () => {
    const resolver = fakeResolver(null);
    const crafted = {
      ...candidate(ids[0]!),
      qualification: required(true),
      qualificationContext: "NOT_APPLICABLE",
    };
    await expect(
      createRecommendedRankingPipeline(resolver).rank([crafted]),
    ).resolves.toEqual([]);
    expect(resolver.resolveMock).toHaveBeenCalledTimes(1);
  });

  it("binds REQUIRED evaluation to each profile and rejects swapped caller results", async () => {
    const resolver = fakeResolver(
      { professionCode: "PROF:TILER", regulation: "REQUIRED" },
      {
        [ids[0]!]: required(false),
        [ids[1]!]: required(true),
      },
    );
    const swappedApproved = {
      ...candidate(ids[0]!),
      qualification: required(true),
    };
    const swappedMissing = {
      ...candidate(ids[1]!),
      qualification: required(false),
    };
    const result = await createRecommendedRankingPipeline(resolver).rank([
      swappedApproved,
      swappedMissing,
    ]);

    expect(result.map(({ profileId }) => profileId)).toEqual([ids[1]]);
    expect(resolver.evaluateMock).toHaveBeenCalledWith({ profileId: ids[0] });
    expect(resolver.evaluateMock).toHaveBeenCalledWith({ profileId: ids[1] });
  });

  it("rejects availability facts swapped between candidate identities", async () => {
    const first = candidate(ids[0]!, { available: true });
    const second = candidate(ids[1]!);
    await expect(
      nonRegulatedPipeline().rank([
        { ...first, availability: second.availability },
        { ...second, availability: first.availability },
      ]),
    ).rejects.toBeInstanceOf(RecommendedRankingIntegrityError);
  });

  it.each([
    {
      ...candidate(ids[0]!, { professionEvidence: true }),
      trust: candidate(ids[0]!).trust,
    },
    {
      ...candidate(ids[0]!, { specialization: "EVIDENCE_SUPPORTED" }),
      trust: candidate(ids[0]!).trust,
    },
    {
      ...candidate(ids[0]!, { skill: "EVIDENCE_SUPPORTED" }),
      trust: candidate(ids[0]!).trust,
    },
  ])(
    "rejects contradictory taxonomy and trust provenance: %#",
    async (value) => {
      await expect(nonRegulatedPipeline().rank([value])).rejects.toBeInstanceOf(
        RecommendedRankingIntegrityError,
      );
    },
  );

  it.each([
    null,
    {},
    [null],
    [candidate(ids[0]!), candidate(ids[0]!)],
    [
      candidate(ids[0]!),
      {
        ...candidate(ids[1]!),
        taxonomy: { ...candidate(ids[1]!).taxonomy, profileId: ids[2] },
      },
    ],
    Array.from({ length: RECOMMENDED_RANKING_MAX_CANDIDATES + 1 }, (_, index) =>
      candidate(ids[index]!),
    ),
  ])(
    "fails closed for malformed or incoherent runtime input: %#",
    async (value) => {
      await expect(
        nonRegulatedPipeline().rank(
          value as readonly RecommendedRankingCandidate[],
        ),
      ).rejects.toBeInstanceOf(RecommendedRankingIntegrityError);
    },
  );

  it("ignores forbidden organic signals and returns only the privacy allowlist", async () => {
    const decorated = {
      ...candidate(ids[1]!),
      adminBoost: true,
      completionRate: 1,
      disputeCount: 0,
      founder: true,
      paid: true,
      photoCount: 999,
      profileCompleteness: 100,
      responseRate: 1,
      tagCount: 999,
      exactAddress: "private",
      phone: "+421900000000",
    };
    const result = await nonRegulatedPipeline().rank([
      decorated,
      candidate(ids[0]!),
    ]);

    expect(result.map(({ profileId }) => profileId)).toEqual([ids[0], ids[1]]);
    expect(Object.keys(result[0] ?? {}).sort()).toEqual([
      "availability",
      "evidence",
      "geo",
      "profileId",
      "qualification",
      "secondary",
      "taxonomy",
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /admin|boost|completion|dispute|founder|paid|photo|complete|response|tagCount|price|address|phone|storage|review|evaluator|score|weight|coefficient/iu,
    );
  });
});

interface CandidateOptions {
  readonly available?: boolean;
  readonly declaredLevel?: ProfessionProficiencyLevel;
  readonly distanceMeters?: number;
  readonly evidenceCredentialTypes?: number;
  readonly matchKind?: CraftsmanServiceAreaMatchKind;
  readonly professionEvidence?: boolean;
  readonly skill?: TaxonomyEvidenceSupport;
  readonly specialization?: TaxonomyEvidenceSupport;
  readonly taxonomyEligibility?: TaxonomyRelevanceFacts["taxonomyEligibility"];
  readonly verifiedPortfolioProjects?: number;
}

function candidate(
  profileId: string,
  options: CandidateOptions = {},
): RecommendedRankingCandidate {
  const exact = options.taxonomyEligibility !== "NO_EXACT_PROFESSION";
  const declaredLevel = exact ? (options.declaredLevel ?? "BEGINNER") : null;
  const professionEvidence = exact && options.professionEvidence === true;
  const taxonomy: TaxonomyRelevanceFacts = {
    profileId,
    taxonomyEligibility: exact ? "EXACT_PROFESSION" : "NO_EXACT_PROFESSION",
    profession: {
      code: "PROF:TILER",
      declaredLevel,
      declaredLevelInfluence: "WEAK_CONTEXT_ONLY",
      evidenceSupportedLevel: professionEvidence ? "ADVANCED" : null,
      support: exact
        ? professionEvidence
          ? "EVIDENCE_SUPPORTED"
          : "SELF_DECLARED"
        : "NONE",
    },
    specialization: capability("SPEC:LARGE_FORMAT", options.specialization),
    skill: skill(options.skill),
  };
  const matchKind = options.matchKind ?? "WITHIN_NORMAL_RADIUS";
  const distanceMeters =
    matchKind === "DISTANCE_UNAVAILABLE"
      ? null
      : (options.distanceMeters ?? 10_000);
  return {
    profileId,
    availability: options.available
      ? {
          profileId,
          matchKind: "AVAILABLE_OVERLAP",
          relevance: "SOFT_POSITIVE",
        }
      : {
          profileId,
          matchKind: "NO_OVERLAPPING_DECLARATION",
          relevance: "NEUTRAL",
        },
    serviceArea: createCraftsmanServiceAreaMatch({
      approximateDistanceKm:
        distanceMeters === null ? null : Math.round(distanceMeters / 1000),
      craftsmanProfileId: profileId,
      matchKind,
      rankingDistanceMeters: distanceMeters,
    }),
    taxonomy,
    trust: trust(profileId, {
      approvedCredentialTypeCount: options.evidenceCredentialTypes ?? 0,
      evidenceSupportedLevel: professionEvidence ? "ADVANCED" : null,
      hasEvidenceSupportedSkill: options.skill === "EVIDENCE_SUPPORTED",
      hasEvidenceSupportedSpecialization:
        options.specialization === "EVIDENCE_SUPPORTED",
      professionCode: exact ? "PROF:TILER" : "PROF:PAINTER",
      verifiedPortfolioProjectCount: options.verifiedPortfolioProjects ?? 0,
    }),
  };
}

function capability(
  code: string,
  support: TaxonomyEvidenceSupport | undefined,
): TaxonomyRelevanceFacts["specialization"] {
  return support === undefined
    ? null
    : { code, matched: support !== "NONE", support };
}

function skill(
  support: TaxonomyEvidenceSupport | undefined,
): TaxonomyRelevanceFacts["skill"] {
  return support === undefined
    ? null
    : {
        aggregation: "PRESENCE_ONLY",
        matched: support !== "NONE",
        representativeCode: support === "NONE" ? null : "SKILL:GROUTING",
        support,
      };
}

function trust(
  profileId: string,
  changes: {
    readonly approvedCredentialTypeCount: number;
    readonly evidenceSupportedLevel: ProfessionProficiencyLevel | null;
    readonly hasEvidenceSupportedSkill: boolean;
    readonly hasEvidenceSupportedSpecialization: boolean;
    readonly professionCode: string;
    readonly verifiedPortfolioProjectCount: number;
  },
): CraftsmanTrustEvidenceSummary {
  const volume = {
    approvedCredentialTypeCount: changes.approvedCredentialTypeCount,
    customerReviewCount: 0,
    independentEvidenceSourceCount: 0,
    supervisorEvaluationCount: 0,
    verifiedJobCount: 0,
    verifiedPortfolioProjectCount: changes.verifiedPortfolioProjectCount,
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
  const result = serializeCraftsmanTrustEvidence({
    profileId,
    confidence,
    professions: [
      {
        confidence,
        evidenceSupportedLevel: changes.evidenceSupportedLevel,
        hasEvidenceSupportedSkill: changes.hasEvidenceSupportedSkill,
        hasEvidenceSupportedSpecialization:
          changes.hasEvidenceSupportedSpecialization,
        professionCode: changes.professionCode,
        quality,
        volume,
      },
    ],
    quality,
    volume,
  });
  if (result === null) throw new Error("Invalid test trust summary.");
  return result;
}

function required(approved: boolean): CredentialQualificationResult {
  return approved
    ? {
        currentApproved: true,
        eligible: true,
        reasonCode: "REQUIRED_CREDENTIAL_APPROVED",
        requirement: "REQUIRED",
        status: "OK",
      }
    : {
        currentApproved: false,
        eligible: false,
        reasonCode: "REQUIRED_CREDENTIAL_MISSING",
        requirement: "REQUIRED",
        status: "OK",
      };
}

function optional(approved: boolean): CredentialQualificationResult {
  return approved
    ? {
        currentApproved: true,
        eligible: true,
        reasonCode: "OPTIONAL_CREDENTIAL_APPROVED",
        requirement: "OPTIONAL",
        status: "OK",
      }
    : {
        currentApproved: false,
        eligible: true,
        reasonCode: "OPTIONAL_CREDENTIAL_NOT_APPROVED",
        requirement: "OPTIONAL",
        status: "OK",
      };
}

function unavailableQualification(): CredentialQualificationResult {
  return { eligible: false, status: "UNAVAILABLE" };
}

function nonRegulatedPipeline() {
  return createRecommendedRankingPipeline(
    fakeResolver({
      professionCode: "PROF:TILER",
      regulation: "NOT_REGULATED",
    }),
  );
}

function regulatedPipeline(
  requirement: "REQUIRED" | "OPTIONAL",
  qualifications: Readonly<Record<string, CredentialQualificationResult>>,
) {
  return createRecommendedRankingPipeline(
    fakeResolver(
      {
        professionCode: "PROF:TILER",
        regulation: requirement,
      },
      qualifications,
    ),
  );
}

function fakeResolver(
  value: RecommendedQualificationContextCandidate | null,
  qualifications: Readonly<Record<string, CredentialQualificationResult>> = {},
): RecommendedQualificationContextResolver & {
  readonly evaluateMock: ReturnType<typeof vi.fn>;
  readonly resolveMock: ReturnType<typeof vi.fn>;
} {
  const resolveMock = vi.fn().mockResolvedValue(value);
  const evaluateMock = vi.fn(({ profileId }: { readonly profileId: string }) =>
    Promise.resolve(qualifications[profileId] ?? null),
  );
  return {
    evaluateForGovernedQuery: async (input) => {
      const result = await evaluateMock(input);
      return result;
    },
    resolveForGovernedQuery: async () => {
      await resolveMock();
      return value;
    },
    evaluateMock,
    resolveMock,
  };
}

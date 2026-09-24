import { describe, expect, it } from "vitest";

import {
  CraftsmanTrustEvidenceValidationError,
  normalizeTrustEvidenceProfileIds,
  serializeCraftsmanTrustEvidence,
  TRUST_EVIDENCE_MAX_PROFILE_IDS,
  type CraftsmanTrustEvidenceCandidate,
} from "../src/craftsman-trust-evidence.js";

const profileId = "92000000-0000-4000-8000-000000000001";

describe("craftsman trust/evidence read model", () => {
  it("keeps factual volume, quality, confidence and profession context separate", () => {
    expect(serializeCraftsmanTrustEvidence(candidate())).toEqual({
      profileId,
      volume: {
        approvedCredentialTypeCount: 2,
        customerReviewCount: 0,
        independentEvidenceSourceCount: 0,
        supervisorEvaluationCount: 0,
        verifiedJobCount: 0,
        verifiedPortfolioProjectCount: 1,
      },
      quality: {
        customerQualityAvailable: false,
        customerScore: null,
        supervisorQualityAvailable: false,
      },
      confidence: {
        customerScore: "INSUFFICIENT_SAMPLE",
        sourceDiversity: "INSUFFICIENT_SAMPLE",
        supervisorEvidence: "INSUFFICIENT_SAMPLE",
      },
      professions: [
        {
          professionCode: "PROF:TILER",
          evidenceSupportedLevel: null,
          hasEvidenceSupportedSkill: false,
          hasEvidenceSupportedSpecialization: false,
          volume: {
            approvedCredentialTypeCount: 1,
            customerReviewCount: 0,
            independentEvidenceSourceCount: 0,
            supervisorEvaluationCount: 0,
            verifiedJobCount: 0,
            verifiedPortfolioProjectCount: 1,
          },
          quality: {
            customerQualityAvailable: false,
            customerScore: null,
            supervisorQualityAvailable: false,
          },
          confidence: {
            customerScore: "INSUFFICIENT_SAMPLE",
            sourceDiversity: "INSUFFICIENT_SAMPLE",
            supervisorEvidence: "INSUFFICIENT_SAMPLE",
          },
        },
      ],
    });
  });

  it("treats cold start as null quality with insufficient evidence, not a zero score", () => {
    const cold = candidate({
      volume: volume({
        approvedCredentialTypeCount: 0,
        verifiedPortfolioProjectCount: 0,
      }),
      professions: [profession({ volume: volume() })],
    });
    const result = serializeCraftsmanTrustEvidence(cold);
    expect(result?.quality.customerScore).toBeNull();
    expect(result?.confidence.customerScore).toBe("INSUFFICIENT_SAMPLE");
    expect(JSON.stringify(result)).not.toMatch(/score":0|negative|penalty/iu);
  });

  it("accepts provenance-backed R4 work and unlocked customer review evidence", () => {
    const result = serializeCraftsmanTrustEvidence(
      candidate({
        volume: volume({
          customerReviewCount: 2,
          independentEvidenceSourceCount: 1,
          verifiedJobCount: 3,
        }),
        quality: {
          customerQualityAvailable: true,
          customerScore: 4.25,
          supervisorQualityAvailable: false,
        },
        professions: [
          profession({
            volume: volume({ customerReviewCount: 1, verifiedJobCount: 2 }),
            quality: {
              customerQualityAvailable: true,
              customerScore: 4,
              supervisorQualityAvailable: false,
            },
          }),
        ],
      }),
    );
    expect(result?.volume).toMatchObject({
      customerReviewCount: 2,
      independentEvidenceSourceCount: 1,
      verifiedJobCount: 3,
    });
    expect(result?.quality).toEqual({
      customerQualityAvailable: true,
      customerScore: 4.25,
      supervisorQualityAvailable: false,
    });
    expect(result?.professions[0]?.quality.customerScore).toBe(4);
  });

  it.each([
    { volume: volume({ customerReviewCount: 1 }) },
    {
      quality: {
        customerQualityAvailable: true,
        customerScore: 4,
        supervisorQualityAvailable: false,
      },
    },
    {
      quality: {
        customerQualityAvailable: false,
        customerScore: 5,
        supervisorQualityAvailable: false,
      },
    },
    {
      quality: {
        customerQualityAvailable: true,
        customerScore: null,
        supervisorQualityAvailable: false,
      },
    },
    {
      quality: {
        customerQualityAvailable: true,
        customerScore: 5.1,
        supervisorQualityAvailable: false,
      },
    },
    {
      confidence: { ...confidence(), customerScore: "SUFFICIENT_SAMPLE" },
    },
    { professions: [] },
    {
      professions: [profession(), profession({ professionCode: "PROF:TILER" })],
    },
    {
      professions: [profession({ professionCode: "PLACEHOLDER" })],
    },
  ])(
    "fails closed for malformed or unsupported trust evidence: %#",
    (changes) => {
      expect(serializeCraftsmanTrustEvidence(candidate(changes))).toBeNull();
    },
  );

  it("accepts governed isolated TEST profession fixtures", () => {
    const result = serializeCraftsmanTrustEvidence(
      candidate({
        professions: [profession({ professionCode: "TEST:PLUMBER" })],
      }),
    );
    expect(result?.professions[0]?.professionCode).toBe("TEST:PLUMBER");
  });

  it.each([
    null,
    undefined,
    [],
    { ...candidate(), volume: null },
    { ...candidate(), quality: [] },
    { ...candidate(), confidence: null },
    { ...candidate(), professions: [null] },
    { ...candidate(), professions: [{ ...profession(), volume: null }] },
  ])("fails closed for malformed runtime shapes: %#", (value) => {
    expect(() => serializeCraftsmanTrustEvidence(value)).not.toThrow();
    expect(serializeCraftsmanTrustEvidence(value)).toBeNull();
  });

  it("returns only the trust/evidence allowlist", () => {
    const dirty = {
      ...candidate(),
      customerEmail: "private@example.test",
      paidPlacement: true,
      founderBadge: true,
      profileCompleteness: 100,
      rawSupervisorText: "private evaluation",
      reviewerUserId: "private-user",
    };
    const result = serializeCraftsmanTrustEvidence(dirty);
    expect(JSON.stringify(result)).not.toMatch(
      /private|email|paid|founder|complete|raw|reviewer|userId/iu,
    );
  });

  it("validates a bounded unique server-derived profile batch", () => {
    expect(normalizeTrustEvidenceProfileIds([profileId])).toEqual([profileId]);
    for (const profileIds of [
      [],
      [profileId, profileId],
      ["not-a-uuid"],
      Array.from(
        { length: TRUST_EVIDENCE_MAX_PROFILE_IDS + 1 },
        (_, index) =>
          `92000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      ),
    ]) {
      expect(() => normalizeTrustEvidenceProfileIds(profileIds)).toThrow(
        CraftsmanTrustEvidenceValidationError,
      );
    }
    for (const malformed of [null, undefined, {}, "not-an-array", [null]]) {
      expect(() => normalizeTrustEvidenceProfileIds(malformed)).toThrow(
        CraftsmanTrustEvidenceValidationError,
      );
    }
  });
});

function candidate(
  changes: Partial<CraftsmanTrustEvidenceCandidate> = {},
): CraftsmanTrustEvidenceCandidate {
  return {
    profileId,
    confidence: confidence(),
    professions: [profession()],
    quality: quality(),
    volume: volume({
      approvedCredentialTypeCount: 2,
      verifiedPortfolioProjectCount: 1,
    }),
    ...changes,
  };
}

function profession(
  changes: Partial<CraftsmanTrustEvidenceCandidate["professions"][number]> = {},
): CraftsmanTrustEvidenceCandidate["professions"][number] {
  return {
    confidence: confidence(),
    evidenceSupportedLevel: null,
    hasEvidenceSupportedSkill: false,
    hasEvidenceSupportedSpecialization: false,
    professionCode: "PROF:TILER",
    quality: quality(),
    volume: volume({
      approvedCredentialTypeCount: 1,
      verifiedPortfolioProjectCount: 1,
    }),
    ...changes,
  };
}

function volume(
  changes: Partial<CraftsmanTrustEvidenceCandidate["volume"]> = {},
): CraftsmanTrustEvidenceCandidate["volume"] {
  return {
    approvedCredentialTypeCount: 0,
    customerReviewCount: 0,
    independentEvidenceSourceCount: 0,
    supervisorEvaluationCount: 0,
    verifiedJobCount: 0,
    verifiedPortfolioProjectCount: 0,
    ...changes,
  };
}

function quality(): CraftsmanTrustEvidenceCandidate["quality"] {
  return {
    customerQualityAvailable: false,
    customerScore: null,
    supervisorQualityAvailable: false,
  };
}

function confidence(): CraftsmanTrustEvidenceCandidate["confidence"] {
  return {
    customerScore: "INSUFFICIENT_SAMPLE",
    sourceDiversity: "INSUFFICIENT_SAMPLE",
    supervisorEvidence: "INSUFFICIENT_SAMPLE",
  };
}

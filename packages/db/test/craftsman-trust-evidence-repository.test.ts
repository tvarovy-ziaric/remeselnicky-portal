import type { CraftsmanProfileId } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  createCraftsmanTrustEvidenceRepository,
  CraftsmanTrustEvidenceReadIntegrityError,
} from "../src/craftsman-trust-evidence-repository.js";

const profileId = "92000000-0000-4000-8000-000000000001" as CraftsmanProfileId;

describe("craftsman trust/evidence repository", () => {
  it("rejects malformed batches before opening a snapshot", async () => {
    const sql = scriptedSql([]);
    await expect(
      createCraftsmanTrustEvidenceRepository(sql).listCurrent({
        profileIds: ["not-a-uuid"],
      }),
    ).rejects.toThrow();
    expect(sql.beginOptions).toEqual([]);
    expect(sql.queries).toEqual([]);
  });

  it("returns separated factual volume, null quality and insufficient confidence", async () => {
    const sql = scriptedSql(completeResponses());
    const result = await createCraftsmanTrustEvidenceRepository(
      sql,
    ).listCurrent({ profileIds: [profileId] });

    expect(sql.beginOptions).toEqual([
      "isolation level repeatable read read only",
    ]);
    expect(result).toEqual([
      {
        profileId,
        volume: {
          approvedCredentialTypeCount: 1,
          customerReviewCount: 0,
          independentEvidenceSourceCount: 0,
          supervisorEvaluationCount: 0,
          verifiedJobCount: 0,
          verifiedPortfolioProjectCount: 0,
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
              verifiedPortfolioProjectCount: 0,
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
      },
    ]);
    expect(sql.queries[0]).toContain(
      "current_searchable_trust_evidence_summaries",
    );
    expect(sql.queries[1]).toContain(
      "current_searchable_profession_trust_evidence",
    );
    expect(sql.queries[1]).toContain(
      'ORDER BY craftsman_profile_id, profession_code COLLATE "C"',
    );
    expect(JSON.stringify(result)).not.toMatch(
      /private|owner|customerName|reviewer|evaluationText|comment|jobId|credentialTypeCode|projectId|email|phone|paid|founder|complete|photo|storage|sha256|rank/iu,
    );
  });

  it("uses the same empty result for hidden, suspended and unknown profiles", async () => {
    for (let scenario = 0; scenario < 3; scenario += 1) {
      const sql = scriptedSql([[]]);
      await expect(
        createCraftsmanTrustEvidenceRepository(sql).listCurrent({
          profileIds: [profileId],
        }),
      ).resolves.toEqual([]);
      expect(sql.queries).toHaveLength(1);
    }
  });

  it("returns unlocked customer quality without exposing raw review provenance", async () => {
    const responses = completeResponses();
    responses[0] = [
      {
        ...(responses[0]?.[0] as object),
        customerReviewCount: 1,
        independentEvidenceSourceCount: 1,
        verifiedJobCount: 2,
        customerScore: 5,
        customerQualityAvailable: true,
      },
    ];
    const [result] = await createCraftsmanTrustEvidenceRepository(
      scriptedSql(responses),
    ).listCurrent({ profileIds: [profileId] });
    expect(result?.volume).toMatchObject({
      customerReviewCount: 1,
      independentEvidenceSourceCount: 1,
      verifiedJobCount: 2,
    });
    expect(result?.quality).toEqual({
      customerQualityAvailable: true,
      customerScore: 5,
      supervisorQualityAvailable: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /privateReviewBody|reviewer|actor|jobId|comment/iu,
    );
  });

  it("returns supervisor volume separately while quality remains deliberately unavailable", async () => {
    const responses = completeResponses();
    responses[0] = [
      {
        ...(responses[0]?.[0] as object),
        independentEvidenceSourceCount: 1,
        supervisorEvaluationCount: 2,
      },
    ];
    responses[1] = [
      {
        ...(responses[1]?.[0] as object),
        independentEvidenceSourceCount: 1,
        supervisorEvaluationCount: 2,
      },
    ];
    const [result] = await createCraftsmanTrustEvidenceRepository(
      scriptedSql(responses),
    ).listCurrent({ profileIds: [profileId] });
    expect(result?.volume).toMatchObject({
      independentEvidenceSourceCount: 1,
      supervisorEvaluationCount: 2,
    });
    expect(result?.professions[0]?.volume).toMatchObject({
      independentEvidenceSourceCount: 1,
      supervisorEvaluationCount: 2,
    });
    expect(result?.quality.supervisorQualityAvailable).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(
      /evaluator|relationship|dimension|comment|jobId/iu,
    );
  });

  it("fails closed if review availability and score are incoherent", async () => {
    const responses = completeResponses();
    responses[0] = [
      {
        ...(responses[0]?.[0] as object),
        customerReviewCount: 1,
        customerScore: null,
        customerQualityAvailable: true,
      },
    ];
    await expect(
      createCraftsmanTrustEvidenceRepository(
        scriptedSql(responses),
      ).listCurrent({ profileIds: [profileId] }),
    ).rejects.toThrow(CraftsmanTrustEvidenceReadIntegrityError);
  });

  it("fails closed if the summary view returns a duplicate profile row", async () => {
    const responses = completeResponses();
    responses[0] = [responses[0]?.[0], responses[0]?.[0]];
    await expect(
      createCraftsmanTrustEvidenceRepository(
        scriptedSql(responses),
      ).listCurrent({ profileIds: [profileId] }),
    ).rejects.toThrow(CraftsmanTrustEvidenceReadIntegrityError);
  });
});

interface ScriptedSql extends Sql {
  readonly beginOptions: string[];
  readonly queries: string[];
}

function scriptedSql(responses: readonly unknown[][]): ScriptedSql {
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
    [trustRow({ profileId, approvedCredentialTypeCount: 1 })],
    [
      trustRow({
        profileId,
        approvedCredentialTypeCount: 1,
        evidenceSupportedLevel: null,
        hasEvidenceSupportedSkill: false,
        hasEvidenceSupportedSpecialization: false,
        professionCode: "PROF:TILER",
      }),
    ],
  ];
}

function trustRow(changes: Record<string, unknown>): Record<string, unknown> {
  return {
    approvedCredentialTypeCount: 0,
    customerQualityAvailable: false,
    customerReviewCount: 0,
    customerScore: null,
    customerScoreConfidence: "INSUFFICIENT_SAMPLE",
    independentEvidenceSourceCount: 0,
    privateReviewBody: "must-not-pass",
    sourceDiversityConfidence: "INSUFFICIENT_SAMPLE",
    supervisorEvaluationCount: 0,
    supervisorEvidenceConfidence: "INSUFFICIENT_SAMPLE",
    supervisorQualityAvailable: false,
    verifiedJobCount: 0,
    verifiedPortfolioProjectCount: 0,
    ...changes,
  };
}

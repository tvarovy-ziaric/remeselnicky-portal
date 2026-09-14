import {
  normalizeTrustEvidenceProfileIds,
  serializeCraftsmanTrustEvidence,
  type CraftsmanTrustEvidenceCandidate,
  type CraftsmanTrustEvidencePersistence,
  type ProfessionTrustEvidenceCandidate,
  type TrustEvidenceConfidenceCandidate,
  type TrustEvidenceQualityCandidate,
  type TrustEvidenceVolumeCandidate,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface SummaryRow extends TrustRow {
  readonly profileId: string;
}

interface ProfessionRow extends TrustRow {
  readonly evidenceSupportedLevel: string | null;
  readonly hasEvidenceSupportedSkill: boolean;
  readonly hasEvidenceSupportedSpecialization: boolean;
  readonly professionCode: string;
  readonly profileId: string;
}

interface TrustRow {
  readonly approvedCredentialTypeCount: unknown;
  readonly customerQualityAvailable: unknown;
  readonly customerReviewCount: unknown;
  readonly customerScore: unknown;
  readonly customerScoreConfidence: unknown;
  readonly independentEvidenceSourceCount: unknown;
  readonly sourceDiversityConfidence: unknown;
  readonly supervisorEvaluationCount: unknown;
  readonly supervisorEvidenceConfidence: unknown;
  readonly supervisorQualityAvailable: unknown;
  readonly verifiedJobCount: unknown;
  readonly verifiedPortfolioProjectCount: unknown;
}

export class CraftsmanTrustEvidenceReadIntegrityError extends Error {
  override readonly name = "CraftsmanTrustEvidenceReadIntegrityError";
}

export function createCraftsmanTrustEvidenceRepository(
  sql: Sql,
): CraftsmanTrustEvidencePersistence {
  return Object.freeze({
    async listCurrent(input: { readonly profileIds: readonly string[] }) {
      const profileIds = normalizeTrustEvidenceProfileIds(input.profileIds);
      return sql.begin(
        "isolation level repeatable read read only",
        async (transaction) =>
          readCraftsmanTrustEvidenceSnapshot(transaction, profileIds),
      );
    },
  });
}

export async function readCraftsmanTrustEvidenceSnapshot(
  sql: TransactionSql,
  profileIds: readonly string[],
) {
  const summaries = await sql<SummaryRow[]>`
    SELECT
      craftsman_profile_id AS "profileId",
      customer_review_count AS "customerReviewCount",
      supervisor_evaluation_count AS "supervisorEvaluationCount",
      verified_job_count AS "verifiedJobCount",
      independent_evidence_source_count AS "independentEvidenceSourceCount",
      approved_credential_type_count AS "approvedCredentialTypeCount",
      verified_portfolio_project_count AS "verifiedPortfolioProjectCount",
      customer_score AS "customerScore",
      customer_quality_available AS "customerQualityAvailable",
      supervisor_quality_available AS "supervisorQualityAvailable",
      customer_score_confidence AS "customerScoreConfidence",
      supervisor_evidence_confidence AS "supervisorEvidenceConfidence",
      source_diversity_confidence AS "sourceDiversityConfidence"
    FROM current_searchable_trust_evidence_summaries
    WHERE craftsman_profile_id = ANY(${profileIds}::uuid[])
    ORDER BY craftsman_profile_id
  `;
  if (summaries.length === 0) return Object.freeze([]);
  if (
    new Set(summaries.map(({ profileId }) => profileId)).size !==
    summaries.length
  ) {
    throw new CraftsmanTrustEvidenceReadIntegrityError(
      "Current trust/evidence summary view returned duplicate profiles.",
    );
  }
  const visibleProfileIds = summaries.map(({ profileId }) => profileId);
  const professions = await sql<ProfessionRow[]>`
    SELECT
      craftsman_profile_id AS "profileId",
      profession_code AS "professionCode",
      evidence_supported_level AS "evidenceSupportedLevel",
      has_evidence_supported_specialization AS
        "hasEvidenceSupportedSpecialization",
      has_evidence_supported_skill AS "hasEvidenceSupportedSkill",
      customer_review_count AS "customerReviewCount",
      supervisor_evaluation_count AS "supervisorEvaluationCount",
      verified_job_count AS "verifiedJobCount",
      independent_evidence_source_count AS "independentEvidenceSourceCount",
      approved_credential_type_count AS "approvedCredentialTypeCount",
      verified_portfolio_project_count AS "verifiedPortfolioProjectCount",
      customer_score AS "customerScore",
      customer_quality_available AS "customerQualityAvailable",
      supervisor_quality_available AS "supervisorQualityAvailable",
      customer_score_confidence AS "customerScoreConfidence",
      supervisor_evidence_confidence AS "supervisorEvidenceConfidence",
      source_diversity_confidence AS "sourceDiversityConfidence"
    FROM current_searchable_profession_trust_evidence
    WHERE craftsman_profile_id = ANY(${visibleProfileIds}::uuid[])
    ORDER BY craftsman_profile_id, profession_code COLLATE "C"
  `;

  return Object.freeze(
    summaries.map((summary) => {
      const candidate: CraftsmanTrustEvidenceCandidate = {
        profileId: summary.profileId,
        volume: volume(summary),
        quality: quality(summary),
        confidence: confidence(summary),
        professions: professions
          .filter(({ profileId }) => profileId === summary.profileId)
          .map(profession),
      };
      const serialized = serializeCraftsmanTrustEvidence(candidate);
      if (serialized === null) {
        throw new CraftsmanTrustEvidenceReadIntegrityError(
          "Current trust/evidence view violated its public read invariants.",
        );
      }
      return serialized;
    }),
  );
}

function profession(row: ProfessionRow): ProfessionTrustEvidenceCandidate {
  return {
    professionCode: row.professionCode,
    evidenceSupportedLevel: row.evidenceSupportedLevel,
    hasEvidenceSupportedSkill: row.hasEvidenceSupportedSkill,
    hasEvidenceSupportedSpecialization: row.hasEvidenceSupportedSpecialization,
    volume: volume(row),
    quality: quality(row),
    confidence: confidence(row),
  };
}

function volume(row: TrustRow): TrustEvidenceVolumeCandidate {
  return {
    approvedCredentialTypeCount: row.approvedCredentialTypeCount,
    customerReviewCount: row.customerReviewCount,
    independentEvidenceSourceCount: row.independentEvidenceSourceCount,
    supervisorEvaluationCount: row.supervisorEvaluationCount,
    verifiedJobCount: row.verifiedJobCount,
    verifiedPortfolioProjectCount: row.verifiedPortfolioProjectCount,
  };
}

function quality(row: TrustRow): TrustEvidenceQualityCandidate {
  return {
    customerQualityAvailable: row.customerQualityAvailable,
    customerScore: row.customerScore,
    supervisorQualityAvailable: row.supervisorQualityAvailable,
  };
}

function confidence(row: TrustRow): TrustEvidenceConfidenceCandidate {
  return {
    customerScore: row.customerScoreConfidence,
    sourceDiversity: row.sourceDiversityConfidence,
    supervisorEvidence: row.supervisorEvidenceConfidence,
  };
}

import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { ProfessionProficiencyLevel } from "./craftsman-profession.js";

export const TRUST_EVIDENCE_MAX_PROFILE_IDS = 50;

export type InsufficientEvidenceConfidence = "INSUFFICIENT_SAMPLE";

export interface TrustEvidenceVolume {
  readonly approvedCredentialTypeCount: number;
  readonly customerReviewCount: number;
  readonly independentEvidenceSourceCount: number;
  readonly supervisorEvaluationCount: number;
  readonly verifiedJobCount: number;
  readonly verifiedPortfolioProjectCount: number;
}

export interface TrustEvidenceQuality {
  readonly customerQualityAvailable: false;
  readonly customerScore: null;
  readonly supervisorQualityAvailable: false;
}

export interface TrustEvidenceConfidence {
  readonly customerScore: InsufficientEvidenceConfidence;
  readonly sourceDiversity: InsufficientEvidenceConfidence;
  readonly supervisorEvidence: InsufficientEvidenceConfidence;
}

export interface ProfessionTrustEvidence {
  readonly professionCode: string;
  readonly evidenceSupportedLevel: ProfessionProficiencyLevel | null;
  readonly hasEvidenceSupportedSkill: boolean;
  readonly hasEvidenceSupportedSpecialization: boolean;
  readonly volume: TrustEvidenceVolume;
  readonly quality: TrustEvidenceQuality;
  readonly confidence: TrustEvidenceConfidence;
}

export interface CraftsmanTrustEvidenceSummary {
  readonly profileId: CraftsmanProfileId;
  readonly volume: TrustEvidenceVolume;
  readonly quality: TrustEvidenceQuality;
  readonly confidence: TrustEvidenceConfidence;
  readonly professions: readonly ProfessionTrustEvidence[];
}

export interface CraftsmanTrustEvidenceCandidate {
  readonly profileId: unknown;
  readonly volume: TrustEvidenceVolumeCandidate;
  readonly quality: TrustEvidenceQualityCandidate;
  readonly confidence: TrustEvidenceConfidenceCandidate;
  readonly professions: readonly ProfessionTrustEvidenceCandidate[];
}

export interface TrustEvidenceVolumeCandidate {
  readonly approvedCredentialTypeCount: unknown;
  readonly customerReviewCount: unknown;
  readonly independentEvidenceSourceCount: unknown;
  readonly supervisorEvaluationCount: unknown;
  readonly verifiedJobCount: unknown;
  readonly verifiedPortfolioProjectCount: unknown;
}

export interface TrustEvidenceQualityCandidate {
  readonly customerQualityAvailable: unknown;
  readonly customerScore: unknown;
  readonly supervisorQualityAvailable: unknown;
}

export interface TrustEvidenceConfidenceCandidate {
  readonly customerScore: unknown;
  readonly sourceDiversity: unknown;
  readonly supervisorEvidence: unknown;
}

export interface ProfessionTrustEvidenceCandidate {
  readonly professionCode: unknown;
  readonly evidenceSupportedLevel: unknown;
  readonly hasEvidenceSupportedSkill: unknown;
  readonly hasEvidenceSupportedSpecialization: unknown;
  readonly volume: TrustEvidenceVolumeCandidate;
  readonly quality: TrustEvidenceQualityCandidate;
  readonly confidence: TrustEvidenceConfidenceCandidate;
}

export interface CraftsmanTrustEvidencePersistence {
  listCurrent(input: {
    readonly profileIds: readonly string[];
  }): Promise<readonly CraftsmanTrustEvidenceSummary[]>;
}

export class CraftsmanTrustEvidenceValidationError extends Error {
  override readonly name = "CraftsmanTrustEvidenceValidationError";
}

export function normalizeTrustEvidenceProfileIds(
  profileIds: unknown,
): readonly CraftsmanProfileId[] {
  if (
    !isStringArray(profileIds) ||
    profileIds.length < 1 ||
    profileIds.length > TRUST_EVIDENCE_MAX_PROFILE_IDS ||
    profileIds.some((profileId) => !isUuid(profileId)) ||
    new Set(profileIds).size !== profileIds.length
  ) {
    throw new CraftsmanTrustEvidenceValidationError(
      "Trust/evidence profile identifiers are invalid.",
    );
  }
  return Object.freeze([...profileIds] as CraftsmanProfileId[]);
}

export function serializeCraftsmanTrustEvidence(
  candidate: unknown,
): CraftsmanTrustEvidenceSummary | null {
  if (
    !isRecord(candidate) ||
    !isUuid(candidate.profileId) ||
    !isUnknownArray(candidate.professions)
  ) {
    return null;
  }
  const volume = serializeVolume(candidate.volume);
  const quality = serializeQuality(candidate.quality);
  const confidence = serializeConfidence(candidate.confidence);
  const professions = candidate.professions.map(serializeProfession);
  if (
    volume === null ||
    quality === null ||
    confidence === null ||
    professions.length < 1 ||
    professions.some((profession) => profession === null)
  ) {
    return null;
  }
  const values = professions as ProfessionTrustEvidence[];
  const codes = values.map(({ professionCode }) => professionCode);
  if (new Set(codes).size !== codes.length) return null;

  return Object.freeze({
    profileId: candidate.profileId,
    volume,
    quality,
    confidence,
    professions: Object.freeze(
      [...values].sort((left, right) =>
        codePointCompare(left.professionCode, right.professionCode),
      ),
    ),
  });
}

function serializeProfession(
  candidate: unknown,
): ProfessionTrustEvidence | null {
  if (!isRecord(candidate)) return null;
  const volume = serializeVolume(candidate.volume);
  const quality = serializeQuality(candidate.quality);
  const confidence = serializeConfidence(candidate.confidence);
  if (
    !isProfessionCode(candidate.professionCode) ||
    (candidate.evidenceSupportedLevel !== null &&
      !isLevel(candidate.evidenceSupportedLevel)) ||
    typeof candidate.hasEvidenceSupportedSkill !== "boolean" ||
    typeof candidate.hasEvidenceSupportedSpecialization !== "boolean" ||
    volume === null ||
    quality === null ||
    confidence === null
  ) {
    return null;
  }
  return Object.freeze({
    professionCode: candidate.professionCode,
    evidenceSupportedLevel: candidate.evidenceSupportedLevel,
    hasEvidenceSupportedSkill: candidate.hasEvidenceSupportedSkill,
    hasEvidenceSupportedSpecialization:
      candidate.hasEvidenceSupportedSpecialization,
    volume,
    quality,
    confidence,
  });
}

function serializeVolume(candidate: unknown): TrustEvidenceVolume | null {
  if (!isRecord(candidate)) return null;
  const values = [
    candidate.approvedCredentialTypeCount,
    candidate.customerReviewCount,
    candidate.independentEvidenceSourceCount,
    candidate.supervisorEvaluationCount,
    candidate.verifiedJobCount,
    candidate.verifiedPortfolioProjectCount,
  ];
  if (!values.every(isNonnegativeSafeInteger)) return null;

  // R2 has no completed-job/review authority. Non-zero values would fabricate
  // evidence before R4 installs its provenance-preserving sources.
  if (
    candidate.customerReviewCount !== 0 ||
    candidate.independentEvidenceSourceCount !== 0 ||
    candidate.supervisorEvaluationCount !== 0 ||
    candidate.verifiedJobCount !== 0
  ) {
    return null;
  }
  return Object.freeze({
    approvedCredentialTypeCount: candidate.approvedCredentialTypeCount,
    customerReviewCount: candidate.customerReviewCount,
    independentEvidenceSourceCount: candidate.independentEvidenceSourceCount,
    supervisorEvaluationCount: candidate.supervisorEvaluationCount,
    verifiedJobCount: candidate.verifiedJobCount,
    verifiedPortfolioProjectCount: candidate.verifiedPortfolioProjectCount,
  }) as TrustEvidenceVolume;
}

function serializeQuality(candidate: unknown): TrustEvidenceQuality | null {
  if (!isRecord(candidate)) return null;
  return candidate.customerScore === null &&
    candidate.customerQualityAvailable === false &&
    candidate.supervisorQualityAvailable === false
    ? Object.freeze({
        customerQualityAvailable: false as const,
        customerScore: null,
        supervisorQualityAvailable: false as const,
      })
    : null;
}

function serializeConfidence(
  candidate: unknown,
): TrustEvidenceConfidence | null {
  if (!isRecord(candidate)) return null;
  return candidate.customerScore === "INSUFFICIENT_SAMPLE" &&
    candidate.sourceDiversity === "INSUFFICIENT_SAMPLE" &&
    candidate.supervisorEvidence === "INSUFFICIENT_SAMPLE"
    ? Object.freeze({
        customerScore: "INSUFFICIENT_SAMPLE" as const,
        sourceDiversity: "INSUFFICIENT_SAMPLE" as const,
        supervisorEvidence: "INSUFFICIENT_SAMPLE" as const,
      })
    : null;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isProfessionCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isLevel(value: unknown): value is ProfessionProficiencyLevel {
  return value === "BEGINNER" || value === "ADVANCED" || value === "MASTER";
}

function isUuid(value: unknown): value is CraftsmanProfileId {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

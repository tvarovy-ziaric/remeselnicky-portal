import type {
  CraftsmanProfileId,
  CraftsmanProfileType,
} from "./craftsman-profile.js";
import type { ProfessionProficiencyLevel } from "./craftsman-profession.js";
import type { IndicativePriceMode } from "./indicative-pricing.js";

export const SEARCH_CANDIDATE_DEFAULT_LIMIT = 20;
export const SEARCH_CANDIDATE_MAX_LIMIT = 50;
export const SEARCH_IDENTITY_QUERY_MAX_LENGTH = 120;

export class CraftsmanSearchValidationError extends Error {
  override readonly name = "CraftsmanSearchValidationError";
}

export interface SearchCraftsmanCandidatesInput {
  readonly afterProfileId?: string | null;
  readonly identityQuery?: string | null;
  readonly limit?: number;
}

export interface NormalizedSearchCraftsmanCandidatesInput {
  readonly afterProfileId: CraftsmanProfileId | null;
  readonly identityQuery: string | null;
  readonly limit: number;
}

export interface SearchableCraftsmanProfession {
  readonly code: string;
  readonly label: string;
  readonly declaredLevel: ProfessionProficiencyLevel;
  readonly evidenceSupportedLevel: ProfessionProficiencyLevel | null;
}

export interface SearchableCraftsmanSpecialization {
  readonly code: string;
  readonly label: string;
  readonly professionCode: string;
  readonly evidenceSupported: boolean;
}

export interface SearchableCraftsmanSkill {
  readonly canonicalCode: string | null;
  readonly label: string;
  readonly professionCodes: readonly string[];
  readonly evidenceSupported: boolean;
}

export interface SearchableCraftsmanCredential {
  readonly credentialTypeCode: string;
  readonly professionCode: string;
  readonly expiresOn: string | null;
  readonly verification: "ADMIN_APPROVED";
}

export interface SearchableCraftsmanPrice {
  readonly serviceName: string;
  readonly mode: IndicativePriceMode;
  readonly amountCents: number;
  readonly currency: "EUR";
  readonly professionCode: string | null;
}

export interface SearchableCraftsmanCandidate {
  readonly profileId: CraftsmanProfileId;
  readonly identity: Readonly<{
    profileType: CraftsmanProfileType;
    primaryName: string;
    secondaryName: string | null;
    identityVerified: boolean;
    companyRegistrationVerified: boolean;
  }>;
  readonly location: Readonly<{
    baseMunicipalityCode: string;
    baseMunicipalityName: string;
    normalRadiusMeters: number;
    maximumRadiusMeters: number | null;
    extraMunicipalityCodes: readonly string[];
  }>;
  readonly professions: readonly SearchableCraftsmanProfession[];
  readonly specializations: readonly SearchableCraftsmanSpecialization[];
  readonly skills: readonly SearchableCraftsmanSkill[];
  readonly credentials: readonly SearchableCraftsmanCredential[];
  readonly experience: Readonly<{
    source: "SELF_DECLARED";
    workingSinceYear: number;
  }> | null;
  readonly indicativePricing: readonly SearchableCraftsmanPrice[];
  readonly signals: Readonly<{
    availability: Readonly<{
      hasDeclaredAvailability: boolean;
    }>;
    portfolio: Readonly<{
      hasVerifiedEvidence: boolean;
      hasUnverifiedContent: boolean;
      professionCodes: readonly string[];
      specializationCodes: readonly string[];
      skillCodes: readonly string[];
      representativeMediaAssetId: string | null;
    }>;
    trust: Readonly<{
      customerScore: number | null;
      reviewCount: number;
      reviewSampleSufficient: boolean;
      verifiedWorkCount: number;
    }>;
  }>;
}

export interface SearchableCraftsmanCandidatePage {
  readonly items: readonly SearchableCraftsmanCandidate[];
  readonly nextCursor: CraftsmanProfileId | null;
}

export interface CraftsmanSearchReadModelPersistence {
  search(
    input: SearchCraftsmanCandidatesInput,
  ): Promise<SearchableCraftsmanCandidatePage>;
}

export function normalizeSearchCraftsmanCandidatesInput(
  input: SearchCraftsmanCandidatesInput,
): NormalizedSearchCraftsmanCandidatesInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new CraftsmanSearchValidationError("Search input must be an object.");
  }

  const limit = input.limit ?? SEARCH_CANDIDATE_DEFAULT_LIMIT;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > SEARCH_CANDIDATE_MAX_LIMIT
  ) {
    throw new CraftsmanSearchValidationError(
      `Search limit must be an integer from 1 to ${SEARCH_CANDIDATE_MAX_LIMIT}.`,
    );
  }

  const afterProfileId = input.afterProfileId ?? null;
  if (afterProfileId !== null && !isUuid(afterProfileId)) {
    throw new CraftsmanSearchValidationError("Search cursor must be a UUID.");
  }

  const identityQuery = normalizeIdentityQuery(input.identityQuery ?? null);
  return Object.freeze({ afterProfileId, identityQuery, limit });
}

function normalizeIdentityQuery(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new CraftsmanSearchValidationError(
      "Identity query must be text or null.",
    );
  }
  if (hasUnsafeQueryControl(value)) {
    throw new CraftsmanSearchValidationError("Identity query is not safe.");
  }
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) return null;
  if (normalized.length > SEARCH_IDENTITY_QUERY_MAX_LENGTH) {
    throw new CraftsmanSearchValidationError("Identity query is not safe.");
  }
  return normalized;
}

function hasUnsafeQueryControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 8 || (code >= 10 && code <= 31) || code === 127;
  });
}

function isUuid(value: unknown): value is CraftsmanProfileId {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

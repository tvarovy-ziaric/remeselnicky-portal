import {
  isPublicDisplayTextSafe,
  normalizeSearchCraftsmanCandidatesInput,
  type CraftsmanProfileId,
  type CraftsmanSearchReadModelPersistence,
  type NormalizedSearchCraftsmanCandidatesInput,
  type SearchableCraftsmanCandidate,
  type SearchableCraftsmanCredential,
  type SearchableCraftsmanPrice,
  type SearchableCraftsmanProfession,
  type SearchableCraftsmanSkill,
  type SearchableCraftsmanSpecialization,
  type SearchCraftsmanCandidatesInput,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface ProfileRow {
  readonly profileId: string;
  readonly profileType: "INDIVIDUAL" | "COMPANY";
  readonly primaryName: string;
  readonly secondaryName: string | null;
  readonly baseMunicipalityCode: string;
  readonly baseMunicipalityName: string;
  readonly normalRadiusMeters: number;
  readonly maximumRadiusMeters: number | null;
  readonly extraMunicipalityCodes: string[];
  readonly identityVerified: boolean;
  readonly companyRegistrationVerified: boolean;
  readonly hasDeclaredAvailability: boolean;
  readonly hasVerifiedEvidence: boolean;
  readonly hasUnverifiedContent: boolean;
  readonly portfolioProfessionCodes: string[];
  readonly portfolioSpecializationCodes: string[];
  readonly portfolioSkillCodes: string[];
  readonly representativeMediaAssetId: string | null;
  readonly customerScore: number | string | null;
  readonly reviewCount: number;
  readonly reviewSampleSufficient: boolean;
  readonly verifiedWorkCount: number;
  readonly workingSinceYear: number | null;
}

interface ProfessionRow {
  readonly profileId: string;
  readonly code: string;
  readonly label: string;
  readonly declaredLevel: "BEGINNER" | "ADVANCED" | "MASTER";
  readonly evidenceSupportedLevel: "BEGINNER" | "ADVANCED" | "MASTER" | null;
}

interface SpecializationRow {
  readonly profileId: string;
  readonly code: string;
  readonly label: string;
  readonly professionCode: string;
  readonly evidenceSupported: boolean;
}

interface SkillRow {
  readonly profileId: string;
  readonly canonicalCode: string | null;
  readonly label: string;
  readonly professionCodes: string[];
  readonly evidenceSupported: boolean;
}

interface CredentialRow {
  readonly profileId: string;
  readonly credentialTypeCode: string;
  readonly professionCode: string;
  readonly expiresOn: Date | string | null;
}

interface PriceRow {
  readonly profileId: string;
  readonly serviceName: string;
  readonly mode: SearchableCraftsmanPrice["mode"];
  readonly amountCents: number | string;
  readonly currency: string;
  readonly professionCode: string | null;
}

export function createCraftsmanSearchReadModelRepository(
  sql: Sql,
): CraftsmanSearchReadModelPersistence {
  return Object.freeze({
    async search(input: SearchCraftsmanCandidatesInput) {
      const normalized = normalizeSearchCraftsmanCandidatesInput(input);
      return sql.begin(
        "isolation level repeatable read read only",
        async (transaction) => searchSnapshot(transaction, normalized),
      );
    },
  });
}

async function searchSnapshot(
  sql: TransactionSql,
  input: NormalizedSearchCraftsmanCandidatesInput,
) {
  const rows = await sql<ProfileRow[]>`
    SELECT
      profile.craftsman_profile_id AS "profileId",
      profile.profile_type AS "profileType",
      profile.primary_name AS "primaryName",
      profile.secondary_name AS "secondaryName",
      profile.base_municipality_code AS "baseMunicipalityCode",
      profile.base_municipality_name AS "baseMunicipalityName",
      profile.normal_radius_meters AS "normalRadiusMeters",
      profile.maximum_radius_meters AS "maximumRadiusMeters",
      profile.extra_municipality_codes AS "extraMunicipalityCodes",
      profile.identity_verified AS "identityVerified",
      profile.company_registration_verified AS "companyRegistrationVerified",
      availability.has_declared_availability AS "hasDeclaredAvailability",
      portfolio.has_verified_evidence AS "hasVerifiedEvidence",
      portfolio.has_unverified_content AS "hasUnverifiedContent",
      portfolio.profession_codes AS "portfolioProfessionCodes",
      portfolio.specialization_codes AS "portfolioSpecializationCodes",
      portfolio.skill_codes AS "portfolioSkillCodes",
      portfolio.representative_media_asset_id AS "representativeMediaAssetId",
      trust.customer_score AS "customerScore",
      trust.review_count AS "reviewCount",
      trust.review_sample_sufficient AS "reviewSampleSufficient",
      trust.verified_work_count AS "verifiedWorkCount",
      experience.working_since_year AS "workingSinceYear"
    FROM current_searchable_craftsman_profiles profile
    JOIN current_searchable_craftsman_availability_signals availability
      ON availability.craftsman_profile_id = profile.craftsman_profile_id
    JOIN current_searchable_craftsman_portfolio_signals portfolio
      ON portfolio.craftsman_profile_id = profile.craftsman_profile_id
    JOIN current_searchable_craftsman_trust_signals trust
      ON trust.craftsman_profile_id = profile.craftsman_profile_id
    LEFT JOIN current_searchable_craftsman_experience experience
      ON experience.craftsman_profile_id = profile.craftsman_profile_id
    WHERE (
      ${input.afterProfileId}::uuid IS NULL
      OR profile.craftsman_profile_id > ${input.afterProfileId}::uuid
    )
      AND (
        ${input.identityQuery}::text IS NULL
        OR profile.identity_search_document @@ plainto_tsquery(
          'simple'::regconfig,
          craftsman_search_normalize_text(${input.identityQuery}::text)
        )
      )
    ORDER BY profile.craftsman_profile_id
    LIMIT ${input.limit + 1}
  `;

  const hasNextPage = rows.length > input.limit;
  const pageRows = rows.slice(0, input.limit);
  if (pageRows.length === 0) {
    return Object.freeze({ items: Object.freeze([]), nextCursor: null });
  }
  return hydrateCandidateRows(sql, pageRows, hasNextPage);
}

export async function readCraftsmanCandidatesByIdsSnapshot(
  sql: TransactionSql,
  profileIds: readonly string[],
) {
  if (profileIds.length === 0) {
    return Object.freeze({ items: Object.freeze([]), nextCursor: null });
  }
  const rows = await sql<ProfileRow[]>`
    SELECT
      profile.craftsman_profile_id AS "profileId",
      profile.profile_type AS "profileType",
      profile.primary_name AS "primaryName",
      profile.secondary_name AS "secondaryName",
      profile.base_municipality_code AS "baseMunicipalityCode",
      profile.base_municipality_name AS "baseMunicipalityName",
      profile.normal_radius_meters AS "normalRadiusMeters",
      profile.maximum_radius_meters AS "maximumRadiusMeters",
      profile.extra_municipality_codes AS "extraMunicipalityCodes",
      profile.identity_verified AS "identityVerified",
      profile.company_registration_verified AS "companyRegistrationVerified",
      availability.has_declared_availability AS "hasDeclaredAvailability",
      portfolio.has_verified_evidence AS "hasVerifiedEvidence",
      portfolio.has_unverified_content AS "hasUnverifiedContent",
      portfolio.profession_codes AS "portfolioProfessionCodes",
      portfolio.specialization_codes AS "portfolioSpecializationCodes",
      portfolio.skill_codes AS "portfolioSkillCodes",
      portfolio.representative_media_asset_id AS "representativeMediaAssetId",
      trust.customer_score AS "customerScore",
      trust.review_count AS "reviewCount",
      trust.review_sample_sufficient AS "reviewSampleSufficient",
      trust.verified_work_count AS "verifiedWorkCount",
      experience.working_since_year AS "workingSinceYear"
    FROM current_searchable_craftsman_profiles profile
    JOIN current_searchable_craftsman_availability_signals availability
      ON availability.craftsman_profile_id = profile.craftsman_profile_id
    JOIN current_searchable_craftsman_portfolio_signals portfolio
      ON portfolio.craftsman_profile_id = profile.craftsman_profile_id
    JOIN current_searchable_craftsman_trust_signals trust
      ON trust.craftsman_profile_id = profile.craftsman_profile_id
    LEFT JOIN current_searchable_craftsman_experience experience
      ON experience.craftsman_profile_id = profile.craftsman_profile_id
    WHERE profile.craftsman_profile_id = ANY(${profileIds}::uuid[])
    ORDER BY profile.craftsman_profile_id
  `;
  return hydrateCandidateRows(sql, rows, false);
}

async function hydrateCandidateRows(
  sql: TransactionSql,
  pageRows: readonly ProfileRow[],
  hasNextPage: boolean,
) {
  const profileIds = pageRows.map(({ profileId }) => profileId);

  const professions = await sql<ProfessionRow[]>`
    SELECT craftsman_profile_id AS "profileId", profession_code AS code,
      label_sk AS label, declared_level AS "declaredLevel",
      evidence_supported_level AS "evidenceSupportedLevel"
    FROM current_searchable_craftsman_professions
    WHERE craftsman_profile_id = ANY(${profileIds}::uuid[])
    ORDER BY craftsman_profile_id, profession_code
  `;
  const specializations = await sql<SpecializationRow[]>`
    SELECT craftsman_profile_id AS "profileId", specialization_code AS code,
      label_sk AS label, profession_code AS "professionCode",
      evidence_supported AS "evidenceSupported"
    FROM current_searchable_craftsman_specializations
    WHERE craftsman_profile_id = ANY(${profileIds}::uuid[])
    ORDER BY craftsman_profile_id, specialization_code
  `;
  const skills = await sql<SkillRow[]>`
    SELECT craftsman_profile_id AS "profileId",
      canonical_skill_code AS "canonicalCode", label_sk AS label,
      profession_codes AS "professionCodes",
      evidence_supported AS "evidenceSupported"
    FROM current_searchable_craftsman_skills
    WHERE craftsman_profile_id = ANY(${profileIds}::uuid[])
    ORDER BY craftsman_profile_id, canonical_skill_code NULLS LAST, label_sk
  `;
  const credentials = await sql<CredentialRow[]>`
    SELECT craftsman_profile_id AS "profileId",
      credential_type_code AS "credentialTypeCode",
      profession_code AS "professionCode", expires_on AS "expiresOn"
    FROM current_searchable_craftsman_credentials
    WHERE craftsman_profile_id = ANY(${profileIds}::uuid[])
    ORDER BY craftsman_profile_id, credential_type_code, profession_code
  `;
  const pricing = await sql<PriceRow[]>`
    SELECT craftsman_profile_id AS "profileId", service_name AS "serviceName",
      price_mode AS mode, amount_cents AS "amountCents", currency,
      profession_code AS "professionCode"
    FROM current_searchable_craftsman_pricing
    WHERE craftsman_profile_id = ANY(${profileIds}::uuid[])
    ORDER BY craftsman_profile_id, profession_code NULLS LAST, service_name
  `;

  const candidateRows = pageRows.map((profile) =>
    serializeCandidate(
      profile,
      forProfile(professions, profile.profileId),
      forProfile(specializations, profile.profileId),
      forProfile(skills, profile.profileId),
      forProfile(credentials, profile.profileId),
      forProfile(pricing, profile.profileId),
    ),
  );
  const items = Object.freeze(
    candidateRows.filter(
      (candidate): candidate is SearchableCraftsmanCandidate =>
        candidate !== null,
    ),
  );
  return Object.freeze({
    items,
    nextCursor: hasNextPage
      ? (pageRows.at(-1)?.profileId as CraftsmanProfileId)
      : null,
  });
}

function serializeCandidate(
  profile: ProfileRow,
  professionRows: readonly ProfessionRow[],
  specializationRows: readonly SpecializationRow[],
  skillRows: readonly SkillRow[],
  credentialRows: readonly CredentialRow[],
  priceRows: readonly PriceRow[],
): SearchableCraftsmanCandidate | null {
  const professions = professionRows.map(publicProfession);
  const specializations = specializationRows.map(publicSpecialization);
  const skills = skillRows.map(publicSkill);
  const credentials = credentialRows.map(publicCredential);
  const prices = priceRows.map(publicPrice);
  const publicText = [
    profile.primaryName,
    profile.secondaryName,
    profile.baseMunicipalityName,
    ...professionRows.map(({ label }) => label),
    ...specializationRows.map(({ label }) => label),
    ...skillRows.map(({ label }) => label),
    ...priceRows.map(({ serviceName }) => serviceName),
  ];
  if (
    !isUuid(profile.profileId) ||
    !isProfileType(profile.profileType) ||
    publicText.some(
      (value) => value !== null && !isPublicDisplayTextSafe(value),
    ) ||
    !isMunicipalityCode(profile.baseMunicipalityCode) ||
    !isRadiusMeters(profile.normalRadiusMeters) ||
    (profile.maximumRadiusMeters !== null &&
      (!isRadiusMeters(profile.maximumRadiusMeters) ||
        profile.maximumRadiusMeters < profile.normalRadiusMeters)) ||
    !isCodeArray(profile.extraMunicipalityCodes, isMunicipalityCode) ||
    !isCodeArray(profile.portfolioProfessionCodes, isProfessionCode) ||
    !isCodeArray(profile.portfolioSpecializationCodes, isSpecializationCode) ||
    !isCodeArray(profile.portfolioSkillCodes, isSkillCode) ||
    !professionRows.every((_row, index) => professions[index] !== null) ||
    !specializationRows.every(
      (_row, index) => specializations[index] !== null,
    ) ||
    !skillRows.every((_row, index) => skills[index] !== null) ||
    !credentialRows.every((_row, index) => credentials[index] !== null) ||
    !priceRows.every((_row, index) => prices[index] !== null) ||
    !isNullableUuid(profile.representativeMediaAssetId) ||
    !isBoolean(profile.identityVerified) ||
    !isBoolean(profile.companyRegistrationVerified) ||
    !isBoolean(profile.hasDeclaredAvailability) ||
    !isBoolean(profile.hasVerifiedEvidence) ||
    !isBoolean(profile.hasUnverifiedContent) ||
    !isBoolean(profile.reviewSampleSufficient) ||
    !isNonnegativeInteger(profile.reviewCount) ||
    !isNonnegativeInteger(profile.verifiedWorkCount) ||
    (profile.workingSinceYear !== null &&
      (!Number.isInteger(profile.workingSinceYear) ||
        profile.workingSinceYear < 1800 ||
        profile.workingSinceYear > new Date().getUTCFullYear()))
  )
    return null;

  const customerScore = nullableFiniteNumber(profile.customerScore);
  if (customerScore === undefined) return null;
  return Object.freeze({
    profileId: profile.profileId as CraftsmanProfileId,
    identity: Object.freeze({
      profileType: profile.profileType,
      primaryName: profile.primaryName,
      secondaryName: profile.secondaryName,
      identityVerified: profile.identityVerified,
      companyRegistrationVerified: profile.companyRegistrationVerified,
    }),
    location: Object.freeze({
      baseMunicipalityCode: profile.baseMunicipalityCode,
      baseMunicipalityName: profile.baseMunicipalityName,
      normalRadiusMeters: profile.normalRadiusMeters,
      maximumRadiusMeters: profile.maximumRadiusMeters,
      extraMunicipalityCodes: Object.freeze([
        ...profile.extraMunicipalityCodes,
      ]),
    }),
    professions: Object.freeze(professions as SearchableCraftsmanProfession[]),
    specializations: Object.freeze(
      specializations as SearchableCraftsmanSpecialization[],
    ),
    skills: Object.freeze(skills as SearchableCraftsmanSkill[]),
    credentials: Object.freeze(credentials as SearchableCraftsmanCredential[]),
    experience:
      profile.workingSinceYear === null
        ? null
        : Object.freeze({
            source: "SELF_DECLARED" as const,
            workingSinceYear: profile.workingSinceYear,
          }),
    indicativePricing: Object.freeze(prices as SearchableCraftsmanPrice[]),
    signals: Object.freeze({
      availability: Object.freeze({
        hasDeclaredAvailability: profile.hasDeclaredAvailability,
      }),
      portfolio: Object.freeze({
        hasVerifiedEvidence: profile.hasVerifiedEvidence,
        hasUnverifiedContent: profile.hasUnverifiedContent,
        professionCodes: Object.freeze([...profile.portfolioProfessionCodes]),
        specializationCodes: Object.freeze([
          ...profile.portfolioSpecializationCodes,
        ]),
        skillCodes: Object.freeze([...profile.portfolioSkillCodes]),
        representativeMediaAssetId: profile.representativeMediaAssetId,
      }),
      trust: Object.freeze({
        customerScore,
        reviewCount: profile.reviewCount,
        reviewSampleSufficient: profile.reviewSampleSufficient,
        verifiedWorkCount: profile.verifiedWorkCount,
      }),
    }),
  });
}

function publicProfession(
  row: ProfessionRow,
): SearchableCraftsmanProfession | null {
  return isProfessionCode(row.code) &&
    isLevel(row.declaredLevel) &&
    (row.evidenceSupportedLevel === null || isLevel(row.evidenceSupportedLevel))
    ? Object.freeze({
        code: row.code,
        label: row.label,
        declaredLevel: row.declaredLevel,
        evidenceSupportedLevel: row.evidenceSupportedLevel,
      })
    : null;
}

function publicSpecialization(
  row: SpecializationRow,
): SearchableCraftsmanSpecialization | null {
  return isSpecializationCode(row.code) &&
    isProfessionCode(row.professionCode) &&
    isBoolean(row.evidenceSupported)
    ? Object.freeze({
        code: row.code,
        label: row.label,
        professionCode: row.professionCode,
        evidenceSupported: row.evidenceSupported,
      })
    : null;
}

function publicSkill(row: SkillRow): SearchableCraftsmanSkill | null {
  return (row.canonicalCode === null || isSkillCode(row.canonicalCode)) &&
    isCodeArray(row.professionCodes, isProfessionCode) &&
    isBoolean(row.evidenceSupported)
    ? Object.freeze({
        canonicalCode: row.canonicalCode,
        label: row.label,
        professionCodes: Object.freeze([...row.professionCodes]),
        evidenceSupported: row.evidenceSupported,
      })
    : null;
}

function publicCredential(
  row: CredentialRow,
): SearchableCraftsmanCredential | null {
  const expiresOn = dateOnly(row.expiresOn);
  return isCredentialTypeCode(row.credentialTypeCode) &&
    isProfessionCode(row.professionCode) &&
    expiresOn !== undefined
    ? Object.freeze({
        credentialTypeCode: row.credentialTypeCode,
        professionCode: row.professionCode,
        expiresOn,
        verification: "ADMIN_APPROVED" as const,
      })
    : null;
}

function publicPrice(row: PriceRow): SearchableCraftsmanPrice | null {
  const amountCents = Number(row.amountCents);
  return isPublicDisplayTextSafe(row.serviceName) &&
    isPriceMode(row.mode) &&
    Number.isSafeInteger(amountCents) &&
    amountCents > 0 &&
    row.currency === "EUR" &&
    (row.professionCode === null || isProfessionCode(row.professionCode))
    ? Object.freeze({
        serviceName: row.serviceName,
        mode: row.mode,
        amountCents,
        currency: "EUR" as const,
        professionCode: row.professionCode,
      })
    : null;
}

function forProfile<T extends { readonly profileId: string }>(
  rows: readonly T[],
  profileId: string,
): T[] {
  return rows.filter((row) => row.profileId === profileId);
}

function isProfileType(value: unknown): value is ProfileRow["profileType"] {
  return value === "INDIVIDUAL" || value === "COMPANY";
}

function isMunicipalityCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^[A-Z0-9][A-Z0-9._:-]*$/u.test(value)
  );
}

function isProfessionCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
  );
}

function isSpecializationCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:SPEC|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
  );
}

function isSkillCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:SKILL|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
  );
}

function isCredentialTypeCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value)
  );
}

function isCodeArray(
  value: unknown,
  predicate: (candidate: unknown) => candidate is string,
): value is string[] {
  return Array.isArray(value) && value.every(predicate);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function isNullableUuid(value: unknown): value is string | null {
  return value === null || isUuid(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRadiusMeters(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= 20_040_000
  );
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isLevel(value: unknown): value is ProfessionRow["declaredLevel"] {
  return value === "BEGINNER" || value === "ADVANCED" || value === "MASTER";
}

function isPriceMode(
  value: unknown,
): value is SearchableCraftsmanPrice["mode"] {
  return [
    "FROM",
    "APPROXIMATE",
    "HOURLY",
    "PER_SQUARE_METER",
    "PER_UNIT",
    "OTHER",
  ].includes(value as SearchableCraftsmanPrice["mode"]);
}

function nullableFiniteNumber(
  value: number | string | null,
): number | null | undefined {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 5
    ? numeric
    : undefined;
}

function dateOnly(value: Date | string | null): string | null | undefined {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : undefined;
}

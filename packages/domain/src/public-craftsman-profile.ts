import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type {
  PortfolioDurationUnit,
  PortfolioProjectId,
} from "./portfolio-project.js";

export const PUBLIC_CRAFTSMAN_PROFILE_FIELDS = Object.freeze([
  "profileId",
  "identity",
  "professions",
  "location",
  "trust",
  "callToAction",
  "portfolio",
  "skills",
  "specializations",
  "indicativePricing",
  "experience",
  "credentials",
] as const);

export interface PublicCraftsmanProfile {
  readonly profileId: CraftsmanProfileId;
  readonly identity: Readonly<{
    profileType: "INDIVIDUAL" | "COMPANY";
    primaryName: string;
    secondaryName: string | null;
    about: string;
  }>;
  readonly professions: readonly PublicCraftsmanProfession[];
  readonly location: Readonly<{
    baseMunicipality: PublicMunicipality;
    normalRadiusMeters: number;
    extraMunicipalities: readonly PublicMunicipality[];
  }>;
  readonly trust: Readonly<{
    identityVerified: boolean;
    companyRegistrationVerified: boolean;
    customerScore: number | null;
    reviewCount: number;
    verifiedWorkCount: number;
  }>;
  readonly callToAction: Readonly<{ kind: "PLATFORM_JOB_REQUEST" }>;
  readonly portfolio: readonly PublicPortfolioProject[];
  readonly skills: readonly PublicCraftsmanSkill[];
  readonly specializations: readonly PublicCraftsmanSpecialization[];
  readonly indicativePricing: readonly PublicIndicativePrice[];
  readonly experience: Readonly<{
    source: "SELF_DECLARED";
    workingSinceYear: number;
  }> | null;
  readonly credentials: readonly PublicVerifiedCredential[];
}

export interface PublicCraftsmanProfilePersistence {
  findPublic(
    craftsmanProfileId: string,
  ): Promise<PublicCraftsmanProfile | null>;
}

export interface PublicCraftsmanProfession {
  readonly code: string;
  readonly label: string;
  readonly declaredProficiency: Readonly<{
    level: "BEGINNER" | "ADVANCED" | "MASTER";
    source: "SELF_DECLARED";
  }>;
  readonly evidenceSupportedProficiency: Readonly<{
    level: "BEGINNER" | "ADVANCED" | "MASTER";
    source: "EVIDENCE_SUPPORTED";
  }> | null;
}

export interface PublicMunicipality {
  readonly code: string;
  readonly name: string;
}

export interface PublicCraftsmanSkill {
  readonly canonicalCode: string | null;
  readonly declared: Readonly<{ label: string; source: "SELF_DECLARED" }>;
  readonly evidenceSupported: boolean;
  readonly professionCodes: readonly string[];
}

export interface PublicCraftsmanSpecialization {
  readonly code: string;
  readonly declared: Readonly<{ label: string; source: "SELF_DECLARED" }>;
  readonly evidenceSupported: boolean;
  readonly professionCode: string;
}

export interface PublicIndicativePrice {
  readonly amountCents: number;
  readonly currency: "EUR";
  readonly mode:
    | "FROM"
    | "APPROXIMATE"
    | "HOURLY"
    | "PER_SQUARE_METER"
    | "PER_UNIT"
    | "OTHER";
  readonly note: string | null;
  readonly professionCode: string | null;
  readonly serviceName: string;
}

export interface PublicVerifiedCredential {
  readonly credentialTypeCode: string;
  readonly expiresOn: string | null;
  readonly professionCode: string;
  readonly verification: "ADMIN_APPROVED";
}

export interface PublicPortfolioProject {
  readonly projectId: PortfolioProjectId;
  readonly title: string;
  readonly shortDescription: string;
  readonly provenance: Readonly<{
    kind: "SELF_DECLARED";
    evidenceStatus: "UNVERIFIED";
  }>;
  readonly contribution: string | null;
  readonly materialsAndTechnologies: string | null;
  readonly problem: string | null;
  readonly solution: string | null;
  readonly duration: Readonly<{
    value: number;
    unit: PortfolioDurationUnit;
  }> | null;
  readonly indicativePrice: Readonly<{
    currency: "EUR";
    minCents: number;
    maxCents: number;
  }> | null;
  readonly approximateLocation: Readonly<{
    municipalityCode: string;
    districtCode: string;
  }> | null;
  readonly professions: readonly Readonly<{ code: string; label: string }>[];
  readonly skills: readonly Readonly<{
    canonicalCode: string | null;
    label: string;
  }>[];
  readonly specializations: readonly Readonly<{
    code: string;
    label: string;
  }>[];
  readonly photos: readonly PublicPortfolioPhoto[];
}

export interface PublicPortfolioPhoto {
  readonly mediaAssetId: string;
  readonly phase: "BEFORE" | "PROGRESS" | "AFTER" | "OTHER";
  readonly displayOrder: number;
  readonly width: number;
  readonly height: number;
}

export interface PublicCraftsmanProfileCandidate extends Omit<
  PublicCraftsmanProfile,
  "callToAction" | "portfolio"
> {
  readonly callToAction?: unknown;
  readonly portfolio?: unknown;
}

export function isPublicCraftsmanProfileId(
  value: unknown,
): value is CraftsmanProfileId {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

/**
 * Copies only the public contract. Runtime extras are deliberately discarded,
 * and unsafe display text makes the whole projection unavailable.
 */
export function serializePublicCraftsmanProfile(
  candidate: PublicCraftsmanProfileCandidate,
): PublicCraftsmanProfile | null {
  const portfolio = serializePublicPortfolio(candidate.portfolio);
  if (portfolio === null) return null;
  const displayText = [
    candidate.identity.primaryName,
    candidate.identity.secondaryName,
    candidate.identity.about,
    candidate.location.baseMunicipality.name,
    ...candidate.location.extraMunicipalities.map(({ name }) => name),
    ...candidate.professions.map(({ label }) => label),
    ...candidate.skills.map(({ declared }) => declared.label),
    ...candidate.specializations.map(({ declared }) => declared.label),
    ...candidate.indicativePricing.flatMap(({ note, serviceName }) => [
      serviceName,
      note,
    ]),
    ...portfolio.flatMap((project) => [
      project.title,
      project.shortDescription,
      project.contribution,
      project.materialsAndTechnologies,
      project.problem,
      project.solution,
      ...project.professions.map(({ label }) => label),
      ...project.skills.map(({ label }) => label),
      ...project.specializations.map(({ label }) => label),
    ]),
  ];
  if (
    displayText.some(
      (value) => value !== null && !isPublicDisplayTextSafe(value),
    )
  ) {
    return null;
  }

  return {
    profileId: candidate.profileId,
    identity: {
      profileType: candidate.identity.profileType,
      primaryName: candidate.identity.primaryName,
      secondaryName: candidate.identity.secondaryName,
      about: candidate.identity.about,
    },
    professions: candidate.professions.map((profession) => ({
      code: profession.code,
      label: profession.label,
      declaredProficiency: {
        level: profession.declaredProficiency.level,
        source: "SELF_DECLARED",
      },
      evidenceSupportedProficiency:
        profession.evidenceSupportedProficiency === null
          ? null
          : {
              level: profession.evidenceSupportedProficiency.level,
              source: "EVIDENCE_SUPPORTED",
            },
    })),
    location: {
      baseMunicipality: {
        code: candidate.location.baseMunicipality.code,
        name: candidate.location.baseMunicipality.name,
      },
      normalRadiusMeters: candidate.location.normalRadiusMeters,
      extraMunicipalities: candidate.location.extraMunicipalities.map(
        (municipality) => ({
          code: municipality.code,
          name: municipality.name,
        }),
      ),
    },
    trust: {
      identityVerified: candidate.trust.identityVerified,
      companyRegistrationVerified: candidate.trust.companyRegistrationVerified,
      customerScore: candidate.trust.customerScore,
      reviewCount: candidate.trust.reviewCount,
      verifiedWorkCount: candidate.trust.verifiedWorkCount,
    },
    callToAction: { kind: "PLATFORM_JOB_REQUEST" },
    portfolio,
    skills: candidate.skills.map((skill) => ({
      canonicalCode: skill.canonicalCode,
      declared: { label: skill.declared.label, source: "SELF_DECLARED" },
      evidenceSupported: skill.evidenceSupported,
      professionCodes: [...skill.professionCodes],
    })),
    specializations: candidate.specializations.map((specialization) => ({
      code: specialization.code,
      declared: {
        label: specialization.declared.label,
        source: "SELF_DECLARED",
      },
      evidenceSupported: specialization.evidenceSupported,
      professionCode: specialization.professionCode,
    })),
    indicativePricing: candidate.indicativePricing.map((price) => ({
      amountCents: price.amountCents,
      currency: "EUR",
      mode: price.mode,
      note: price.note,
      professionCode: price.professionCode,
      serviceName: price.serviceName,
    })),
    experience:
      candidate.experience === null
        ? null
        : {
            source: "SELF_DECLARED",
            workingSinceYear: candidate.experience.workingSinceYear,
          },
    credentials: candidate.credentials.map((credential) => ({
      credentialTypeCode: credential.credentialTypeCode,
      expiresOn: credential.expiresOn,
      professionCode: credential.professionCode,
      verification: "ADMIN_APPROVED",
    })),
  };
}

function serializePublicPortfolio(
  value: unknown,
): readonly PublicPortfolioProject[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const projects: PublicPortfolioProject[] = [];
  const projectIds = new Set<string>();
  const mediaAssetIds = new Set<string>();
  for (const candidate of value as unknown[]) {
    if (!isRecord(candidate) || !isUuid(candidate.projectId)) return null;
    if (projectIds.has(candidate.projectId)) return null;
    projectIds.add(candidate.projectId);
    const duration = publicDuration(candidate.duration);
    const indicativePrice = publicIndicativePrice(candidate.indicativePrice);
    const approximateLocation = publicApproximateLocation(
      candidate.approximateLocation,
    );
    const professions = publicCodeLabels(candidate.professions, false);
    const skills = publicSkillLabels(candidate.skills);
    const specializations = publicCodeLabels(candidate.specializations, false);
    const photos = publicPhotos(candidate.photos, mediaAssetIds);
    if (
      !isRequiredText(candidate.title) ||
      !isRequiredText(candidate.shortDescription) ||
      !isNullableText(candidate.contribution) ||
      !isNullableText(candidate.materialsAndTechnologies) ||
      !isNullableText(candidate.problem) ||
      !isNullableText(candidate.solution) ||
      !isRecord(candidate.provenance) ||
      candidate.provenance.kind !== "SELF_DECLARED" ||
      candidate.provenance.evidenceStatus !== "UNVERIFIED" ||
      duration === undefined ||
      indicativePrice === undefined ||
      approximateLocation === undefined ||
      professions === null ||
      skills === null ||
      specializations === null ||
      photos === null
    ) {
      return null;
    }
    projects.push({
      projectId: candidate.projectId as PortfolioProjectId,
      title: candidate.title,
      shortDescription: candidate.shortDescription,
      provenance: { kind: "SELF_DECLARED", evidenceStatus: "UNVERIFIED" },
      contribution: candidate.contribution,
      materialsAndTechnologies: candidate.materialsAndTechnologies,
      problem: candidate.problem,
      solution: candidate.solution,
      duration,
      indicativePrice,
      approximateLocation,
      professions,
      skills,
      specializations,
      photos,
    });
  }
  return projects;
}

function publicDuration(
  value: unknown,
): PublicPortfolioProject["duration"] | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.value) ||
    (value.value as number) <= 0 ||
    !["DAYS", "WEEKS", "MONTHS"].includes(value.unit as string)
  ) {
    return undefined;
  }
  return {
    value: value.value as number,
    unit: value.unit as PortfolioDurationUnit,
  };
}

function publicIndicativePrice(
  value: unknown,
): PublicPortfolioProject["indicativePrice"] | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    value.currency !== "EUR" ||
    !isSafeMoney(value.minCents) ||
    !isSafeMoney(value.maxCents) ||
    value.minCents > value.maxCents
  ) {
    return undefined;
  }
  return {
    currency: "EUR",
    minCents: value.minCents,
    maxCents: value.maxCents,
  };
}

function publicApproximateLocation(
  value: unknown,
): PublicPortfolioProject["approximateLocation"] | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !isRequiredText(value.municipalityCode) ||
    !isRequiredText(value.districtCode)
  ) {
    return undefined;
  }
  return {
    municipalityCode: value.municipalityCode,
    districtCode: value.districtCode,
  };
}

function publicCodeLabels(
  value: unknown,
  allowNullCode: boolean,
): readonly Readonly<{ code: string; label: string }>[] | null {
  if (!Array.isArray(value)) return null;
  const values: { code: string; label: string }[] = [];
  const codes = new Set<string>();
  for (const item of value as unknown[]) {
    if (
      !isRecord(item) ||
      (!allowNullCode && !isRequiredText(item.code)) ||
      !isRequiredText(item.label)
    ) {
      return null;
    }
    const code = item.code as string;
    if (codes.has(code)) return null;
    codes.add(code);
    values.push({ code, label: item.label });
  }
  return values;
}

function publicSkillLabels(
  value: unknown,
): readonly Readonly<{ canonicalCode: string | null; label: string }>[] | null {
  if (!Array.isArray(value)) return null;
  const values: { canonicalCode: string | null; label: string }[] = [];
  for (const item of value as unknown[]) {
    if (
      !isRecord(item) ||
      (item.canonicalCode !== null && !isRequiredText(item.canonicalCode)) ||
      !isRequiredText(item.label)
    ) {
      return null;
    }
    values.push({ canonicalCode: item.canonicalCode, label: item.label });
  }
  return values;
}

function publicPhotos(
  value: unknown,
  mediaAssetIds: Set<string>,
): readonly PublicPortfolioPhoto[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 15) {
    return null;
  }
  const photos: PublicPortfolioPhoto[] = [];
  for (const [index, item] of (value as unknown[]).entries()) {
    if (
      !isRecord(item) ||
      !isUuid(item.mediaAssetId) ||
      mediaAssetIds.has(item.mediaAssetId) ||
      !["BEFORE", "PROGRESS", "AFTER", "OTHER"].includes(
        item.phase as string,
      ) ||
      item.displayOrder !== index + 1 ||
      !Number.isSafeInteger(item.width) ||
      (item.width as number) <= 0 ||
      !Number.isSafeInteger(item.height) ||
      (item.height as number) <= 0
    ) {
      return null;
    }
    mediaAssetIds.add(item.mediaAssetId);
    photos.push({
      mediaAssetId: item.mediaAssetId,
      phase: item.phase as PublicPortfolioPhoto["phase"],
      displayOrder: item.displayOrder,
      width: item.width as number,
      height: item.height as number,
    });
  }
  return photos;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequiredText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableText(value: unknown): value is string | null {
  return value === null || isRequiredText(value);
}

function isSafeMoney(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

export function isPublicDisplayTextSafe(value: string): boolean {
  return (
    value === value.trim() &&
    value.length > 0 &&
    !hasUnsafeControlCharacter(value) &&
    !/[\p{L}\p{N}_.%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/iu.test(value) &&
    !/(^|\s)@[\p{L}\p{N}_]{2,}/iu.test(value) &&
    !/(^|[^0-9])(\+|00)?[0-9]([\s()./-]*[0-9]){6,}([^0-9]|$)/u.test(value) &&
    !/\b(https?:\/\/|www\.)/iu.test(value) &&
    !/(^|[^\p{L}\p{N}_-])[\p{L}\p{N}][\p{L}\p{N}-]{0,62}(\.[\p{L}\p{N}-]{1,63})*\.\p{L}{2,24}([^\p{L}\p{N}_-]|$)/iu.test(
      value,
    ) &&
    !/(^|[^0-9])[0-9]{3}\s?[0-9]{2}([^0-9]|$)/u.test(value) &&
    !/\b(adresa|ulica|námestie|trieda|číslo domu|číslo bytu)\b|\b(ul|nám)\./iu.test(
      value,
    ) &&
    !/\b(heslo|password|api[ _-]?key|access[ _-]?token|secret|tajný kľúč)\b/iu.test(
      value,
    )
  );
}

function hasUnsafeControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    );
  });
}

import type { CraftsmanProfileId } from "./craftsman-profile.js";

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
  /** Fail-closed until a project publication and consent projection is wired. */
  readonly portfolio: readonly [];
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
    portfolio: [],
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

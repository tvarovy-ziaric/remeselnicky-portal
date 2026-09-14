import {
  isPublicCraftsmanProfileId,
  serializePublicCraftsmanProfile,
  type CraftsmanProfileId,
  type PublicCraftsmanProfileCandidate,
  type PublicCraftsmanProfilePersistence,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface ProfileRow {
  readonly about: string;
  readonly baseMunicipalityCode: string;
  readonly baseMunicipalityName: string;
  readonly companyRegistrationVerified: boolean;
  readonly identityVerified: boolean;
  readonly nickname: string | null;
  readonly normalRadiusMeters: number;
  readonly officialCompanyName: string | null;
  readonly profileType: "INDIVIDUAL" | "COMPANY";
  readonly realFirstName: string | null;
  readonly realLastName: string | null;
}

interface ProfessionRow {
  readonly code: string;
  readonly declaredLevel: "BEGINNER" | "ADVANCED" | "MASTER";
  readonly evidenceSupportedLevel: "BEGINNER" | "ADVANCED" | "MASTER" | null;
  readonly label: string;
}

interface MunicipalityRow {
  readonly code: string;
  readonly name: string;
}

interface SkillRow {
  readonly canonicalCode: string | null;
  readonly evidenceSupportedAt: Date | null;
  readonly label: string;
  readonly professionCodes: string[];
}

interface SpecializationRow {
  readonly code: string;
  readonly evidenceSupportedAt: Date | null;
  readonly label: string;
  readonly professionCode: string;
}

interface PriceRow {
  readonly amountCents: number | string;
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

interface ExperienceRow {
  readonly workingSinceYear: number;
}

interface CredentialRow {
  readonly credentialTypeCode: string;
  readonly expiresOn: Date | string | null;
  readonly professionCode: string;
}

export function createPublicCraftsmanProfileRepository(
  sql: Sql,
): PublicCraftsmanProfilePersistence {
  return Object.freeze({
    async findPublic(profileId: string) {
      if (!isPublicCraftsmanProfileId(profileId)) return null;

      return sql.begin(
        "isolation level repeatable read read only",
        async (transaction) => findInSnapshot(transaction, profileId),
      );
    },
  });
}

async function findInSnapshot(
  sql: TransactionSql,
  profileId: CraftsmanProfileId,
) {
  const [profile] = await sql<ProfileRow[]>`
    SELECT
      profile.profile_type AS "profileType",
      profile.real_first_name AS "realFirstName",
      profile.real_last_name AS "realLastName",
      profile.nickname,
      profile.official_company_name AS "officialCompanyName",
      profile.about,
      (profile.identity_verified_at IS NOT NULL) AS "identityVerified",
      (profile.company_registration_verified_at IS NOT NULL)
        AS "companyRegistrationVerified",
      area.base_municipality_code AS "baseMunicipalityCode",
      municipality.name_sk AS "baseMunicipalityName",
      area.normal_radius_meters AS "normalRadiusMeters"
    FROM current_craftsman_profile_publications publication
    JOIN craftsman_profiles profile
      ON profile.id = publication.craftsman_profile_id
    JOIN users owner ON owner.id = profile.owner_user_id
    JOIN current_craftsman_service_areas area
      ON area.craftsman_profile_id = profile.id
    JOIN location_municipalities municipality
      ON municipality.code = area.base_municipality_code
    WHERE profile.id = ${profileId}
      AND publication.effectively_public
      AND publication.review_state = 'APPROVED'
      AND publication.owner_visibility = 'PUBLIC'
      AND publication.moderation_state = 'ALLOWED'
      AND owner.account_state = 'ACTIVE'
  `;
  if (profile === undefined) return null;

  const extras = await sql<MunicipalityRow[]>`
    SELECT municipality.code, municipality.name_sk AS name
    FROM current_craftsman_service_areas area
    JOIN craftsman_service_area_extra_municipalities extra
      ON extra.service_area_revision_id = area.id
    JOIN location_municipalities municipality
      ON municipality.code = extra.municipality_code
    WHERE area.craftsman_profile_id = ${profileId}
    ORDER BY extra.ordinal, municipality.code
  `;
  const professions = await sql<ProfessionRow[]>`
    SELECT
      profession.profession_code AS code,
      taxonomy.label_sk AS label,
      profession.declared_level AS "declaredLevel",
      profession.evidence_supported_level AS "evidenceSupportedLevel"
    FROM current_craftsman_professions profession
    JOIN taxonomy_professions taxonomy
      ON taxonomy.release_id = profession.taxonomy_release_id
      AND taxonomy.profession_code = profession.profession_code
    WHERE profession.craftsman_profile_id = ${profileId}
      AND profession.state = 'ACTIVE'
    ORDER BY profession.created_at, profession.id
  `;
  const skills = await sql<SkillRow[]>`
    SELECT
      COALESCE(
        skill.mapped_canonical_skill_code,
        CASE WHEN skill.identity_kind = 'CANONICAL'
          THEN skill.canonical_skill_code END
      ) AS "canonicalCode",
      CASE WHEN skill.identity_kind = 'CANONICAL'
        THEN original.label_sk ELSE skill.retained_custom_text END AS label,
      skill.evidence_supported_at AS "evidenceSupportedAt",
      ARRAY(
        SELECT profession.profession_code
        FROM current_craftsman_professions profession
        WHERE profession.id = ANY(skill.profession_ids)
          AND profession.state = 'ACTIVE'
        ORDER BY profession.profession_code
      ) AS "professionCodes"
    FROM current_craftsman_skills skill
    LEFT JOIN skill_catalog_skills original
      ON original.release_id = skill.skill_catalog_release_id
      AND original.skill_code = skill.canonical_skill_code
    WHERE skill.craftsman_profile_id = ${profileId}
      AND skill.state = 'ACTIVE'
    ORDER BY skill.created_at, skill.id
  `;
  const specializations = await sql<SpecializationRow[]>`
    SELECT
      specialization.specialization_code AS code,
      taxonomy.label_sk AS label,
      specialization.evidence_supported_at AS "evidenceSupportedAt",
      profession.profession_code AS "professionCode"
    FROM current_craftsman_specializations specialization
    JOIN taxonomy_specializations taxonomy
      ON taxonomy.release_id = specialization.taxonomy_release_id
      AND taxonomy.specialization_code = specialization.specialization_code
    JOIN current_craftsman_professions profession
      ON profession.id = specialization.craftsman_profession_id
      AND profession.state = 'ACTIVE'
    WHERE specialization.craftsman_profile_id = ${profileId}
      AND specialization.state = 'ACTIVE'
    ORDER BY specialization.created_at, specialization.id
  `;
  const pricing = await sql<PriceRow[]>`
    SELECT
      price.service_name AS "serviceName",
      price.price_mode AS mode,
      price.amount_cents AS "amountCents",
      price.note,
      profession.profession_code AS "professionCode"
    FROM indicative_pricing_entries price
    LEFT JOIN current_craftsman_professions profession
      ON profession.id = price.craftsman_profession_id
      AND profession.state = 'ACTIVE'
    WHERE price.craftsman_profile_id = ${profileId}
      AND price.state = 'ACTIVE'
      AND (
        price.craftsman_profession_id IS NULL
        OR profession.id IS NOT NULL
      )
    ORDER BY price.created_at, price.id
  `;
  const [experience] = await sql<ExperienceRow[]>`
    SELECT experience.working_since_year AS "workingSinceYear"
    FROM current_craftsman_experience experience
    WHERE experience.craftsman_profile_id = ${profileId}
  `;
  const credentials = await sql<CredentialRow[]>`
    SELECT
      claim.credential_type_code AS "credentialTypeCode",
      claim.expires_on AS "expiresOn",
      profession.profession_code AS "professionCode"
    FROM credential_claims claim
    JOIN credential_type_policies policy
      ON policy.code = claim.credential_type_code AND policy.active
    JOIN current_craftsman_professions profession
      ON profession.id = claim.craftsman_profession_id
      AND profession.state = 'ACTIVE'
    WHERE claim.craftsman_profile_id = ${profileId}
      AND claim.state = 'APPROVED'
      AND (claim.expires_on IS NULL OR claim.expires_on >= CURRENT_DATE)
    ORDER BY claim.created_at, claim.id
  `;

  const candidate: PublicCraftsmanProfileCandidate = {
    profileId,
    identity: publicIdentity(profile),
    professions: professions.map((profession) => ({
      code: profession.code,
      label: profession.label,
      declaredProficiency: {
        level: profession.declaredLevel,
        source: "SELF_DECLARED",
      },
      evidenceSupportedProficiency:
        profession.evidenceSupportedLevel === null
          ? null
          : {
              level: profession.evidenceSupportedLevel,
              source: "EVIDENCE_SUPPORTED",
            },
    })),
    location: {
      baseMunicipality: {
        code: profile.baseMunicipalityCode,
        name: profile.baseMunicipalityName,
      },
      normalRadiusMeters: profile.normalRadiusMeters,
      extraMunicipalities: extras,
    },
    trust: {
      identityVerified: profile.identityVerified,
      companyRegistrationVerified: profile.companyRegistrationVerified,
      customerScore: null,
      reviewCount: 0,
      verifiedWorkCount: 0,
    },
    skills: skills.map((skill) => ({
      canonicalCode: skill.canonicalCode,
      declared: { label: skill.label, source: "SELF_DECLARED" },
      evidenceSupported: skill.evidenceSupportedAt !== null,
      professionCodes: skill.professionCodes,
    })),
    specializations: specializations.map((specialization) => ({
      code: specialization.code,
      declared: { label: specialization.label, source: "SELF_DECLARED" },
      evidenceSupported: specialization.evidenceSupportedAt !== null,
      professionCode: specialization.professionCode,
    })),
    indicativePricing: pricing.map((price) => ({
      amountCents: safeInteger(price.amountCents),
      currency: "EUR",
      mode: price.mode,
      note: price.note,
      professionCode: price.professionCode,
      serviceName: price.serviceName,
    })),
    experience:
      experience === undefined
        ? null
        : {
            source: "SELF_DECLARED",
            workingSinceYear: experience.workingSinceYear,
          },
    credentials: credentials.map((credential) => ({
      credentialTypeCode: credential.credentialTypeCode,
      expiresOn: dateOnly(credential.expiresOn),
      professionCode: credential.professionCode,
      verification: "ADMIN_APPROVED",
    })),
  };
  return serializePublicCraftsmanProfile(candidate);
}

function publicIdentity(profile: ProfileRow) {
  if (profile.profileType === "COMPANY") {
    if (profile.officialCompanyName === null) {
      throw new Error(
        "Published company profile is missing its public identity.",
      );
    }
    return {
      profileType: "COMPANY" as const,
      primaryName: profile.officialCompanyName,
      secondaryName: null,
      about: profile.about,
    };
  }
  if (profile.realFirstName === null || profile.realLastName === null) {
    throw new Error(
      "Published individual profile is missing its public identity.",
    );
  }
  const realName = `${profile.realFirstName} ${profile.realLastName}`;
  return {
    profileType: "INDIVIDUAL" as const,
    primaryName: profile.nickname ?? realName,
    secondaryName: profile.nickname === null ? null : realName,
    about: profile.about,
  };
}

function safeInteger(value: number | string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(
      "Public monetary amount is outside the safe integer range.",
    );
  }
  return numeric;
}

function dateOnly(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error("Public credential expiry has an invalid date shape.");
  }
  return value;
}

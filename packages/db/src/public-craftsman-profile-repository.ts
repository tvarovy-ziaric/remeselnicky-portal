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
  readonly verifiedWorkCount: number;
}

interface ProfessionRow {
  readonly code: string;
  readonly declaredLevel: "BEGINNER" | "ADVANCED" | "MASTER";
  readonly evidenceSupportedLevel: "BEGINNER" | "ADVANCED" | "MASTER" | null;
  readonly label: string;
  readonly verifiedJobCount: number;
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

interface PortfolioProjectRow {
  readonly contribution: string | null;
  readonly districtCode: string | null;
  readonly durationUnit: "DAYS" | "WEEKS" | "MONTHS" | null;
  readonly durationValue: number | null;
  readonly indicativePriceMaxCents: number | string | null;
  readonly indicativePriceMinCents: number | string | null;
  readonly materialsAndTechnologies: string | null;
  readonly municipalityCode: string | null;
  readonly problem: string | null;
  readonly projectId: string;
  readonly shortDescription: string;
  readonly solution: string | null;
  readonly title: string;
}

interface PortfolioPhotoRow {
  readonly canonicalHeight: number;
  readonly canonicalWidth: number;
  readonly displayOrder: number;
  readonly mediaAssetId: string;
  readonly phase: "BEFORE" | "PROGRESS" | "AFTER" | "OTHER";
  readonly projectId: string;
}

interface PortfolioProfessionRow {
  readonly code: string;
  readonly label: string;
  readonly projectId: string;
}

interface PortfolioSkillRow {
  readonly canonicalCode: string | null;
  readonly label: string;
  readonly projectId: string;
}

interface PortfolioSpecializationRow {
  readonly code: string;
  readonly label: string;
  readonly projectId: string;
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
      area.normal_radius_meters AS "normalRadiusMeters",
      (
        SELECT count(DISTINCT completed.job_id)::integer
        FROM completed_job_profile_evidence completed
        WHERE completed.craftsman_profile_id = profile.id
      ) AS "verifiedWorkCount"
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
      profession.evidence_supported_level AS "evidenceSupportedLevel",
      (
        SELECT count(DISTINCT completed.job_id)::integer
        FROM completed_job_profession_evidence completed
        WHERE completed.craftsman_profile_id = profession.craftsman_profile_id
          AND completed.profession_code = profession.profession_code
      ) AS "verifiedJobCount"
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
  const portfolioProjects = await sql<PortfolioProjectRow[]>`
    SELECT project.portfolio_project_id AS "projectId", project.title,
      project.short_description AS "shortDescription", project.contribution,
      project.materials_and_technologies AS "materialsAndTechnologies",
      project.problem, project.solution, project.duration_value AS "durationValue",
      project.duration_unit AS "durationUnit",
      project.indicative_price_min_cents AS "indicativePriceMinCents",
      project.indicative_price_max_cents AS "indicativePriceMaxCents",
      project.municipality_code AS "municipalityCode",
      project.district_code AS "districtCode"
    FROM current_public_portfolio_projects project
    LEFT JOIN current_featured_project_candidates featured
      ON featured.craftsman_profile_id = project.craftsman_profile_id
      AND featured.portfolio_project_id = project.portfolio_project_id
    WHERE project.craftsman_profile_id = ${profileId}
      AND project.provenance_kind = 'SELF_DECLARED'
      AND project.evidence_status = 'UNVERIFIED'
    ORDER BY CASE WHEN featured.portfolio_project_id IS NULL THEN 1 ELSE 0 END,
      featured.position NULLS LAST, project.portfolio_project_id
  `;
  const portfolioPhotos = await sql<PortfolioPhotoRow[]>`
    SELECT photo.portfolio_project_id AS "projectId",
      photo.media_asset_id AS "mediaAssetId", photo.phase,
      photo.display_order AS "displayOrder",
      photo.canonical_width AS "canonicalWidth",
      photo.canonical_height AS "canonicalHeight"
    FROM current_public_portfolio_project_photos photo
    WHERE photo.craftsman_profile_id = ${profileId}
    ORDER BY photo.portfolio_project_id, photo.display_order, photo.media_asset_id
  `;
  const portfolioProfessions = await sql<PortfolioProfessionRow[]>`
    SELECT public_project.portfolio_project_id AS "projectId",
      profession.profession_code AS code, taxonomy.label_sk AS label
    FROM current_public_portfolio_projects public_project
    JOIN portfolio_projects project ON project.id = public_project.portfolio_project_id
    JOIN current_craftsman_professions profession
      ON profession.id = ANY(project.profession_ids)
      AND profession.craftsman_profile_id = public_project.craftsman_profile_id
      AND profession.state = 'ACTIVE'
    JOIN taxonomy_professions taxonomy
      ON taxonomy.release_id = profession.taxonomy_release_id
      AND taxonomy.profession_code = profession.profession_code
    WHERE public_project.craftsman_profile_id = ${profileId}
    ORDER BY public_project.portfolio_project_id,
      array_position(project.profession_ids, profession.id), profession.id
  `;
  const portfolioSkills = await sql<PortfolioSkillRow[]>`
    SELECT public_project.portfolio_project_id AS "projectId",
      COALESCE(skill.mapped_canonical_skill_code,
        CASE WHEN skill.identity_kind = 'CANONICAL'
          THEN skill.canonical_skill_code END) AS "canonicalCode",
      CASE WHEN skill.identity_kind = 'CANONICAL'
        THEN catalog.label_sk ELSE skill.retained_custom_text END AS label
    FROM current_public_portfolio_projects public_project
    JOIN portfolio_projects project ON project.id = public_project.portfolio_project_id
    JOIN current_craftsman_skills skill
      ON skill.id = ANY(project.skill_ids)
      AND skill.craftsman_profile_id = public_project.craftsman_profile_id
      AND skill.state = 'ACTIVE'
    LEFT JOIN skill_catalog_skills catalog
      ON catalog.release_id = skill.skill_catalog_release_id
      AND catalog.skill_code = skill.canonical_skill_code
    WHERE public_project.craftsman_profile_id = ${profileId}
    ORDER BY public_project.portfolio_project_id,
      array_position(project.skill_ids, skill.id), skill.id
  `;
  const portfolioSpecializations = await sql<PortfolioSpecializationRow[]>`
    SELECT public_project.portfolio_project_id AS "projectId",
      specialization.specialization_code AS code, taxonomy.label_sk AS label
    FROM current_public_portfolio_projects public_project
    JOIN portfolio_projects project ON project.id = public_project.portfolio_project_id
    JOIN current_craftsman_specializations specialization
      ON specialization.id = ANY(project.specialization_ids)
      AND specialization.craftsman_profile_id = public_project.craftsman_profile_id
      AND specialization.state = 'ACTIVE'
    JOIN taxonomy_specializations taxonomy
      ON taxonomy.release_id = specialization.taxonomy_release_id
      AND taxonomy.specialization_code = specialization.specialization_code
    WHERE public_project.craftsman_profile_id = ${profileId}
    ORDER BY public_project.portfolio_project_id,
      array_position(project.specialization_ids, specialization.id), specialization.id
  `;

  const candidate: PublicCraftsmanProfileCandidate = {
    profileId,
    identity: publicIdentity(profile),
    professions: professions.map((profession) => ({
      code: profession.code,
      label: profession.label,
      verifiedJobCount: profession.verifiedJobCount,
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
      verifiedWorkCount: profile.verifiedWorkCount,
    },
    portfolio: portfolioProjects.map((project) => ({
      projectId: project.projectId,
      title: project.title,
      shortDescription: project.shortDescription,
      provenance: { kind: "SELF_DECLARED", evidenceStatus: "UNVERIFIED" },
      contribution: project.contribution,
      materialsAndTechnologies: project.materialsAndTechnologies,
      problem: project.problem,
      solution: project.solution,
      duration:
        project.durationValue === null || project.durationUnit === null
          ? null
          : { value: project.durationValue, unit: project.durationUnit },
      indicativePrice:
        project.indicativePriceMinCents === null ||
        project.indicativePriceMaxCents === null
          ? null
          : {
              currency: "EUR",
              minCents: safeInteger(project.indicativePriceMinCents),
              maxCents: safeInteger(project.indicativePriceMaxCents),
            },
      approximateLocation:
        project.municipalityCode === null || project.districtCode === null
          ? null
          : {
              municipalityCode: project.municipalityCode,
              districtCode: project.districtCode,
            },
      professions: portfolioProfessions
        .filter(({ projectId }) => projectId === project.projectId)
        .map(({ code, label }) => ({ code, label })),
      skills: portfolioSkills
        .filter(({ projectId }) => projectId === project.projectId)
        .map(({ canonicalCode, label }) => ({ canonicalCode, label })),
      specializations: portfolioSpecializations
        .filter(({ projectId }) => projectId === project.projectId)
        .map(({ code, label }) => ({ code, label })),
      photos: portfolioPhotos
        .filter(({ projectId }) => projectId === project.projectId)
        .map((photo) => ({
          mediaAssetId: photo.mediaAssetId,
          phase: photo.phase,
          displayOrder: photo.displayOrder,
          width: photo.canonicalWidth,
          height: photo.canonicalHeight,
        })),
    })),
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

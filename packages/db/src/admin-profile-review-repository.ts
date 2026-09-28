import type { Sql } from "postgres";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const readinessRequirements = new Set([
  "VALID_IDENTITY",
  "ABOUT",
  "ACTIVE_PROFESSION_WITH_DECLARED_LEVEL",
  "BASE_MUNICIPALITY",
  "NORMAL_RADIUS",
]);

export interface AdminProfileReviewProfession {
  readonly code: string;
  readonly declaredLevel: "BEGINNER" | "ADVANCED" | "MASTER";
  readonly label: string;
}

export interface AdminProfileReviewItem {
  readonly about: string | null;
  readonly baseMunicipality: Readonly<{
    readonly code: string;
    readonly name: string;
  }> | null;
  readonly identity: Readonly<{
    readonly primaryName: string | null;
    readonly profileType: "INDIVIDUAL" | "COMPANY";
    readonly secondaryName: string | null;
  }>;
  readonly normalRadiusMeters: number | null;
  readonly professions: readonly AdminProfileReviewProfession[];
  readonly profileId: string;
  readonly publicationRevision: number;
  readonly readiness: Readonly<{
    readonly isReady: boolean;
    readonly missing: readonly string[];
  }>;
  readonly submittedAt: Date;
}

export interface AdminProfileReviewPage {
  readonly items: readonly AdminProfileReviewItem[];
  readonly nextCursor: string | null;
}

export interface AdminProfileReviewRepository {
  findPending(profileId: string): Promise<AdminProfileReviewItem | null>;
  listPending(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<AdminProfileReviewPage>;
}

interface ReviewRow {
  readonly about: string | null;
  readonly baseMunicipalityCode: string | null;
  readonly baseMunicipalityName: string | null;
  readonly missingRequirements: string[];
  readonly normalRadiusMeters: number | string | null;
  readonly primaryName: string | null;
  readonly professions: unknown;
  readonly profileId: string;
  readonly profileType: "INDIVIDUAL" | "COMPANY";
  readonly publicationRevision: number;
  readonly secondaryName: string | null;
  readonly submittedAt: Date;
}

export function createAdminProfileReviewRepository(
  sql: Sql,
): AdminProfileReviewRepository {
  return Object.freeze({
    async findPending(profileId: string) {
      if (!uuid.test(profileId)) return null;
      const rows = await selectPending(sql, { limit: 1, profileId });
      return rows[0] === undefined ? null : toItem(rows[0]);
    },
    async listPending(input: {
      readonly cursor?: string;
      readonly limit: number;
    }) {
      assertListInput(input);
      const rows = await selectPending(sql, {
        cursor: input.cursor ?? null,
        limit: input.limit + 1,
      });
      const pageRows = rows.slice(0, input.limit);
      return Object.freeze({
        items: Object.freeze(pageRows.map(toItem)),
        nextCursor:
          rows.length > input.limit
            ? (pageRows.at(-1)?.profileId ?? null)
            : null,
      });
    },
  });
}

async function selectPending(
  sql: Sql,
  input:
    | { readonly limit: number; readonly profileId: string }
    | { readonly cursor: string | null; readonly limit: number },
): Promise<ReviewRow[]> {
  const exactProfileId = "profileId" in input ? input.profileId : null;
  const cursor = "cursor" in input ? input.cursor : null;
  return sql<ReviewRow[]>`
    SELECT
      profile.id AS "profileId",
      profile.profile_type AS "profileType",
      CASE
        WHEN profile.profile_type = 'COMPANY'
          THEN profile.official_company_name
        ELSE COALESCE(
          profile.nickname,
          concat_ws(' ', profile.real_first_name, profile.real_last_name)
        )
      END AS "primaryName",
      CASE
        WHEN profile.profile_type = 'INDIVIDUAL'
          AND profile.nickname IS NOT NULL
          THEN concat_ws(' ', profile.real_first_name, profile.real_last_name)
        ELSE NULL
      END AS "secondaryName",
      profile.about,
      municipality.code AS "baseMunicipalityCode",
      municipality.name_sk AS "baseMunicipalityName",
      service_area.normal_radius_meters AS "normalRadiusMeters",
      publication.revision AS "publicationRevision",
      publication.missing_requirements AS "missingRequirements",
      publication.changed_at AS "submittedAt",
      COALESCE(professions.items, '[]'::jsonb) AS professions
    FROM current_craftsman_profile_publications publication
    JOIN craftsman_profiles profile
      ON profile.id = publication.craftsman_profile_id
    JOIN users owner
      ON owner.id = profile.owner_user_id
      AND owner.account_state = 'ACTIVE'
    LEFT JOIN current_craftsman_service_areas service_area
      ON service_area.craftsman_profile_id = profile.id
    LEFT JOIN location_municipalities municipality
      ON municipality.code = service_area.base_municipality_code
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'code', profession.profession_code,
          'declaredLevel', profession.declared_level,
          'label', taxonomy.label_sk
        ) ORDER BY taxonomy.label_sk, profession.profession_code
      ) AS items
      FROM current_craftsman_professions profession
      JOIN taxonomy_professions taxonomy
        ON taxonomy.release_id = profession.taxonomy_release_id
        AND taxonomy.profession_code = profession.profession_code
      WHERE profession.craftsman_profile_id = profile.id
        AND profession.state = 'ACTIVE'
    ) professions ON true
    WHERE publication.review_state = 'PENDING'
      AND (${exactProfileId}::uuid IS NULL OR profile.id = ${exactProfileId})
      AND (${cursor}::uuid IS NULL OR profile.id > ${cursor})
    ORDER BY profile.id
    LIMIT ${input.limit}
  `;
}

function assertListInput(input: {
  readonly cursor?: string;
  readonly limit: number;
}): void {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50)
    throw new TypeError("Profile-review limit must be between 1 and 50.");
  if (input.cursor !== undefined && !uuid.test(input.cursor))
    throw new TypeError("Profile-review cursor is invalid.");
}

function toItem(row: ReviewRow): AdminProfileReviewItem {
  const professions = parseProfessions(row.professions);
  const normalRadiusMeters =
    row.normalRadiusMeters === null ? null : Number(row.normalRadiusMeters);
  if (
    !uuid.test(row.profileId) ||
    (row.profileType !== "INDIVIDUAL" && row.profileType !== "COMPANY") ||
    (row.primaryName !== null && row.primaryName.length === 0) ||
    (row.secondaryName !== null && row.secondaryName.length === 0) ||
    (row.about !== null && row.about.length === 0) ||
    (row.baseMunicipalityCode === null) !==
      (row.baseMunicipalityName === null) ||
    (normalRadiusMeters !== null &&
      (!Number.isSafeInteger(normalRadiusMeters) || normalRadiusMeters <= 0)) ||
    !Number.isSafeInteger(row.publicationRevision) ||
    row.publicationRevision < 1 ||
    !(row.submittedAt instanceof Date) ||
    !Number.isFinite(row.submittedAt.valueOf()) ||
    !Array.isArray(row.missingRequirements) ||
    !row.missingRequirements.every(
      (item) => typeof item === "string" && readinessRequirements.has(item),
    )
  ) {
    throw new Error("Invalid administrative profile-review projection.");
  }
  return Object.freeze({
    about: row.about,
    baseMunicipality:
      row.baseMunicipalityCode === null || row.baseMunicipalityName === null
        ? null
        : Object.freeze({
            code: row.baseMunicipalityCode,
            name: row.baseMunicipalityName,
          }),
    identity: Object.freeze({
      primaryName: row.primaryName,
      profileType: row.profileType,
      secondaryName: row.secondaryName,
    }),
    normalRadiusMeters,
    professions,
    profileId: row.profileId,
    publicationRevision: row.publicationRevision,
    readiness: Object.freeze({
      isReady: row.missingRequirements.length === 0,
      missing: Object.freeze([...row.missingRequirements]),
    }),
    submittedAt: new Date(row.submittedAt),
  });
}

function parseProfessions(
  value: unknown,
): readonly AdminProfileReviewProfession[] {
  if (!Array.isArray(value))
    throw new Error("Invalid administrative profession projection.");
  return Object.freeze(
    value.map((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof (item as Record<string, unknown>)["code"] !== "string" ||
        typeof (item as Record<string, unknown>)["label"] !== "string" ||
        !["BEGINNER", "ADVANCED", "MASTER"].includes(
          String((item as Record<string, unknown>)["declaredLevel"]),
        )
      ) {
        throw new Error("Invalid administrative profession projection.");
      }
      const record = item as Record<string, unknown>;
      return Object.freeze({
        code: record["code"] as string,
        declaredLevel: record["declaredLevel"] as
          "BEGINNER" | "ADVANCED" | "MASTER",
        label: record["label"] as string,
      });
    }),
  );
}

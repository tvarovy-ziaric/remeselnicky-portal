import type {
  CurrentProfessionTaxonomyEntry,
  PreparedProfessionTaxonomyRelease,
  ProfessionTaxonomyPersistence,
  TaxonomyActivationInput,
} from "@portal/taxonomy";
import type { Sql, TransactionSql } from "postgres";

interface InstalledReleaseRow {
  readonly checksumSha256: string;
  readonly contentClass: string;
  readonly releaseId: string;
  readonly reviewReference: string | null;
  readonly reviewState: string;
  readonly supersedesReleaseId: string | null;
  readonly version: number;
}

export function createProfessionTaxonomyRepository(
  sql: Sql,
): ProfessionTaxonomyPersistence {
  return Object.freeze({
    async activateRelease(input: TaxonomyActivationInput): Promise<boolean> {
      const rows = await sql<{ readonly activationId: string }[]>`
        INSERT INTO profession_taxonomy_activation_events (
          activation_id,
          release_id,
          previous_release_id,
          actor_reference,
          review_reference
        ) VALUES (
          ${input.activationId},
          ${input.releaseId},
          ${input.previousReleaseId},
          ${input.actorReference},
          ${input.reviewReference}
        )
        ON CONFLICT (activation_id) DO NOTHING
        RETURNING activation_id AS "activationId"
      `;
      return rows.length === 1;
    },

    async installRelease(
      release: PreparedProfessionTaxonomyRelease,
    ): Promise<"CREATED" | "UNCHANGED"> {
      return sql.begin(async (transaction) => {
        const created = await transaction<{ readonly releaseId: string }[]>`
          INSERT INTO profession_taxonomy_releases (
            release_id,
            version,
            content_class,
            review_state,
            review_reference,
            supersedes_release_id,
            checksum_sha256
          ) VALUES (
            ${release.releaseId},
            ${release.version},
            ${release.contentClass},
            ${release.reviewState},
            ${release.reviewReference},
            ${release.supersedesReleaseId},
            ${release.checksumSha256}
          )
          ON CONFLICT DO NOTHING
          RETURNING release_id AS "releaseId"
        `;
        if (created.length === 1) {
          await insertReleaseContent(transaction, release);
        }
        const stored = await transaction<InstalledReleaseRow[]>`
          SELECT
            release_id AS "releaseId",
            version,
            content_class AS "contentClass",
            review_state AS "reviewState",
            review_reference AS "reviewReference",
            supersedes_release_id AS "supersedesReleaseId",
            checksum_sha256 AS "checksumSha256"
          FROM profession_taxonomy_releases
          WHERE version = ${release.version}
        `;
        assertInstalledRelease(release, stored);
        return created.length === 1 ? "CREATED" : "UNCHANGED";
      });
    },

    async listCurrentProfessions(): Promise<
      readonly CurrentProfessionTaxonomyEntry[]
    > {
      const rows = await sql<CurrentProfessionTaxonomyEntry[]>`
        SELECT
          profession_code AS code,
          label_sk AS "labelSk",
          release_version AS "releaseVersion",
          replaced_by_code AS "replacedByCode",
          slug,
          state
        FROM current_profession_taxonomy
        ORDER BY slug, profession_code
      `;
      return Object.freeze(rows.map((row) => Object.freeze(row)));
    },
  });
}

async function insertReleaseContent(
  transaction: TransactionSql,
  release: PreparedProfessionTaxonomyRelease,
): Promise<void> {
  for (const profession of release.professions) {
    await transaction`
      INSERT INTO taxonomy_professions (
        release_id, profession_code, slug, label_sk, state, replaced_by_code
      ) VALUES (
        ${release.releaseId}, ${profession.code}, ${profession.slug},
        ${profession.labelSk}, ${profession.state}, ${profession.replacedByCode}
      )
    `;
  }
  for (const specialization of release.specializations) {
    await transaction`
      INSERT INTO taxonomy_specializations (
        release_id, specialization_code, profession_code, slug,
        label_sk, state, replaced_by_code
      ) VALUES (
        ${release.releaseId}, ${specialization.code},
        ${specialization.professionCode}, ${specialization.slug},
        ${specialization.labelSk}, ${specialization.state},
        ${specialization.replacedByCode}
      )
    `;
  }
  for (const criterion of release.capabilityCriteria) {
    await transaction`
      INSERT INTO taxonomy_capability_criteria (
        release_id, criterion_code, profession_code, level,
        label_sk, description_sk, state
      ) VALUES (
        ${release.releaseId}, ${criterion.code}, ${criterion.professionCode},
        ${criterion.level}, ${criterion.labelSk}, ${criterion.descriptionSk},
        ${criterion.state}
      )
    `;
  }
  for (const alias of release.aliases) {
    await transaction`
      INSERT INTO taxonomy_aliases (
        release_id, alias, alias_kind, target_kind, target_code
      ) VALUES (
        ${release.releaseId}, ${alias.alias}, ${alias.kind},
        ${alias.targetKind}, ${alias.targetCode}
      )
    `;
  }
}

function assertInstalledRelease(
  release: PreparedProfessionTaxonomyRelease,
  rows: readonly InstalledReleaseRow[],
): void {
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row === undefined ||
    row.releaseId !== release.releaseId ||
    row.version !== release.version ||
    row.contentClass !== release.contentClass ||
    row.reviewState !== release.reviewState ||
    row.reviewReference !== release.reviewReference ||
    row.supersedesReleaseId !== release.supersedesReleaseId ||
    row.checksumSha256 !== release.checksumSha256
  ) {
    throw new Error(
      "Existing taxonomy version conflicts with the governed release seed.",
    );
  }
}

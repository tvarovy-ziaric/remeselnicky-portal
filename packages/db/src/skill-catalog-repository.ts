import { createHash } from "node:crypto";

import { isCraftsmanCapabilityPublicTextSafe } from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

export interface SkillCatalogSkillSeed {
  readonly code: string;
  readonly labelSk: string;
  readonly professionCodes: readonly string[];
  readonly replacedByCode: string | null;
  readonly slug: string;
  readonly state: "ACTIVE" | "DEPRECATED";
}

export interface SkillCatalogReleaseSeed {
  readonly contentClass: "PLACEHOLDER" | "CANONICAL";
  readonly professionTaxonomyReleaseId: string;
  readonly releaseId: string;
  readonly reviewReference: string | null;
  readonly reviewState: "HUMAN_REVIEW_PENDING" | "HUMAN_REVIEW_APPROVED";
  readonly skills: readonly SkillCatalogSkillSeed[];
  readonly supersedesReleaseId: string | null;
  readonly version: number;
}

export interface PreparedSkillCatalogRelease extends SkillCatalogReleaseSeed {
  readonly checksumSha256: string;
}

export interface SkillCatalogRepository {
  activate(input: {
    readonly activationId: string;
    readonly actorReference: string;
    readonly previousReleaseId: string | null;
    readonly releaseId: string;
    readonly reviewReference: string;
  }): Promise<boolean>;
  install(
    release: PreparedSkillCatalogRelease,
  ): Promise<"CREATED" | "UNCHANGED">;
}

type SkillCatalogActivationInput = Parameters<
  SkillCatalogRepository["activate"]
>[0];

export class SkillCatalogIdempotencyError extends Error {
  readonly code = "SKILL_CATALOG_IDEMPOTENCY_CONFLICT";
}

export function prepareSkillCatalogRelease(
  input: SkillCatalogReleaseSeed,
): PreparedSkillCatalogRelease {
  assertUuid(input.releaseId, "releaseId");
  assertUuid(input.professionTaxonomyReleaseId, "professionTaxonomyReleaseId");
  if (
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    (input.version === 1) !== (input.supersedesReleaseId === null)
  ) {
    throw new TypeError("Skill catalog release chain is invalid.");
  }
  if (input.supersedesReleaseId !== null) {
    assertUuid(input.supersedesReleaseId, "supersedesReleaseId");
  }
  const approved = input.reviewState === "HUMAN_REVIEW_APPROVED";
  if (
    (input.contentClass === "CANONICAL") !== approved ||
    (approved
      ? input.reviewReference === null ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,199}$/u.test(input.reviewReference)
      : input.reviewReference !== null)
  ) {
    throw new TypeError("Skill catalog governance is invalid.");
  }
  if (input.skills.length > 1_000) {
    throw new TypeError("Skill catalog is unbounded.");
  }
  const codes = new Set<string>();
  const slugs = new Set<string>();
  const skills = input.skills.map((skill) => {
    if (!/^(?:SKILL|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(skill.code)) {
      throw new TypeError("Skill catalog code is invalid.");
    }
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skill.slug) ||
      skill.slug.length > 100 ||
      skill.labelSk !== skill.labelSk.trim() ||
      skill.labelSk.length < 2 ||
      skill.labelSk.length > 120 ||
      !isCraftsmanCapabilityPublicTextSafe(skill.labelSk)
    ) {
      throw new TypeError("Skill catalog presentation is invalid.");
    }
    if (codes.has(skill.code) || slugs.has(skill.slug)) {
      throw new TypeError("Duplicate skill catalog identity.");
    }
    codes.add(skill.code);
    slugs.add(skill.slug);
    const professionCodes = [...new Set(skill.professionCodes)].sort();
    if (
      professionCodes.length < 1 ||
      professionCodes.some(
        (code) => !/^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(code),
      )
    ) {
      throw new TypeError("Catalog skill requires governed professions.");
    }
    if (
      (skill.state === "ACTIVE") !== (skill.replacedByCode === null) ||
      (skill.replacedByCode !== null && skill.replacedByCode === skill.code)
    ) {
      throw new TypeError("Catalog skill replacement is invalid.");
    }
    return Object.freeze({ ...skill, professionCodes });
  });
  const sorted = Object.freeze(
    skills.sort((left, right) => left.code.localeCompare(right.code)),
  );
  for (const skill of sorted) {
    if (skill.replacedByCode !== null && !codes.has(skill.replacedByCode)) {
      throw new TypeError("Catalog skill replacement target is missing.");
    }
  }
  const release = Object.freeze({ ...input, skills: sorted });
  const checksumSha256 = createHash("sha256")
    .update(JSON.stringify(release), "utf8")
    .digest("hex");
  return Object.freeze({ ...release, checksumSha256 });
}

export function createSkillCatalogRepository(sql: Sql): SkillCatalogRepository {
  return Object.freeze({
    async activate(input: SkillCatalogActivationInput) {
      const rows = await sql<{ readonly activationId: string }[]>`
        INSERT INTO skill_catalog_activation_events (
          activation_id, release_id, previous_release_id,
          actor_reference, review_reference
        ) VALUES (
          ${input.activationId}, ${input.releaseId}, ${input.previousReleaseId},
          ${input.actorReference}, ${input.reviewReference}
        )
        ON CONFLICT (activation_id) DO NOTHING
        RETURNING activation_id AS "activationId"
      `;
      if (rows.length === 1) return true;
      const [stored] = await sql<
        {
          readonly actorReference: string;
          readonly previousReleaseId: string | null;
          readonly releaseId: string;
          readonly reviewReference: string;
        }[]
      >`
        SELECT release_id AS "releaseId",
          previous_release_id AS "previousReleaseId",
          actor_reference AS "actorReference",
          review_reference AS "reviewReference"
        FROM skill_catalog_activation_events
        WHERE activation_id = ${input.activationId}
      `;
      if (
        stored === undefined ||
        stored.releaseId !== input.releaseId ||
        stored.previousReleaseId !== input.previousReleaseId ||
        stored.actorReference !== input.actorReference ||
        stored.reviewReference !== input.reviewReference
      ) {
        throw new SkillCatalogIdempotencyError(
          "Skill catalog activation id was reused with different intent.",
        );
      }
      return false;
    },
    async install(release: PreparedSkillCatalogRelease) {
      const { checksumSha256: suppliedChecksum, ...seed } = release;
      const verified = prepareSkillCatalogRelease(seed);
      if (verified.checksumSha256 !== suppliedChecksum) {
        throw new TypeError(
          "Skill catalog checksum does not match its content.",
        );
      }
      return sql.begin(async (transaction) => {
        const created = await transaction<{ readonly releaseId: string }[]>`
          INSERT INTO skill_catalog_releases (
            release_id, version, profession_taxonomy_release_id,
            content_class, review_state, review_reference,
            supersedes_release_id, checksum_sha256
          ) VALUES (
            ${release.releaseId}, ${release.version},
            ${release.professionTaxonomyReleaseId}, ${release.contentClass},
            ${release.reviewState}, ${release.reviewReference},
            ${release.supersedesReleaseId}, ${release.checksumSha256}
          )
          ON CONFLICT DO NOTHING
          RETURNING release_id AS "releaseId"
        `;
        if (created.length === 1) await insertCatalog(transaction, release);
        const [stored] = await transaction<
          {
            readonly checksumSha256: string;
            readonly contentClass: string;
            readonly professionTaxonomyReleaseId: string;
            readonly releaseId: string;
            readonly reviewReference: string | null;
            readonly reviewState: string;
            readonly supersedesReleaseId: string | null;
            readonly version: number;
          }[]
        >`
          SELECT release_id AS "releaseId", version,
            profession_taxonomy_release_id AS "professionTaxonomyReleaseId",
            content_class AS "contentClass", review_state AS "reviewState",
            review_reference AS "reviewReference",
            supersedes_release_id AS "supersedesReleaseId",
            checksum_sha256 AS "checksumSha256"
          FROM skill_catalog_releases WHERE version = ${release.version}
        `;
        if (
          stored === undefined ||
          stored.releaseId !== release.releaseId ||
          stored.professionTaxonomyReleaseId !==
            release.professionTaxonomyReleaseId ||
          stored.contentClass !== release.contentClass ||
          stored.reviewState !== release.reviewState ||
          stored.reviewReference !== release.reviewReference ||
          stored.supersedesReleaseId !== release.supersedesReleaseId ||
          stored.checksumSha256 !== release.checksumSha256
        ) {
          throw new Error(
            "Existing skill catalog version conflicts with the governed release.",
          );
        }
        return created.length === 1 ? "CREATED" : "UNCHANGED";
      });
    },
  });
}

async function insertCatalog(
  transaction: TransactionSql,
  release: PreparedSkillCatalogRelease,
): Promise<void> {
  for (const skill of release.skills) {
    await transaction`
      INSERT INTO skill_catalog_skills (
        release_id, skill_code, slug, label_sk, state, replaced_by_code
      ) VALUES (
        ${release.releaseId}, ${skill.code}, ${skill.slug}, ${skill.labelSk},
        ${skill.state}, ${skill.replacedByCode}
      )
    `;
    for (const professionCode of skill.professionCodes) {
      await transaction`
        INSERT INTO skill_catalog_skill_professions (
          release_id, skill_code, profession_taxonomy_release_id, profession_code
        ) VALUES (
          ${release.releaseId}, ${skill.code},
          ${release.professionTaxonomyReleaseId}, ${professionCode}
        )
      `;
    }
  }
}

function assertUuid(value: string, field: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new TypeError(`Invalid skill catalog ${field}.`);
  }
}

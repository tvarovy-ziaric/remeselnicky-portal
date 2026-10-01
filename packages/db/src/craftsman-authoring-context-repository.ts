import type { CraftsmanProfileId, UserId } from "@portal/domain";
import type { Sql } from "postgres";

export interface CurrentGovernedProfession {
  readonly professionCode: string;
  readonly taxonomyReleaseId: string;
}
export interface CurrentGovernedService {
  readonly professionCodes: readonly string[];
  readonly serviceCode: string;
  readonly taxonomyReleaseId: string;
}

export interface CraftsmanAuthoringContextRepository {
  findOwnedProfileId(actorUserId: UserId): Promise<CraftsmanProfileId | null>;
  resolveCurrentProfession(
    professionCode: string,
  ): Promise<CurrentGovernedProfession | null>;
  resolveCurrentService(
    serviceCode: string,
  ): Promise<CurrentGovernedService | null>;
}

/**
 * Small read-only seam needed by the authenticated authoring transport. It
 * neither changes taxonomy governance nor duplicates any profile command.
 */
export function createCraftsmanAuthoringContextRepository(
  sql: Sql,
): CraftsmanAuthoringContextRepository {
  return Object.freeze({
    async findOwnedProfileId(
      actorUserId: UserId,
    ): Promise<CraftsmanProfileId | null> {
      assertUuid(actorUserId, "actorUserId");
      const [row] = await sql<{ readonly id: CraftsmanProfileId }[]>`
        SELECT profile.id
        FROM craftsman_profiles profile
        JOIN users owner ON owner.id = profile.owner_user_id
        WHERE profile.owner_user_id = ${actorUserId}
          AND owner.account_state = 'ACTIVE'
        LIMIT 1
      `;
      return row?.id ?? null;
    },

    async resolveCurrentProfession(
      professionCode: string,
    ): Promise<CurrentGovernedProfession | null> {
      assertProfessionCode(professionCode);
      const [row] = await sql<CurrentGovernedProfession[]>`
        SELECT
          profession.profession_code AS "professionCode",
          release.release_id AS "taxonomyReleaseId"
        FROM profession_taxonomy_activation_events activation
        JOIN profession_taxonomy_releases release
          ON release.release_id = activation.release_id
          AND release.content_class = 'CANONICAL'
          AND release.review_state = 'HUMAN_REVIEW_APPROVED'
        JOIN taxonomy_professions profession
          ON profession.release_id = release.release_id
          AND profession.profession_code = ${professionCode}
          AND profession.state = 'ACTIVE'
        WHERE activation.activation_sequence = (
          SELECT max(latest.activation_sequence)
          FROM profession_taxonomy_activation_events latest
        )
        LIMIT 1
      `;
      return row === undefined ? null : Object.freeze({ ...row });
    },

    async resolveCurrentService(
      serviceCode: string,
    ): Promise<CurrentGovernedService | null> {
      if (!/^SERV:[A-Z0-9][A-Z0-9_]{1,62}$/u.test(serviceCode)) {
        throw new TypeError(
          "Invalid craftsman authoring context: serviceCode.",
        );
      }
      const [row] = await sql<CurrentGovernedService[]>`
        SELECT service.service_code AS "serviceCode",
          service.release_id AS "taxonomyReleaseId",
          array_agg(relation.profession_code ORDER BY relation.profession_code)
            AS "professionCodes"
        FROM current_service_taxonomy service
        JOIN taxonomy_service_professions relation
          ON relation.release_id = service.release_id
         AND relation.service_code = service.service_code
        WHERE service.service_code = ${serviceCode} AND service.state = 'ACTIVE'
        GROUP BY service.service_code, service.release_id
      `;
      return row === undefined
        ? null
        : Object.freeze({
            ...row,
            professionCodes: Object.freeze([...row.professionCodes]),
          });
    },
  });
}

function assertUuid(value: string, field: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new TypeError(`Invalid craftsman authoring context: ${field}.`);
  }
}

function assertProfessionCode(value: string): void {
  if (!/^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)) {
    throw new TypeError("Invalid craftsman authoring context: professionCode.");
  }
}

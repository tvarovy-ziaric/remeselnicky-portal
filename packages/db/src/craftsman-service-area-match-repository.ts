import {
  assertCraftsmanServiceAreaMatchQuery,
  createCraftsmanServiceAreaMatch,
  type CraftsmanServiceAreaMatchPersistence,
  type CraftsmanServiceAreaMatchQuery,
  type CraftsmanServiceAreaMatchResult,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface LocationAvailabilityRow {
  readonly available: boolean;
}

interface MatchRow {
  readonly approximateDistanceKm: number | null;
  readonly craftsmanProfileId: string;
  readonly matchKind: string;
  readonly rankingDistanceMeters: number | null;
}

export function createCraftsmanServiceAreaMatchRepository(
  sql: Sql,
): CraftsmanServiceAreaMatchPersistence {
  return Object.freeze({
    async findMatches(input: CraftsmanServiceAreaMatchQuery) {
      assertCraftsmanServiceAreaMatchQuery(input);
      return sql.begin(
        "isolation level repeatable read read only",
        async (transaction) => findInSnapshot(transaction, input),
      );
    },
  });
}

async function findInSnapshot(
  sql: TransactionSql,
  input: CraftsmanServiceAreaMatchQuery,
): Promise<CraftsmanServiceAreaMatchResult> {
  if (input.municipalityCode !== null) {
    const [location] = await sql<LocationAvailabilityRow[]>`
      SELECT EXISTS (
        SELECT 1
        FROM location_municipalities municipality
        JOIN location_districts district
          ON district.code = municipality.district_code
        JOIN location_regions region
          ON region.code = district.region_code
        WHERE municipality.code = ${input.municipalityCode}
          AND municipality.is_active
          AND district.is_active
          AND region.is_active
      ) AS available
    `;
    if (location?.available !== true) {
      return Object.freeze({ status: "LOCATION_UNAVAILABLE" as const });
    }
  }

  const rows = await sql<MatchRow[]>`
    SELECT
      match.craftsman_profile_id AS "craftsmanProfileId",
      match.match_kind AS "matchKind",
      match.ranking_distance_meters AS "rankingDistanceMeters",
      match.approximate_distance_km AS "approximateDistanceKm"
    FROM craftsman_service_area_match_facts(
      ${input.municipalityCode},
      ${input.includeOutsideDeclaredArea}
    ) match
    ORDER BY
      CASE match.match_kind
        WHEN 'ADDITIONAL_SERVICE_AREA' THEN 0
        WHEN 'WITHIN_NORMAL_RADIUS' THEN 0
        WHEN 'WITHIN_MAXIMUM_RADIUS' THEN 1
        WHEN 'OUTSIDE_DECLARED_AREA' THEN 2
        WHEN 'DISTANCE_UNAVAILABLE' THEN 0
      END,
      match.ranking_distance_meters ASC NULLS LAST,
      match.craftsman_profile_id ASC
    LIMIT ${input.limit}
  `;
  return Object.freeze({
    matches: Object.freeze(rows.map(createCraftsmanServiceAreaMatch)),
    status: "OK" as const,
  });
}

import {
  assertCraftsmanDistanceQueryInput,
  createCraftsmanDistanceFact,
  type CraftsmanDistancePersistence,
  type CraftsmanDistanceQueryInput,
  type CraftsmanDistanceQueryResult,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface LocationAvailabilityRow {
  readonly available: boolean;
}

interface DistanceRow {
  readonly approximateDistanceKm: number | null;
  readonly craftsmanProfileId: string;
  readonly rankingDistanceMeters: number | null;
}

export function createCraftsmanDistanceRepository(
  sql: Sql,
): CraftsmanDistancePersistence {
  return Object.freeze({
    async findPublicDistanceFacts(input: CraftsmanDistanceQueryInput) {
      assertCraftsmanDistanceQueryInput(input);
      return sql.begin(
        "isolation level repeatable read read only",
        async (transaction) => findInSnapshot(transaction, input),
      );
    },
  });
}

async function findInSnapshot(
  sql: TransactionSql,
  input: CraftsmanDistanceQueryInput,
): Promise<CraftsmanDistanceQueryResult> {
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

  const rows = await sql<DistanceRow[]>`
    SELECT
      distance.craftsman_profile_id AS "craftsmanProfileId",
      distance.ranking_distance_meters AS "rankingDistanceMeters",
      distance.approximate_distance_km AS "approximateDistanceKm"
    FROM public_craftsman_distance_facts(${input.municipalityCode}) distance
    ORDER BY distance.ranking_distance_meters ASC NULLS LAST,
      distance.craftsman_profile_id ASC
    LIMIT ${input.limit}
  `;
  return Object.freeze({
    facts: Object.freeze(rows.map(createCraftsmanDistanceFact)),
    status: "OK" as const,
  });
}

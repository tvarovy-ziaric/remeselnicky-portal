import {
  assertCraftsmanAvailabilityMatchQuery,
  createCraftsmanAvailabilityMatch,
  type CraftsmanAvailabilityMatch,
  type CraftsmanAvailabilityMatchPersistence,
  type CraftsmanAvailabilityMatchQuery,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface MatchRow {
  readonly craftsmanProfileId: string;
  readonly indicativelyAvailable: boolean;
  readonly matchKind: string;
}

export function createCraftsmanAvailabilityMatchRepository(
  sql: Sql,
): CraftsmanAvailabilityMatchPersistence {
  return Object.freeze({
    async findMatches(input: CraftsmanAvailabilityMatchQuery) {
      assertCraftsmanAvailabilityMatchQuery(input);
      return sql.begin(
        "isolation level repeatable read read only",
        async (transaction) => findInSnapshot(transaction, input),
      );
    },
  });
}

async function findInSnapshot(
  sql: TransactionSql,
  input: CraftsmanAvailabilityMatchQuery,
): Promise<readonly CraftsmanAvailabilityMatch[]> {
  const rows = await sql<MatchRow[]>`
    SELECT
      availability.craftsman_profile_id AS "craftsmanProfileId",
      availability.match_kind AS "matchKind",
      availability.indicatively_available AS "indicativelyAvailable"
    FROM craftsman_availability_match_facts(
      ${input.startsAt},
      ${input.endsAt},
      ${input.filterIndicativelyAvailable}
    ) availability
    ORDER BY
      CASE availability.match_kind
        WHEN 'AVAILABLE_OVERLAP' THEN 0
        ELSE 1
      END,
      availability.craftsman_profile_id ASC
    LIMIT ${input.limit}
  `;
  return Object.freeze(rows.map(createCraftsmanAvailabilityMatch));
}

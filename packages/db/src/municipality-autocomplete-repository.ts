import type { Sql } from "postgres";

export interface MunicipalitySuggestion {
  readonly code: string;
  readonly districtName: string;
  readonly name: string;
  readonly regionName: string;
}

export interface MunicipalityAutocompletePersistence {
  suggest(query: string): Promise<readonly MunicipalitySuggestion[]>;
}

interface MunicipalityRow {
  readonly code: string;
  readonly districtName: string;
  readonly name: string;
  readonly regionName: string;
}

export function createMunicipalityAutocompleteRepository(
  sql: Sql,
): MunicipalityAutocompletePersistence {
  const persistence: MunicipalityAutocompletePersistence = {
    async suggest(query) {
      const normalized = normalizeQuery(query);
      if (normalized === null) return [];
      const rows = await sql<MunicipalityRow[]>`
        WITH candidates AS (
          SELECT
          municipality.code,
          municipality.name_sk AS "name",
          district.name_sk AS "districtName",
          region.name_sk AS "regionName",
          btrim(regexp_replace(
            translate(
              lower(municipality.name_sk),
              'áäčďéíĺľňóôŕšťúýž',
              'aacdeillnoorstuyz'
            ),
            '[^a-z0-9]+', ' ', 'g'
          )) AS normalized_name
          FROM location_municipalities municipality
          JOIN location_districts district
            ON district.code = municipality.district_code
           AND district.is_active
          JOIN location_regions region
            ON region.code = district.region_code
           AND region.is_active
          WHERE municipality.is_active
        )
        SELECT code, "name", "districtName", "regionName"
        FROM candidates
        WHERE normalized_name LIKE ${`${normalized}%`}
        ORDER BY normalized_name, code
        LIMIT 10
      `;
      if (rows.length > 10) throw new Error("Municipality result is invalid.");
      return Object.freeze(rows.map(assertRow));
    },
  };
  return Object.freeze(persistence);
}

function normalizeQuery(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 80 ||
    /[\r\n\p{Cc}]/u.test(value)
  )
    return null;
  const normalized = value
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replaceAll(/\s+/gu, " ");
  return normalized.length >= 2 ? normalized : null;
}

function assertRow(row: MunicipalityRow): MunicipalitySuggestion {
  if (
    !code(row.code) ||
    !safeText(row.name) ||
    !safeText(row.districtName) ||
    !safeText(row.regionName)
  )
    throw new Error("Municipality result is invalid.");
  return Object.freeze({
    code: row.code,
    districtName: row.districtName,
    name: row.name,
    regionName: row.regionName,
  });
}

function code(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Z0-9][A-Z0-9._:-]{0,63}$/u.test(value)
  );
}
function safeText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= 120 &&
    !/[\r\n\p{Cc}]/u.test(value)
  );
}

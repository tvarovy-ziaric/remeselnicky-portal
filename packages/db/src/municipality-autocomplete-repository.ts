import type { Sql } from "postgres";

const MAX_SUGGESTIONS = 10;

export interface MunicipalitySuggestion {
  readonly code: string;
  readonly districtName: string | null;
  readonly kind: "CITY_AREA" | "MUNICIPALITY";
  readonly name: string;
  readonly postalCodes: readonly string[];
  readonly regionName: string;
}

export interface MunicipalityAutocompletePersistence {
  suggest(query: string): Promise<readonly MunicipalitySuggestion[]>;
}

interface MunicipalityRow {
  readonly code: string;
  readonly districtName: string | null;
  readonly kind: "CITY_AREA" | "MUNICIPALITY";
  readonly name: string;
  readonly postalCodes: readonly string[];
  readonly regionName: string;
}

type NormalizedQuery =
  | { readonly kind: "NAME"; readonly value: string }
  | { readonly kind: "POSTAL_CODE"; readonly value: string };

export function createMunicipalityAutocompleteRepository(
  sql: Sql,
): MunicipalityAutocompletePersistence {
  const persistence: MunicipalityAutocompletePersistence = {
    async suggest(query) {
      const normalized = normalizeQuery(query);
      if (normalized === null) return [];
      const rows =
        normalized.kind === "POSTAL_CODE"
          ? await findByPostalCode(sql, normalized.value)
          : await findByName(sql, normalized.value);
      if (rows.length > MAX_SUGGESTIONS)
        throw new Error("Municipality result is invalid.");
      return Object.freeze(rows.map(assertRow));
    },
  };
  return Object.freeze(persistence);
}

async function findByName(
  sql: Sql,
  normalizedName: string,
): Promise<MunicipalityRow[]> {
  return sql<MunicipalityRow[]>`
    WITH candidates AS (
      SELECT
        municipality.code,
        municipality.name_sk AS "name",
        CASE WHEN city_area.municipality_code IS NULL
          THEN district.name_sk ELSE NULL END AS "districtName",
        CASE WHEN city_area.municipality_code IS NULL
          THEN 'MUNICIPALITY' ELSE 'CITY_AREA' END AS kind,
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
      LEFT JOIN location_city_areas city_area
        ON city_area.municipality_code = municipality.code
      JOIN location_districts district
        ON district.code = municipality.district_code
       AND district.is_active
      JOIN location_regions region
        ON region.code = district.region_code
       AND region.is_active
      WHERE municipality.is_active
        AND btrim(regexp_replace(
          translate(
            lower(municipality.name_sk),
            'áäčďéíĺľňóôŕšťúýž',
            'aacdeillnoorstuyz'
          ),
          '[^a-z0-9]+', ' ', 'g'
        )) LIKE ${`${normalizedName}%`}
      ORDER BY normalized_name,
        CASE WHEN city_area.municipality_code IS NULL THEN 1 ELSE 0 END,
        municipality.code
      LIMIT ${MAX_SUGGESTIONS}
    )
    SELECT
      candidates.code,
      candidates."name",
      candidates."districtName",
      candidates.kind,
      candidates."regionName",
      COALESCE(
        array_agg(DISTINCT postal.code ORDER BY postal.code)
          FILTER (WHERE postal.code IS NOT NULL),
        ARRAY[]::text[]
      ) AS "postalCodes"
    FROM candidates
    LEFT JOIN location_municipality_postal_codes municipality_postal
      ON municipality_postal.municipality_code = candidates.code
     AND municipality_postal.is_active
     AND municipality_postal.valid_from <= CURRENT_DATE
     AND (
       municipality_postal.valid_to IS NULL
       OR municipality_postal.valid_to >= CURRENT_DATE
     )
    LEFT JOIN location_postal_codes postal
      ON postal.code = municipality_postal.postal_code
     AND postal.is_active
    GROUP BY
      candidates.code,
      candidates."name",
      candidates."districtName",
      candidates."regionName",
      candidates.kind,
      candidates.normalized_name
    ORDER BY candidates.normalized_name,
      CASE WHEN candidates.kind = 'CITY_AREA' THEN 0 ELSE 1 END,
      candidates.code
  `;
}

async function findByPostalCode(
  sql: Sql,
  postalPrefix: string,
): Promise<MunicipalityRow[]> {
  return sql<MunicipalityRow[]>`
    SELECT
      municipality.code,
      municipality.name_sk AS "name",
      district.name_sk AS "districtName",
      'MUNICIPALITY'::text AS kind,
      region.name_sk AS "regionName",
      array_agg(DISTINCT postal.code ORDER BY postal.code) AS "postalCodes"
    FROM location_postal_codes postal
    JOIN location_municipality_postal_codes municipality_postal
      ON municipality_postal.postal_code = postal.code
     AND municipality_postal.is_active
     AND municipality_postal.valid_from <= CURRENT_DATE
     AND (
       municipality_postal.valid_to IS NULL
       OR municipality_postal.valid_to >= CURRENT_DATE
     )
    JOIN location_municipalities municipality
      ON municipality.code = municipality_postal.municipality_code
     AND municipality.is_active
    JOIN location_districts district
      ON district.code = municipality.district_code
     AND district.is_active
    JOIN location_regions region
      ON region.code = district.region_code
     AND region.is_active
    WHERE postal.is_active
      AND postal.code LIKE ${`${postalPrefix}%`}
    GROUP BY
      municipality.code,
      municipality.name_sk,
      district.name_sk,
      region.name_sk
    ORDER BY
      min(postal.code),
      btrim(regexp_replace(
        translate(
          lower(municipality.name_sk),
          'áäčďéíĺľňóôŕšťúýž',
          'aacdeillnoorstuyz'
        ),
        '[^a-z0-9]+', ' ', 'g'
      )),
      municipality.code
    LIMIT ${MAX_SUGGESTIONS}
  `;
}

function normalizeQuery(value: unknown): NormalizedQuery | null {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 80 ||
    /[\r\n\p{Cc}]/u.test(value)
  )
    return null;
  const trimmed = value.trim();
  if (/^[0-9\s]+$/u.test(trimmed)) {
    const canonicalPostalPrefix = trimmed.replaceAll(/\s/gu, "");
    return /^[0-9]{3,5}$/u.test(canonicalPostalPrefix)
      ? { kind: "POSTAL_CODE", value: canonicalPostalPrefix }
      : null;
  }
  if (/\p{N}/u.test(trimmed)) return null;

  const normalized = trimmed
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replaceAll(/\s+/gu, " ");
  return normalized.length >= 2 ? { kind: "NAME", value: normalized } : null;
}

function assertRow(row: MunicipalityRow): MunicipalitySuggestion {
  if (
    !code(row.code) ||
    !safeText(row.name) ||
    !["CITY_AREA", "MUNICIPALITY"].includes(row.kind) ||
    (row.kind === "CITY_AREA"
      ? row.districtName !== null || row.postalCodes.length !== 0
      : !safeText(row.districtName) || row.postalCodes.length === 0) ||
    !safeText(row.regionName) ||
    !validPostalCodes(row.postalCodes)
  )
    throw new Error("Municipality result is invalid.");
  return Object.freeze({
    code: row.code,
    districtName: row.districtName,
    kind: row.kind,
    name: row.name,
    postalCodes: Object.freeze([...row.postalCodes]),
    regionName: row.regionName,
  });
}

function isSorted(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || values[index - 1]! < value,
  );
}

function validPostalCodes(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  const values: readonly unknown[] = value;
  if (
    values.some(
      (postalCode) =>
        typeof postalCode !== "string" || !/^[0-9]{5}$/u.test(postalCode),
    )
  )
    return false;
  const postalCodes = values as readonly string[];
  return (
    new Set(postalCodes).size === postalCodes.length && isSorted(postalCodes)
  );
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

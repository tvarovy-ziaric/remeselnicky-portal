import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres, { type TransactionSql } from "postgres";

import { deriveGovernedCityAreas } from "./governed-city-areas.js";
import { loadSlovakiaLocationReferenceSnapshot } from "./slovakia-location-reference.js";

const DEFAULT_SNAPSHOT = fileURLToPath(
  new URL(
    "../../../reference-data/slovakia-locations/2026-04/snapshot.json",
    import.meta.url,
  ),
);

async function main(): Promise<void> {
  const snapshotPath = path.resolve(
    process.env["LOCATION_REFERENCE_SNAPSHOT"] ?? DEFAULT_SNAPSHOT,
  );
  const snapshot = await loadSlovakiaLocationReferenceSnapshot(snapshotPath);
  if (process.argv.includes("--validate-only")) {
    process.stdout.write(
      `${JSON.stringify({ checksum: snapshot.contentSha256, counts: snapshot.counts, revision: snapshot.source.revision, validated: true })}\n`,
    );
    return;
  }
  if (process.env["LOCATION_REFERENCE_IMPORT"] !== "1") {
    throw new Error("Location reference import requires explicit opt-in.");
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required for location reference import.");
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const result = await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext('portal-location-reference-import'))`;
      const [existing] = await transaction<{ snapshotSha256: string }[]>`
        SELECT snapshot_sha256 AS "snapshotSha256"
        FROM location_reference_imports
        WHERE source_revision = ${snapshot.source.revision}
      `;
      if (existing !== undefined) {
        if (existing.snapshotSha256 !== snapshot.contentSha256) {
          throw new Error(
            "Existing location reference revision has another checksum.",
          );
        }
        await installGovernedCityAreas(transaction, snapshot);
        return { alreadyApplied: true } as const;
      }

      await transaction`
        INSERT INTO location_reference_imports (
          source_revision, snapshot_sha256, effective_on,
          source_reference, license_reference,
          region_count, district_count, municipality_count,
          postal_code_count, municipality_postal_code_count
        ) VALUES (
          ${snapshot.source.revision}, ${snapshot.contentSha256},
          ${snapshot.source.snapshotDate}, ${snapshot.source.catalogUrl},
          ${snapshot.source.licenseUrl}, ${snapshot.counts.regions},
          ${snapshot.counts.districts}, ${snapshot.counts.municipalities},
          ${snapshot.counts.postalCodes},
          ${snapshot.counts.municipalityPostalCodes}
        )
      `;

      await transaction`
        INSERT INTO location_regions ${transaction(
          snapshot.regions.map(({ code, name }) => ({
            code,
            is_active: true,
            name_sk: name,
            source_reference: snapshot.source.catalogUrl,
            source_revision: snapshot.source.revision,
          })),
        )}
        ON CONFLICT (code) DO NOTHING
      `;
      await transaction`
        INSERT INTO location_districts ${transaction(
          snapshot.districts.map(({ code, name, regionCode }) => ({
            code,
            is_active: true,
            name_sk: name,
            region_code: regionCode,
            source_reference: snapshot.source.catalogUrl,
            source_revision: snapshot.source.revision,
          })),
        )}
        ON CONFLICT (code) DO NOTHING
      `;

      for (const batch of batches(snapshot.municipalities, 500)) {
        await transaction`
          INSERT INTO location_municipalities ${transaction(
            batch.map(({ code, districtCode, latitude, longitude, name }) => ({
              centroid: `SRID=4326;POINT(${longitude.toString()} ${latitude.toString()})`,
              code,
              district_code: districtCode,
              is_active: true,
              name_sk: name,
              source_reference: snapshot.source.catalogUrl,
              source_revision: snapshot.source.revision,
            })),
          )}
          ON CONFLICT (code) DO NOTHING
        `;
      }

      await transaction`
        INSERT INTO location_postal_codes ${transaction(
          snapshot.postalCodes.map((code) => ({
            code,
            is_active: true,
            source_reference: snapshot.source.catalogUrl,
            source_revision: snapshot.source.revision,
          })),
        )}
        ON CONFLICT (code) DO NOTHING
      `;
      for (const batch of batches(snapshot.municipalityPostalCodes, 1_000)) {
        await transaction`
          INSERT INTO location_municipality_postal_codes ${transaction(
            batch.map(({ isPrimary, municipalityCode, postalCode }) => ({
              is_active: true,
              is_primary: isPrimary,
              municipality_code: municipalityCode,
              postal_code: postalCode,
              source_reference: snapshot.source.catalogUrl,
              source_revision: snapshot.source.revision,
              valid_from: snapshot.source.snapshotDate,
              valid_to: null,
            })),
          )}
          ON CONFLICT (municipality_code, postal_code, valid_from) DO NOTHING
        `;
      }

      const [stored] = await transaction<
        {
          districts: number;
          links: number;
          municipalities: number;
          postalCodes: number;
          regions: number;
        }[]
      >`
        SELECT
          (SELECT count(*)::integer FROM location_regions
            WHERE source_revision = ${snapshot.source.revision}) AS regions,
          (SELECT count(*)::integer FROM location_districts
            WHERE source_revision = ${snapshot.source.revision}) AS districts,
          (SELECT count(*)::integer FROM location_municipalities
            WHERE source_revision = ${snapshot.source.revision}) AS municipalities,
          (SELECT count(*)::integer FROM location_postal_codes
            WHERE source_revision = ${snapshot.source.revision}) AS "postalCodes",
          (SELECT count(*)::integer FROM location_municipality_postal_codes
            WHERE source_revision = ${snapshot.source.revision}) AS links
      `;
      if (
        stored?.regions !== snapshot.counts.regions ||
        stored.districts !== snapshot.counts.districts ||
        stored.municipalities !== snapshot.counts.municipalities ||
        stored.postalCodes !== snapshot.counts.postalCodes ||
        stored.links !== snapshot.counts.municipalityPostalCodes
      ) {
        throw new Error(
          "Location reference import conflicts with existing governed catalog rows.",
        );
      }
      await installGovernedCityAreas(transaction, snapshot);
      return { alreadyApplied: false } as const;
    });

    process.stdout.write(
      `${JSON.stringify({ ...result, checksum: snapshot.contentSha256, counts: snapshot.counts, revision: snapshot.source.revision })}\n`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function installGovernedCityAreas(
  transaction: TransactionSql,
  snapshot: Awaited<ReturnType<typeof loadSlovakiaLocationReferenceSnapshot>>,
): Promise<void> {
  const areas = deriveGovernedCityAreas(snapshot);
  for (const area of areas) {
    await transaction`
      INSERT INTO location_districts (
        code, region_code, name_sk, source_reference, source_revision, is_active
      ) VALUES (
        ${area.districtCode}, ${area.regionCode}, ${area.name},
        ${snapshot.source.catalogUrl}, ${area.sourceRevision}, true
      )
      ON CONFLICT (code) DO NOTHING
    `;
    await transaction`
      INSERT INTO location_municipalities (
        code, district_code, name_sk, centroid,
        source_reference, source_revision, is_active
      )
      SELECT
        ${area.code}, ${area.districtCode}, ${area.name},
        ST_Centroid(ST_Collect(member.centroid::geometry))::geography,
        ${snapshot.source.catalogUrl}, ${area.sourceRevision}, true
      FROM location_municipalities member
      WHERE member.code = ANY(${area.memberCodes}::text[])
      HAVING count(*) = ${area.memberCodes.length}
      ON CONFLICT (code) DO NOTHING
    `;
    await transaction`
      INSERT INTO location_city_areas (
        municipality_code, member_count, source_reference, source_revision
      ) VALUES (
        ${area.code}, ${area.memberCodes.length},
        ${snapshot.source.catalogUrl}, ${area.sourceRevision}
      )
      ON CONFLICT (municipality_code) DO NOTHING
    `;
    await transaction`
      INSERT INTO location_city_area_members (city_area_code, municipality_code)
      SELECT ${area.code}, member_code
      FROM unnest(${area.memberCodes}::text[]) member_code
      ON CONFLICT (city_area_code, municipality_code) DO NOTHING
    `;
    const [stored] = await transaction<
      {
        districtCode: string;
        memberCount: number;
        name: string;
        regionCode: string;
      }[]
    >`
      SELECT municipality.name_sk AS name,
        municipality.district_code AS "districtCode",
        district.region_code AS "regionCode",
        count(member.municipality_code)::integer AS "memberCount"
      FROM location_city_areas area
      JOIN location_municipalities municipality
        ON municipality.code = area.municipality_code
      JOIN location_districts district
        ON district.code = municipality.district_code
      JOIN location_city_area_members member
        ON member.city_area_code = area.municipality_code
      WHERE area.municipality_code = ${area.code}
      GROUP BY municipality.name_sk, municipality.district_code, district.region_code
    `;
    if (
      stored?.name !== area.name ||
      stored.districtCode !== area.districtCode ||
      stored.regionCode !== area.regionCode ||
      stored.memberCount !== area.memberCodes.length
    ) {
      throw new Error(
        "Governed city area import conflicts with existing rows.",
      );
    }
  }
}

function batches<T>(
  values: readonly T[],
  size: number,
): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

void main().catch((error: unknown) => {
  const safeMessages = new Set([
    "DATABASE_URL is required for location reference import.",
    "Existing location reference revision has another checksum.",
    "Location reference import conflicts with existing governed catalog rows.",
    "Location reference import requires explicit opt-in.",
  ]);
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(
    `${safeMessages.has(message) || message.startsWith("Location reference") || message.startsWith("Unsupported location") || message.startsWith("Required Prievidza") ? message : "Location reference import failed safely."}\n`,
  );
  process.exitCode = 1;
});

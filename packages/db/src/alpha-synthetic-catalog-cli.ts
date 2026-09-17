import postgres from "postgres";

import { prepareProfessionTaxonomyRelease } from "@portal/taxonomy";

import { createProfessionTaxonomyRepository } from "./taxonomy-repository.js";

const release = prepareProfessionTaxonomyRelease({
  aliases: [],
  capabilityCriteria: [],
  contentClass: "CANONICAL",
  professions: [
    {
      code: "PROF:ALPHA_SYNTHETIC",
      labelSk: "Syntetické testovacie remeslo",
      replacedByCode: null,
      slug: "synteticke-testovacie-remeslo",
      state: "ACTIVE",
    },
  ],
  releaseId: "00000000-0000-4000-8000-000000003301",
  // This is an isolated non-production fixture of the approved-state branch,
  // never a review or activation of the real marketplace taxonomy.
  reviewReference: "test-fixture:alpha/r3-022",
  reviewState: "HUMAN_REVIEW_APPROVED",
  specializations: [],
  supersedesReleaseId: null,
  version: 1,
});

const location = Object.freeze({
  districtCode: "TEST:DISTRICT_ALPHA",
  municipalityCode: "TEST:MUNICIPALITY_ALPHA",
  point: "SRID=4326;POINT(17.11 48.15)",
  regionCode: "TEST:REGION_ALPHA",
  sourceReference: "test-fixture:alpha/r3-022",
  sourceRevision: "synthetic-v1",
});

async function main(): Promise<void> {
  if (
    process.env["APP_ENV"] !== "staging" ||
    process.env["ALPHA_SYNTHETIC_FIXTURE"] !== "1"
  ) {
    throw new Error("Synthetic alpha catalog requires explicit staging mode.");
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required for synthetic alpha catalog.");
  }
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [environment] = await sql<{ environment: string }[]>`
      SELECT COALESCE(current_setting('portal.environment', true), '') AS environment
    `;
    if (environment?.environment !== "staging") {
      throw new Error(
        "Synthetic alpha catalog target is not a staging database.",
      );
    }

    const [current] = await sql<{ releaseId: string }[]>`
      SELECT release_id AS "releaseId"
      FROM profession_taxonomy_activation_events
      ORDER BY activation_sequence DESC
      LIMIT 1
    `;
    if (current !== undefined && current.releaseId !== release.releaseId) {
      throw new Error(
        "Synthetic alpha catalog cannot replace an existing taxonomy.",
      );
    }

    const taxonomy = createProfessionTaxonomyRepository(sql);
    const installed = await taxonomy.installRelease(release);
    if (current === undefined) {
      await taxonomy.activateRelease({
        activationId: "00000000-0000-4000-8000-000000003302",
        actorReference: "test-fixture:alpha/r3-022",
        previousReleaseId: null,
        releaseId: release.releaseId,
        reviewReference: release.reviewReference!,
      });
    }

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO location_regions (
          code, name_sk, source_reference, source_revision
        ) VALUES (
          ${location.regionCode}, 'Syntetický testovací kraj',
          ${location.sourceReference}, ${location.sourceRevision}
        ) ON CONFLICT (code) DO NOTHING
      `;
      await transaction`
        INSERT INTO location_districts (
          code, region_code, name_sk, source_reference, source_revision
        ) VALUES (
          ${location.districtCode}, ${location.regionCode},
          'Syntetický testovací okres',
          ${location.sourceReference}, ${location.sourceRevision}
        ) ON CONFLICT (code) DO NOTHING
      `;
      await transaction`
        INSERT INTO location_municipalities (
          code, district_code, name_sk, centroid,
          source_reference, source_revision
        ) VALUES (
          ${location.municipalityCode}, ${location.districtCode},
          'Syntetická testovacia obec', ST_GeogFromText(${location.point}),
          ${location.sourceReference}, ${location.sourceRevision}
        ) ON CONFLICT (code) DO NOTHING
      `;
      const [stored] = await transaction<
        {
          regionSource: string;
          districtSource: string;
          municipalitySource: string;
          regionRevision: string;
          districtRevision: string;
          municipalityRevision: string;
          municipalityName: string;
          municipalityPoint: string;
        }[]
      >`
        SELECT region.source_reference AS "regionSource",
          district.source_reference AS "districtSource",
          municipality.source_reference AS "municipalitySource",
          region.source_revision AS "regionRevision",
          district.source_revision AS "districtRevision",
          municipality.source_revision AS "municipalityRevision",
          municipality.name_sk AS "municipalityName",
          ST_AsEWKT(municipality.centroid::geometry) AS "municipalityPoint"
        FROM location_municipalities municipality
        JOIN location_districts district ON district.code = municipality.district_code
        JOIN location_regions region ON region.code = district.region_code
        WHERE municipality.code = ${location.municipalityCode}
          AND district.code = ${location.districtCode}
          AND region.code = ${location.regionCode}
      `;
      if (
        stored?.regionSource !== location.sourceReference ||
        stored.districtSource !== location.sourceReference ||
        stored.municipalitySource !== location.sourceReference ||
        stored.regionRevision !== location.sourceRevision ||
        stored.districtRevision !== location.sourceRevision ||
        stored.municipalityRevision !== location.sourceRevision ||
        stored.municipalityName !== "Syntetická testovacia obec" ||
        stored.municipalityPoint !== location.point
      ) {
        throw new Error("Existing synthetic alpha location fixture conflicts.");
      }
    });
    process.stdout.write(
      `${JSON.stringify({ dataClass: "synthetic", installed, municipalityCode: location.municipalityCode, professionCode: release.professions[0]?.code })}\n`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  const safe =
    message.startsWith("Synthetic alpha catalog") ||
    message.startsWith("Existing synthetic alpha") ||
    message === "DATABASE_URL is required for synthetic alpha catalog.";
  process.stderr.write(
    `${safe ? message : "Synthetic alpha catalog failed safely."}\n`,
  );
  process.exitCode = 1;
});

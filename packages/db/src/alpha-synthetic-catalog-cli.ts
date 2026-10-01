import postgres from "postgres";

const location = Object.freeze({
  districtCode: "TEST:DISTRICT_ALPHA",
  municipalityCode: "TEST:MUNICIPALITY_ALPHA",
  point: "SRID=4326;POINT(17.11 48.15)",
  regionCode: "TEST:REGION_ALPHA",
  sourceReference: "test-fixture:alpha/r3-022",
  sourceRevision: "synthetic-v1",
});

const credentialTypes = Object.freeze([
  Object.freeze({
    code: "test.required-license",
    evidenceRequirement: "REQUIRED" as const,
    sourceReference: "test-fixture:alpha/r4-032-required",
  }),
  Object.freeze({
    code: "test.optional-certificate",
    evidenceRequirement: "OPTIONAL" as const,
    sourceReference: "test-fixture:alpha/r4-032-optional",
  }),
]);

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

    const [current] = await sql<
      { professionCode: string; releaseId: string }[]
    >`
      SELECT activation.release_id AS "releaseId",
        profession.profession_code AS "professionCode"
      FROM profession_taxonomy_activation_events activation
      JOIN profession_taxonomy_releases release
        ON release.release_id = activation.release_id
      JOIN taxonomy_professions profession
        ON profession.release_id = activation.release_id
       AND profession.profession_code = 'PROF:ELECTRICIAN'
       AND profession.state = 'ACTIVE'
      WHERE release.content_class = 'CANONICAL'
        AND release.review_state = 'HUMAN_REVIEW_APPROVED'
      ORDER BY activation.activation_sequence DESC
      LIMIT 1
    `;
    if (current === undefined) {
      throw new Error("Synthetic alpha catalog requires the managed catalog.");
    }

    await sql.begin(async (transaction) => {
      for (const credentialType of credentialTypes) {
        await transaction`
          INSERT INTO credential_type_policies (
            code, evidence_requirement, source_reference
          ) VALUES (
            ${credentialType.code}, ${credentialType.evidenceRequirement},
            ${credentialType.sourceReference}
          ) ON CONFLICT (code) DO NOTHING
        `;
        const [storedCredentialType] = await transaction<
          {
            active: boolean;
            evidenceRequirement: string;
            sourceReference: string;
          }[]
        >`
          SELECT active, evidence_requirement AS "evidenceRequirement",
            source_reference AS "sourceReference"
          FROM credential_type_policies
          WHERE code = ${credentialType.code}
        `;
        if (
          storedCredentialType?.active !== true ||
          storedCredentialType.evidenceRequirement !==
            credentialType.evidenceRequirement ||
          storedCredentialType.sourceReference !==
            credentialType.sourceReference
        ) {
          throw new Error(
            "Existing synthetic alpha credential type fixture conflicts.",
          );
        }
      }
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
      `${JSON.stringify({ credentialTypeCodes: credentialTypes.map(({ code }) => code), dataClass: "synthetic", installed: "MANAGED_CATALOG_CURRENT", municipalityCode: location.municipalityCode, professionCode: current.professionCode, taxonomyReleaseId: current.releaseId })}\n`,
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

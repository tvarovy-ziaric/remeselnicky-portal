import { randomUUID } from "node:crypto";

import type {
  CraftsmanProfileId,
  MunicipalityCode,
  ReplaceCraftsmanServiceAreaInput,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCraftsmanServiceAreaRepository } from "../src/craftsman-service-area-repository.js";

const regionCode = "TEST:REGION_WEST";
const districtCode = "TEST:DISTRICT_WEST";
const baseCode = "TEST:MUNICIPALITY_BASE" as MunicipalityCode;
const extraCode1 = "TEST:MUNICIPALITY_EXTRA_1" as MunicipalityCode;
const extraCode2 = "TEST:MUNICIPALITY_EXTRA_2" as MunicipalityCode;
const extraCode3 = "TEST:MUNICIPALITY_EXTRA_3" as MunicipalityCode;
const extraCode4 = "TEST:MUNICIPALITY_EXTRA_4" as MunicipalityCode;
const extraCodes = [extraCode1, extraCode2, extraCode3, extraCode4] as const;
const inactiveCode = "TEST:MUNICIPALITY_INACTIVE" as MunicipalityCode;

/** Runs inside the single clean-migration integration test. Catalog rows are synthetic only. */
export async function runCraftsmanServiceAreaIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  await insertSyntheticCatalog(sql);

  const [geo] = await sql<
    {
      readonly geometryType: string;
      readonly srid: number;
      readonly distanceMeters: number;
    }[]
  >`
    SELECT
      GeometryType(base.centroid::geometry) AS "geometryType",
      ST_SRID(base.centroid::geometry) AS srid,
      ST_Distance(base.centroid, extra.centroid) AS "distanceMeters"
    FROM location_municipalities base
    JOIN location_municipalities extra ON extra.code = ${extraCodes[0]}
    WHERE base.code = ${baseCode}
  `;
  expect(geo).toMatchObject({ geometryType: "POINT", srid: 4326 });
  expect(geo?.distanceMeters).toBeGreaterThan(0);

  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  const [nonOwner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined || nonOwner === undefined) {
    throw new Error("Expected service-area test users.");
  }
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${owner.id}, 'INDIVIDUAL')
    RETURNING id
  `;
  if (profile === undefined) throw new Error("Expected service-area profile.");

  const repository = createCraftsmanServiceAreaRepository(sql);
  await expect(
    repository.replaceOwnedDraft({
      ...input(owner.id, profile.id),
      actorUserId: nonOwner.id,
    }),
  ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
  await expect(
    repository.findOwned({
      actorUserId: nonOwner.id,
      craftsmanProfileId: profile.id,
    }),
  ).resolves.toBeNull();

  const incomplete = input(owner.id, profile.id, {
    baseMunicipalityCode: null,
    extraMunicipalityCodes: [],
    maximumRadiusKm: null,
    normalRadiusKm: null,
    travelFeePolicy: null,
    travelFeeThresholdKm: null,
  });
  await expect(repository.replaceOwnedDraft(incomplete)).resolves.toMatchObject(
    {
      serviceArea: {
        baseMunicipalityCode: null,
        normalRadiusKm: null,
        revision: 1,
      },
      status: "APPLIED",
    },
  );

  const complete = input(owner.id, profile.id, {
    commandId: randomUUID(),
    expectedRevision: 1,
    travelFeePolicy: "  Bežne bez príplatku.\r\nĎalej podľa cenovej ponuky.  ",
  });
  const applied = await repository.replaceOwnedDraft(complete);
  expect(applied).toMatchObject({
    serviceArea: {
      baseMunicipalityCode: baseCode,
      extraMunicipalityCodes: extraCodes.slice(0, 3),
      maximumRadiusKm: 80,
      normalRadiusKm: 25,
      revision: 2,
      travelFeePolicy: "Bežne bez príplatku.\nĎalej podľa cenovej ponuky.",
      travelFeeThresholdKm: 30,
    },
    status: "APPLIED",
  });
  await expect(repository.replaceOwnedDraft(complete)).resolves.toMatchObject({
    serviceArea: { revision: 2 },
    status: "DEDUPLICATED",
  });

  await expect(
    repository.replaceOwnedDraft({
      ...complete,
      commandId: randomUUID(),
      expectedRevision: 2,
    }),
  ).resolves.toMatchObject({
    serviceArea: { revision: 2 },
    status: "UNCHANGED",
  });

  await expect(
    repository.replaceOwnedDraft({
      ...input(owner.id, profile.id),
      baseMunicipalityCode: inactiveCode,
      commandId: randomUUID(),
      expectedRevision: 2,
      extraMunicipalityCodes: [],
    }),
  ).resolves.toEqual({ status: "LOCATION_NOT_AVAILABLE" });
  await expect(
    repository.replaceOwnedDraft({
      ...input(owner.id, profile.id),
      baseMunicipalityCode: "TEST:DOES_NOT_EXIST" as MunicipalityCode,
      commandId: randomUUID(),
      expectedRevision: 2,
      extraMunicipalityCodes: [],
    }),
  ).resolves.toEqual({ status: "LOCATION_NOT_AVAILABLE" });

  const competing = await Promise.all([
    repository.replaceOwnedDraft({
      ...input(owner.id, profile.id),
      commandId: randomUUID(),
      expectedRevision: 2,
      normalRadiusKm: 26,
    }),
    repository.replaceOwnedDraft({
      ...input(owner.id, profile.id),
      commandId: randomUUID(),
      expectedRevision: 2,
      normalRadiusKm: 27,
    }),
  ]);
  expect(competing.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "STALE_REVISION",
  ]);

  await exerciseCatalogAndRawSqlGuards(sql, owner.id, nonOwner.id, profile.id);
  await exerciseBackendExtraAreaExtensibility(sql);
  await exerciseSuspensionRace(sql, repository);

  const forbiddenColumns = await sql<{ readonly columnName: string }[]>`
    SELECT column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_name IN (
      'craftsman_service_area_commands',
      'craftsman_service_area_revisions',
      'craftsman_service_area_extra_municipalities'
    )
      AND column_name IN (
        'street', 'house_number', 'exact_address', 'latitude', 'longitude',
        'email', 'phone', 'profession_code', 'travel_fee_amount', 'hard_reject'
      )
  `;
  expect(forbiddenColumns).toEqual([]);
}

async function insertSyntheticCatalog(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO location_regions (
      code, name_sk, source_reference, source_revision
    ) VALUES (
      ${regionCode}, 'Testovací kraj', 'test-fixture:R1-006', 'synthetic-v1'
    )
  `;
  await sql`
    INSERT INTO location_districts (
      code, region_code, name_sk, source_reference, source_revision
    ) VALUES (
      ${districtCode}, ${regionCode}, 'Testovací okres',
      'test-fixture:R1-006', 'synthetic-v1'
    )
  `;
  const municipalities = [
    [baseCode, "POINT(17.10 48.15)", true],
    [extraCodes[0], "POINT(18.10 48.70)", true],
    [extraCodes[1], "POINT(19.10 48.90)", true],
    [extraCodes[2], "POINT(20.10 49.10)", true],
    [extraCodes[3], "POINT(21.10 49.30)", true],
    [inactiveCode, "POINT(22.10 49.40)", false],
  ] as const;
  for (const [code, point, isActive] of municipalities) {
    await sql`
      INSERT INTO location_municipalities (
        code, district_code, name_sk, centroid,
        source_reference, source_revision, is_active
      ) VALUES (
        ${code}, ${districtCode}, ${`Testovacia obec ${code}`},
        ST_GeogFromText(${`SRID=4326;${point}`}),
        'test-fixture:R1-006', 'synthetic-v1', ${isActive}
      )
    `;
  }
}

async function exerciseCatalogAndRawSqlGuards(
  sql: Sql,
  ownerUserId: UserId,
  nonOwnerUserId: UserId,
  profileId: CraftsmanProfileId,
): Promise<void> {
  await expect(sql`
    INSERT INTO location_municipalities (
      code, district_code, name_sk, centroid, source_reference, source_revision
    ) VALUES (
      'TEST:OUTSIDE_SK', ${districtCode}, 'Outside',
      ST_GeogFromText('SRID=4326;POINT(24 51)'),
      'test-fixture:R1-006', 'synthetic-v1'
    )
  `).rejects.toThrow(/location_municipalities_centroid_shape/u);
  await expect(sql`
    INSERT INTO location_districts (
      code, region_code, name_sk, source_reference, source_revision
    ) VALUES (
      'TEST:ORPHAN_DISTRICT', 'TEST:NO_REGION', 'Orphan',
      'test-fixture:R1-006', 'synthetic-v1'
    )
  `).rejects.toThrow(/foreign key/u);
  await expect(sql`
    UPDATE location_municipalities SET name_sk = 'Prepísaná obec'
    WHERE code = ${baseCode}
  `).rejects.toThrow(/append-only/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
      INSERT INTO craftsman_service_area_commands (
        command_id, craftsman_profile_id, actor_user_id, expected_revision,
        result_kind, resulting_revision, base_municipality_code,
        normal_radius_meters, maximum_radius_meters, extra_municipality_codes,
        travel_fee_policy, travel_fee_threshold_meters, payload_fingerprint
      ) VALUES (
        ${randomUUID()}, ${profileId}, ${nonOwnerUserId}, 3,
        'UNCHANGED', 3, ${baseCode}, 26000, 80000,
        ${JSON.stringify(extraCodes.slice(0, 3))}::jsonb,
        'Bežne bez príplatku.', 30000, ${"a".repeat(64)}
      )
    `;
    }),
  ).rejects.toThrow(/active owned craftsman profile/u);

  const [current] = await sql<{ readonly revision: number }[]>`
    SELECT revision FROM current_craftsman_service_areas
    WHERE craftsman_profile_id = ${profileId}
  `;
  if (current === undefined) throw new Error("Expected current service area.");
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO craftsman_service_area_commands (
          command_id, craftsman_profile_id, actor_user_id, expected_revision,
          result_kind, resulting_revision, base_municipality_code,
          normal_radius_meters, maximum_radius_meters, extra_municipality_codes,
          travel_fee_policy, travel_fee_threshold_meters, payload_fingerprint
        ) VALUES (
          ${randomUUID()}, ${profileId}, ${ownerUserId}, ${current.revision},
          'APPLIED', ${current.revision + 1}, ${baseCode}, 28000, 80000,
          ${JSON.stringify(extraCodes.slice(0, 3))}::jsonb,
          'Volajte +421 900 123 456', 30000, ${"d".repeat(64)}
        )
      `;
    }),
  ).rejects.toThrow(/craftsman_service_area_commands_policy_safe/u);
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
      INSERT INTO craftsman_service_area_commands (
        command_id, craftsman_profile_id, actor_user_id, expected_revision,
        result_kind, resulting_revision, base_municipality_code,
        normal_radius_meters, maximum_radius_meters, extra_municipality_codes,
        travel_fee_policy, travel_fee_threshold_meters, payload_fingerprint
      ) VALUES (
        ${randomUUID()}, ${profileId}, ${ownerUserId}, ${current.revision},
        'UNCHANGED', ${current.revision}, ${baseCode}, 999000, 999000,
        ${JSON.stringify(extraCodes.slice(0, 3))}::jsonb,
        'Falošný no-op.', 30000, ${"b".repeat(64)}
      )
    `;
    }),
  ).rejects.toThrow(/match current state exactly/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
      INSERT INTO craftsman_service_area_commands (
        command_id, craftsman_profile_id, actor_user_id, expected_revision,
        result_kind, resulting_revision, base_municipality_code,
        normal_radius_meters, maximum_radius_meters, extra_municipality_codes,
        travel_fee_policy, travel_fee_threshold_meters, payload_fingerprint
      ) VALUES (
        ${randomUUID()}, ${profileId}, ${ownerUserId}, ${current.revision},
        'APPLIED', ${current.revision + 1}, ${baseCode}, 28000, 80000,
        ${JSON.stringify(extraCodes.slice(0, 3))}::jsonb,
        'Bez revízneho efektu.', 30000, ${"c".repeat(64)}
      )
    `;
    }),
  ).rejects.toThrow(/requires exact revision effect/u);

  const [revision] = await sql<{ readonly id: string }[]>`
    SELECT id FROM current_craftsman_service_areas
    WHERE craftsman_profile_id = ${profileId}
  `;
  if (revision === undefined) throw new Error("Expected service-area history.");
  await expect(sql`
    UPDATE craftsman_service_area_revisions SET normal_radius_meters = 1
    WHERE id = ${revision.id}
  `).rejects.toThrow(/append-only/u);
  await expect(sql`
    DELETE FROM craftsman_service_area_extra_municipalities
    WHERE service_area_revision_id = ${revision.id}
  `).rejects.toThrow(/append-only/u);
}

async function exerciseBackendExtraAreaExtensibility(sql: Sql): Promise<void> {
  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined) throw new Error("Expected extensibility owner.");
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${owner.id}, 'COMPANY') RETURNING id
  `;
  if (profile === undefined) throw new Error("Expected extensibility profile.");
  await expect(
    createCraftsmanServiceAreaRepository(sql).replaceOwnedDraft({
      ...input(owner.id, profile.id),
      extraMunicipalityCodes: extraCodes,
    }),
  ).resolves.toMatchObject({
    serviceArea: { extraMunicipalityCodes: extraCodes },
    status: "APPLIED",
  });
}

async function exerciseSuspensionRace(
  sql: Sql,
  repository: ReturnType<typeof createCraftsmanServiceAreaRepository>,
): Promise<void> {
  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined) throw new Error("Expected suspension-race owner.");
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${owner.id}, 'INDIVIDUAL') RETURNING id
  `;
  if (profile === undefined)
    throw new Error("Expected suspension-race profile.");
  const command = input(owner.id, profile.id);
  const [commandResult] = await Promise.all([
    repository.replaceOwnedDraft(command),
    sql`
      UPDATE users
      SET account_state = 'SUSPENDED',
          account_state_changed_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE users.id = ${owner.id}
    `,
  ]);
  expect(["APPLIED", "PROFILE_UNAVAILABLE"]).toContain(commandResult.status);
  const [raceEvidence] = await sql<
    {
      readonly accountStateChangedAt: Date;
      readonly commandCount: number;
      readonly revisionCreatedAt: Date | null;
    }[]
  >`
    SELECT
      owner.account_state_changed_at AS "accountStateChangedAt",
      count(command.command_id)::integer AS "commandCount",
      max(revision.created_at) AS "revisionCreatedAt"
    FROM users owner
    LEFT JOIN craftsman_service_area_commands command
      ON command.craftsman_profile_id = ${profile.id}
    LEFT JOIN craftsman_service_area_revisions revision
      ON revision.command_id = command.command_id
    WHERE owner.id = ${owner.id}
    GROUP BY owner.account_state_changed_at
  `;
  if (raceEvidence === undefined)
    throw new Error("Expected suspension-race evidence.");
  expect(raceEvidence.commandCount).toBe(
    commandResult.status === "APPLIED" ? 1 : 0,
  );
  if (raceEvidence.revisionCreatedAt !== null) {
    expect(raceEvidence.revisionCreatedAt.valueOf()).toBeLessThanOrEqual(
      raceEvidence.accountStateChangedAt.valueOf(),
    );
  }
  await expect(repository.replaceOwnedDraft(command)).resolves.toEqual({
    status: "PROFILE_UNAVAILABLE",
  });
}

function input(
  actorUserId: UserId,
  craftsmanProfileId: CraftsmanProfileId,
  changes: Partial<ReplaceCraftsmanServiceAreaInput> = {},
): ReplaceCraftsmanServiceAreaInput {
  return {
    actorUserId,
    baseMunicipalityCode: baseCode,
    commandId: randomUUID(),
    craftsmanProfileId,
    expectedRevision: 0,
    extraMunicipalityCodes: extraCodes.slice(0, 3),
    maximumRadiusKm: 80,
    normalRadiusKm: 25,
    travelFeePolicy: "Bežne bez príplatku.",
    travelFeeThresholdKm: 30,
    ...changes,
  };
}

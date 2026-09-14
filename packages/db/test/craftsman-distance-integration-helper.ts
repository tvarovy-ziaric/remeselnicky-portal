import { createHash, randomUUID } from "node:crypto";

import type {
  CraftsmanProfessionId,
  CraftsmanProfileId,
  MunicipalityCode,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCraftsmanDistanceRepository } from "../src/craftsman-distance-repository.js";
import { createCraftsmanProfessionRepository } from "../src/craftsman-profession-repository.js";
import { createCraftsmanPublicationRepository } from "../src/craftsman-publication-repository.js";
import { createCraftsmanServiceAreaRepository } from "../src/craftsman-service-area-repository.js";

interface LocationFixture {
  readonly first: MunicipalityCode;
  readonly second: MunicipalityCode;
}

interface AdminFixture {
  readonly sessionDigest: string;
  readonly userId: UserId;
}

interface CandidateFixture {
  readonly ownerId: UserId;
  readonly profileId: CraftsmanProfileId;
  publicationRevision: number;
}

/** Standalone R2-003 live-PostGIS assertions; never wired into the shared runner. */
export async function runCraftsmanDistanceIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const locations = await createLocations(sql);
  const admin = await createAdmin(sql);
  const first = await createPublicCandidate(sql, admin, locations.first);
  const tied = await createPublicCandidate(sql, admin, locations.first);
  const farther = await createPublicCandidate(sql, admin, locations.second);
  const repository = createCraftsmanDistanceRepository(sql);

  const measured = await repository.findPublicDistanceFacts({
    limit: 100,
    municipalityCode: locations.first,
  });
  expect(measured.status).toBe("OK");
  if (measured.status !== "OK") {
    throw new Error("Expected governed-origin distance facts.");
  }
  const ownFacts = measured.facts.filter(({ craftsmanProfileId }) =>
    [first.profileId, tied.profileId, farther.profileId].includes(
      craftsmanProfileId,
    ),
  );
  expect(ownFacts).toHaveLength(3);
  const zeroDistance = ownFacts.filter(
    ({ rankingDistanceMeters }) => rankingDistanceMeters === 0,
  );
  expect(
    zeroDistance.map(({ craftsmanProfileId }) => craftsmanProfileId),
  ).toEqual([first.profileId, tied.profileId].sort());
  const fartherFact = ownFacts.find(
    ({ craftsmanProfileId }) => craftsmanProfileId === farther.profileId,
  );
  expect(fartherFact?.rankingDistanceMeters).toBeGreaterThan(0);
  expect(fartherFact?.approximateDistanceKm).toBe(
    Math.round((fartherFact?.rankingDistanceMeters ?? 0) / 1000),
  );

  const missing = await repository.findPublicDistanceFacts({
    limit: 100,
    municipalityCode: null,
  });
  expect(missing.status).toBe("OK");
  if (missing.status === "OK") {
    const missingOwn = missing.facts.filter(({ craftsmanProfileId }) =>
      [first.profileId, tied.profileId, farther.profileId].includes(
        craftsmanProfileId,
      ),
    );
    expect(missingOwn).toHaveLength(3);
    expect(
      missingOwn.every(
        ({ approximateDistanceKm, rankingDistanceMeters }) =>
          approximateDistanceKm === null && rankingDistanceMeters === null,
      ),
    ).toBe(true);
    expect(
      missingOwn.map(({ craftsmanProfileId }) => craftsmanProfileId),
    ).toEqual(
      [
        ...missingOwn.map(({ craftsmanProfileId }) => craftsmanProfileId),
      ].sort(),
    );
  }

  await expect(
    repository.findPublicDistanceFacts({
      limit: 100,
      municipalityCode: "US:OUTSIDE" as MunicipalityCode,
    }),
  ).resolves.toEqual({ status: "LOCATION_UNAVAILABLE" });
  await expect(
    repository.findPublicDistanceFacts({
      limit: 100,
      municipalityCode: "48.15,17.1" as MunicipalityCode,
    }),
  ).rejects.toThrow(/distance query/u);

  await assertHiddenAndSuspendedGates(sql, repository, locations.first, first);
  await assertRawSqlPrivacyAndGeoGuards(sql, locations.first);
}

async function assertHiddenAndSuspendedGates(
  sql: Sql,
  repository: ReturnType<typeof createCraftsmanDistanceRepository>,
  origin: MunicipalityCode,
  candidate: CandidateFixture,
): Promise<void> {
  const publication = createCraftsmanPublicationRepository(sql);
  const hidden = await publication.setOwnerVisibility({
    actorUserId: candidate.ownerId,
    commandId: randomUUID(),
    craftsmanProfileId: candidate.profileId,
    expectedRevision: candidate.publicationRevision,
    visibility: "HIDDEN",
  });
  expect(hidden.status).toBe("APPLIED");
  if (hidden.status !== "APPLIED") throw new Error("Expected profile hide.");
  candidate.publicationRevision = hidden.publication.revision;
  try {
    await expectCandidateAbsent(repository, origin, candidate.profileId);
  } finally {
    const restored = await publication.setOwnerVisibility({
      actorUserId: candidate.ownerId,
      commandId: randomUUID(),
      craftsmanProfileId: candidate.profileId,
      expectedRevision: candidate.publicationRevision,
      visibility: "PUBLIC",
    });
    expect(restored.status).toBe("APPLIED");
    if (restored.status === "APPLIED") {
      candidate.publicationRevision = restored.publication.revision;
    }
  }

  await setAccountState(sql, candidate.ownerId, "SUSPENDED");
  try {
    await expectCandidateAbsent(repository, origin, candidate.profileId);
  } finally {
    await setAccountState(sql, candidate.ownerId, "ACTIVE");
  }
  const restoredFacts = await repository.findPublicDistanceFacts({
    limit: 100,
    municipalityCode: origin,
  });
  expect(
    restoredFacts.status === "OK" &&
      restoredFacts.facts.some(
        ({ craftsmanProfileId }) => craftsmanProfileId === candidate.profileId,
      ),
  ).toBe(true);
}

async function expectCandidateAbsent(
  repository: ReturnType<typeof createCraftsmanDistanceRepository>,
  origin: MunicipalityCode,
  profileId: CraftsmanProfileId,
): Promise<void> {
  const result = await repository.findPublicDistanceFacts({
    limit: 100,
    municipalityCode: origin,
  });
  expect(
    result.status === "OK" &&
      result.facts.every(
        ({ craftsmanProfileId }) => craftsmanProfileId !== profileId,
      ),
  ).toBe(true);
}

async function assertRawSqlPrivacyAndGeoGuards(
  sql: Sql,
  origin: MunicipalityCode,
): Promise<void> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM public_craftsman_distance_facts(${origin}) LIMIT 1
  `;
  expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
    "approximate_distance_km",
    "craftsman_profile_id",
    "ranking_distance_meters",
  ]);
  expect(JSON.stringify(rows)).not.toMatch(
    /owner|centroid|latitude|longitude|coordinate|address|street|postal|email|phone/iu,
  );
  await expect(
    sql`SELECT * FROM public_craftsman_distance_facts('US:OUTSIDE')`,
  ).resolves.toEqual([]);

  const suffix = randomUUID().slice(0, 8).toUpperCase();
  await expect(
    sql.begin(async (transaction) => {
      const region = `TEST:R2003:OUT:R:${suffix}`;
      const district = `TEST:R2003:OUT:D:${suffix}`;
      await transaction`
        INSERT INTO location_regions (
          code, name_sk, source_reference, source_revision
        ) VALUES (${region}, 'Mimo test kraj', 'test-fixture:R2-003', 'synthetic-v1')
      `;
      await transaction`
        INSERT INTO location_districts (
          code, region_code, name_sk, source_reference, source_revision
        ) VALUES (
          ${district}, ${region}, 'Mimo test okres',
          'test-fixture:R2-003', 'synthetic-v1'
        )
      `;
      await transaction`
        INSERT INTO location_municipalities (
          code, district_code, name_sk, centroid, source_reference, source_revision
        ) VALUES (
          ${`TEST:R2003:OUT:M:${suffix}`}, ${district}, 'Mimo Slovenska',
          ST_GeogFromText('SRID=4326;POINT(24 48)'),
          'test-fixture:R2-003', 'synthetic-v1'
        )
      `;
    }),
  ).rejects.toThrow(/location_municipalities_centroid_shape/u);
}

async function createPublicCandidate(
  sql: Sql,
  admin: AdminFixture,
  municipalityCode: MunicipalityCode,
): Promise<CandidateFixture> {
  const ownerId = await createUser(sql);
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (
      owner_user_id, profile_type, real_first_name, real_last_name, about,
      identity_verified_at, identity_verification_reference
    ) VALUES (
      ${ownerId}, 'INDIVIDUAL', 'Geo', 'Testovací',
      'Syntetický profil pre PostGIS distance test.', CURRENT_TIMESTAMP,
      ${`test:r2-003/${randomUUID()}`}
    ) RETURNING id
  `;
  if (profile === undefined) throw new Error("Expected distance profile.");
  const taxonomy = await activeProfession(sql);
  await expect(
    createCraftsmanProfessionRepository(sql).assign({
      actorUserId: ownerId,
      commandId: randomUUID(),
      craftsmanProfessionId: randomUUID() as CraftsmanProfessionId,
      craftsmanProfileId: profile.id,
      declaredLevel: "ADVANCED",
      professionCode: taxonomy.professionCode,
      taxonomyReleaseId: taxonomy.releaseId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    createCraftsmanServiceAreaRepository(sql).replaceOwnedDraft({
      actorUserId: ownerId,
      baseMunicipalityCode: municipalityCode,
      commandId: randomUUID(),
      craftsmanProfileId: profile.id,
      expectedRevision: 0,
      extraMunicipalityCodes: [],
      maximumRadiusKm: null,
      normalRadiusKm: 25,
      travelFeePolicy: null,
      travelFeeThresholdKm: null,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });

  const publication = createCraftsmanPublicationRepository(sql);
  await expect(
    publication.submitForReview({
      actorUserId: ownerId,
      commandId: randomUUID(),
      craftsmanProfileId: profile.id,
      expectedRevision: 0,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    publication.setOwnerVisibility({
      actorUserId: ownerId,
      commandId: randomUUID(),
      craftsmanProfileId: profile.id,
      expectedRevision: 1,
      visibility: "PUBLIC",
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const approved = await publication.approve({
    actorSessionIdDigest: admin.sessionDigest,
    actorUserId: admin.userId,
    commandId: randomUUID(),
    correlationId: randomUUID(),
    craftsmanProfileId: profile.id,
    expectedRevision: 2,
    reason: "R2-003 synthetic search-distance approval.",
  });
  expect(approved.status).toBe("APPLIED");
  if (approved.status !== "APPLIED") {
    throw new Error("Expected distance profile approval.");
  }
  return {
    ownerId,
    profileId: profile.id,
    publicationRevision: approved.publication.revision,
  };
}

async function createLocations(sql: Sql): Promise<LocationFixture> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const region = `TEST:R2003:R:${suffix}`;
  const district = `TEST:R2003:D:${suffix}`;
  const first = `TEST:R2003:M:A:${suffix}` as MunicipalityCode;
  const second = `TEST:R2003:M:B:${suffix}` as MunicipalityCode;
  await sql`
    INSERT INTO location_regions (code, name_sk, source_reference, source_revision)
    VALUES (${region}, 'Geo test kraj', 'test-fixture:R2-003', 'synthetic-v1')
  `;
  await sql`
    INSERT INTO location_districts (
      code, region_code, name_sk, source_reference, source_revision
    ) VALUES (
      ${district}, ${region}, 'Geo test okres',
      'test-fixture:R2-003', 'synthetic-v1'
    )
  `;
  await sql`
    INSERT INTO location_municipalities (
      code, district_code, name_sk, centroid, source_reference, source_revision
    ) VALUES
      (${first}, ${district}, 'Geo obec A',
        ST_GeogFromText('SRID=4326;POINT(17.1 48.15)'),
        'test-fixture:R2-003', 'synthetic-v1'),
      (${second}, ${district}, 'Geo obec B',
        ST_GeogFromText('SRID=4326;POINT(17.3 48.15)'),
        'test-fixture:R2-003', 'synthetic-v1')
  `;
  return { first, second };
}

async function activeProfession(sql: Sql) {
  const [row] = await sql<
    { readonly professionCode: string; readonly releaseId: string }[]
  >`
    SELECT profession.profession_code AS "professionCode",
      profession.release_id AS "releaseId"
    FROM profession_taxonomy_activation_events activation
    JOIN taxonomy_professions profession
      ON profession.release_id = activation.release_id
    WHERE profession.state = 'ACTIVE'
    ORDER BY activation.activation_sequence DESC, profession.profession_code
    LIMIT 1
  `;
  if (row === undefined) throw new Error("R2-003 requires active taxonomy.");
  return row;
}

async function createUser(sql: Sql): Promise<UserId> {
  const [row] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (row === undefined) throw new Error("Expected distance fixture user.");
  return row.id;
}

async function createAdmin(sql: Sql): Promise<AdminFixture> {
  const userId = await createUser(sql);
  const sessionDigest = createHash("sha256").update(randomUUID()).digest("hex");
  await sql`
    INSERT INTO auth_sessions (session_id_hash, user_id, expires_at)
    VALUES (${sessionDigest}, ${userId}, CURRENT_TIMESTAMP + interval '1 hour')
  `;
  await sql`
    INSERT INTO admin_role_grants (user_id, role, grant_source, reason)
    VALUES (${userId}, 'ADMIN', 'BOOTSTRAP', 'R2-003 test admin')
  `;
  const [factor] = await sql<{ readonly id: string }[]>`
    INSERT INTO admin_mfa_factors (user_id, kind, credential_reference)
    VALUES (${userId}, 'TOTP', ${`test:r2-003/${randomUUID()}`}) RETURNING id
  `;
  if (factor === undefined) throw new Error("Expected distance admin factor.");
  await sql`
    INSERT INTO admin_privileged_sessions (
      session_id_hash, user_id, mfa_factor_id, mfa_authenticated_at,
      created_at, expires_at
    ) VALUES (
      ${sessionDigest}, ${userId}, ${factor.id}, CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '1 hour'
    )
  `;
  return { sessionDigest, userId };
}

async function setAccountState(
  sql: Sql,
  userId: UserId,
  state: "ACTIVE" | "SUSPENDED",
): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    await transaction`
      UPDATE users SET account_state = ${state},
        account_state_changed_at = clock_timestamp(),
        updated_at = clock_timestamp()
      WHERE id = ${userId}
    `;
  });
}

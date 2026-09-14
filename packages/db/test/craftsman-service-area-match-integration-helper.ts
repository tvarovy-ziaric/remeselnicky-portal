import { randomUUID } from "node:crypto";

import type {
  CraftsmanProfileId,
  MunicipalityCode,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCraftsmanPublicationRepository } from "../src/craftsman-publication-repository.js";
import { createCraftsmanServiceAreaMatchRepository } from "../src/craftsman-service-area-match-repository.js";
import { createCraftsmanServiceAreaRepository } from "../src/craftsman-service-area-repository.js";
import { runCraftsmanDistanceIntegrationAssertions } from "./craftsman-distance-integration-helper.js";

interface CandidateFixture {
  readonly baseMunicipalityCode: MunicipalityCode;
  readonly ownerId: UserId;
  readonly profileId: CraftsmanProfileId;
  publicationRevision: number;
  serviceAreaRevision: number;
}

/** Standalone live-PostGIS assertions for R2-004; not wired into the runner. */
export async function runCraftsmanServiceAreaMatchIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const before = await sql<{ readonly profileId: string }[]>`
    SELECT craftsman_profile_id AS "profileId"
    FROM current_searchable_craftsman_profiles
  `;
  await runCraftsmanDistanceIntegrationAssertions(sql);
  const excludedIds = before.map(({ profileId }) => profileId);
  const fixtures = await sql<CandidateFixture[]>`
    SELECT searchable.craftsman_profile_id AS "profileId",
      profile.owner_user_id AS "ownerId",
      searchable.base_municipality_code AS "baseMunicipalityCode",
      searchable.publication_revision AS "publicationRevision",
      searchable.service_area_revision AS "serviceAreaRevision"
    FROM current_searchable_craftsman_profiles searchable
    JOIN craftsman_profiles profile ON profile.id = searchable.craftsman_profile_id
    WHERE NOT (searchable.craftsman_profile_id = ANY(${excludedIds}::uuid[]))
    ORDER BY searchable.craftsman_profile_id
  `;
  expect(fixtures).toHaveLength(3);
  const byMunicipality = new Map<MunicipalityCode, CandidateFixture[]>();
  for (const fixture of fixtures) {
    const candidates = byMunicipality.get(fixture.baseMunicipalityCode) ?? [];
    candidates.push(fixture);
    byMunicipality.set(fixture.baseMunicipalityCode, candidates);
  }
  const baseAEntry = [...byMunicipality.entries()].find(
    ([, candidates]) => candidates.length === 2,
  );
  const baseBEntry = [...byMunicipality.entries()].find(
    ([, candidates]) => candidates.length === 1,
  );
  if (baseAEntry === undefined || baseBEntry === undefined) {
    throw new Error("Expected two R2-003 base municipalities.");
  }
  const [baseA, baseACandidates] = baseAEntry;
  const [baseB, baseBCandidates] = baseBEntry;
  const outside = baseACandidates[0];
  const additional = baseACandidates[1];
  const farther = baseBCandidates[0];
  if (
    outside === undefined ||
    additional === undefined ||
    farther === undefined
  ) {
    throw new Error("Expected three service-area candidates.");
  }

  await replaceArea(sql, outside, baseA, 1, 2, []);
  await replaceArea(sql, additional, baseA, 1, null, [baseB]);
  await replaceArea(sql, farther, baseB, 1, 20, []);

  const repository = createCraftsmanServiceAreaMatchRepository(sql);
  const fromA = await okMatches(
    repository.findMatches({
      includeOutsideDeclaredArea: false,
      limit: 100,
      municipalityCode: baseA,
    }),
  );
  expect(kindOf(fromA, outside.profileId)).toBe("WITHIN_NORMAL_RADIUS");
  expect(kindOf(fromA, additional.profileId)).toBe("WITHIN_NORMAL_RADIUS");
  expect(kindOf(fromA, farther.profileId)).toBe("WITHIN_MAXIMUM_RADIUS");
  expect(indexOf(fromA, farther.profileId)).toBeGreaterThan(
    indexOf(fromA, outside.profileId),
  );

  const fromBDefault = await okMatches(
    repository.findMatches({
      includeOutsideDeclaredArea: false,
      limit: 100,
      municipalityCode: baseB,
    }),
  );
  expect(kindOf(fromBDefault, additional.profileId)).toBe(
    "ADDITIONAL_SERVICE_AREA",
  );
  expect(kindOf(fromBDefault, farther.profileId)).toBe("WITHIN_NORMAL_RADIUS");
  expect(kindOf(fromBDefault, outside.profileId)).toBeUndefined();

  const fromBExpanded = await okMatches(
    repository.findMatches({
      includeOutsideDeclaredArea: true,
      limit: 100,
      municipalityCode: baseB,
    }),
  );
  expect(kindOf(fromBExpanded, outside.profileId)).toBe(
    "OUTSIDE_DECLARED_AREA",
  );
  expect(indexOf(fromBExpanded, outside.profileId)).toBeGreaterThan(
    indexOf(fromBExpanded, additional.profileId),
  );

  const neutral = await okMatches(
    repository.findMatches({
      includeOutsideDeclaredArea: false,
      limit: 100,
      municipalityCode: null,
    }),
  );
  const ownNeutral = neutral.filter(({ craftsmanProfileId }) =>
    fixtures.some(({ profileId }) => profileId === craftsmanProfileId),
  );
  expect(ownNeutral).toHaveLength(3);
  expect(
    ownNeutral.every(
      ({ approximateDistanceKm, matchKind, rankingDistanceMeters }) =>
        matchKind === "DISTANCE_UNAVAILABLE" &&
        approximateDistanceKm === null &&
        rankingDistanceMeters === null,
    ),
  ).toBe(true);
  expect(
    ownNeutral.map(({ craftsmanProfileId }) => craftsmanProfileId),
  ).toEqual(
    [...ownNeutral.map(({ craftsmanProfileId }) => craftsmanProfileId)].sort(),
  );

  await assertVisibilityGates(sql, repository, baseA, farther);
  await assertRawSqlPrivacy(sql, baseB, outside.profileId);
}

async function replaceArea(
  sql: Sql,
  candidate: CandidateFixture,
  baseMunicipalityCode: MunicipalityCode,
  normalRadiusKm: number,
  maximumRadiusKm: number | null,
  extraMunicipalityCodes: readonly MunicipalityCode[],
): Promise<void> {
  const result = await createCraftsmanServiceAreaRepository(
    sql,
  ).replaceOwnedDraft({
    actorUserId: candidate.ownerId,
    baseMunicipalityCode,
    commandId: randomUUID(),
    craftsmanProfileId: candidate.profileId,
    expectedRevision: candidate.serviceAreaRevision,
    extraMunicipalityCodes,
    maximumRadiusKm,
    normalRadiusKm,
    travelFeePolicy: null,
    travelFeeThresholdKm: null,
  });
  expect(result.status).toBe("APPLIED");
  if (result.status === "APPLIED") {
    candidate.serviceAreaRevision = result.serviceArea.revision;
  }
}

async function assertVisibilityGates(
  sql: Sql,
  repository: ReturnType<typeof createCraftsmanServiceAreaMatchRepository>,
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
    await expectAbsent(repository, origin, candidate.profileId);
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
    await expectAbsent(repository, origin, candidate.profileId);
  } finally {
    await setAccountState(sql, candidate.ownerId, "ACTIVE");
  }
}

async function assertRawSqlPrivacy(
  sql: Sql,
  origin: MunicipalityCode,
  outsideProfileId: CraftsmanProfileId,
): Promise<void> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM craftsman_service_area_match_facts(${origin}, true)
  `;
  expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
    "approximate_distance_km",
    "craftsman_profile_id",
    "match_kind",
    "ranking_distance_meters",
  ]);
  expect(JSON.stringify(rows)).not.toMatch(
    /owner|centroid|latitude|longitude|coordinate|address|street|postal|email|phone|travel_fee|policy/iu,
  );
  const defaultRows = await sql<{ readonly craftsmanProfileId: string }[]>`
    SELECT craftsman_profile_id AS "craftsmanProfileId"
    FROM craftsman_service_area_match_facts(${origin}, NULL)
  `;
  expect(
    defaultRows.some(
      ({ craftsmanProfileId }) => craftsmanProfileId === outsideProfileId,
    ),
  ).toBe(false);
  await expect(
    sql`SELECT * FROM craftsman_service_area_match_facts('US:OUTSIDE', true)`,
  ).resolves.toEqual([]);
}

async function expectAbsent(
  repository: ReturnType<typeof createCraftsmanServiceAreaMatchRepository>,
  origin: MunicipalityCode,
  profileId: CraftsmanProfileId,
): Promise<void> {
  const matches = await okMatches(
    repository.findMatches({
      includeOutsideDeclaredArea: true,
      limit: 100,
      municipalityCode: origin,
    }),
  );
  expect(
    matches.every(({ craftsmanProfileId }) => craftsmanProfileId !== profileId),
  ).toBe(true);
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

async function okMatches(
  result: ReturnType<
    ReturnType<typeof createCraftsmanServiceAreaMatchRepository>["findMatches"]
  >,
) {
  const resolved = await result;
  expect(resolved.status).toBe("OK");
  if (resolved.status !== "OK")
    throw new Error("Expected service-area matches.");
  return resolved.matches;
}

function kindOf(
  matches: readonly {
    readonly craftsmanProfileId: string;
    readonly matchKind: string;
  }[],
  profileId: CraftsmanProfileId,
): string | undefined {
  return matches.find(
    ({ craftsmanProfileId }) => craftsmanProfileId === profileId,
  )?.matchKind;
}

function indexOf(
  matches: readonly { readonly craftsmanProfileId: string }[],
  profileId: CraftsmanProfileId,
): number {
  return matches.findIndex(
    ({ craftsmanProfileId }) => craftsmanProfileId === profileId,
  );
}

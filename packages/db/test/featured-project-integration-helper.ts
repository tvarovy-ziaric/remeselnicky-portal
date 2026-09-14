import { randomUUID } from "node:crypto";

import type {
  CraftsmanProfessionId,
  CraftsmanProfileId,
  PortfolioProjectId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCraftsmanProfessionRepository } from "../src/craftsman-profession-repository.js";
import { createFeaturedProjectRepository } from "../src/featured-project-repository.js";
import { createPortfolioProjectRepository } from "../src/portfolio-project-repository.js";

/** Runs after governed taxonomy/location fixtures and migrations through 0027. */
export async function runFeaturedProjectIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [taxonomy] = await sql<{ readonly releaseId: string }[]>`
    SELECT release_id AS "releaseId" FROM profession_taxonomy_activation_events
    ORDER BY activation_sequence DESC LIMIT 1
  `;
  const [location] = await sql<
    { readonly districtCode: string; readonly municipalityCode: string }[]
  >`
    SELECT municipality.code AS "municipalityCode",
      municipality.district_code AS "districtCode"
    FROM location_municipalities municipality
    JOIN location_districts district ON district.code = municipality.district_code
    WHERE municipality.is_active AND district.is_active
    ORDER BY municipality.code LIMIT 1
  `;
  if (taxonomy === undefined || location === undefined) {
    throw new Error("Expected featured-project governed fixtures.");
  }

  const owner = await createProfileOwner(sql);
  const foreign = await createProfileOwner(sql);
  const professions = createCraftsmanProfessionRepository(sql);
  const professionId = await assignProfession(
    professions,
    owner,
    taxonomy.releaseId,
  );
  const foreignProfessionId = await assignProfession(
    professions,
    foreign,
    taxonomy.releaseId,
  );
  const projects = createPortfolioProjectRepository(sql);
  const ownProjectIds: PortfolioProjectId[] = [];
  for (let index = 0; index < 6; index += 1) {
    ownProjectIds.push(
      await createProject(projects, owner, professionId, location, index),
    );
  }
  const foreignProjectId = await createProject(
    projects,
    foreign,
    foreignProfessionId,
    location,
    99,
  );

  const featured = createFeaturedProjectRepository(sql);
  const firstCommandId = randomUUID();
  const firstInput = {
    actorUserId: owner.userId,
    commandId: firstCommandId,
    craftsmanProfileId: owner.profileId,
    expectedRevision: 0,
    portfolioProjectId: ownProjectIds[0]!,
  };
  await expect(
    featured.pin({ ...firstInput, actorUserId: foreign.userId }),
  ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
  await expect(
    featured.pin({
      ...firstInput,
      commandId: randomUUID(),
      portfolioProjectId: foreignProjectId,
    }),
  ).resolves.toEqual({ status: "PROJECT_UNAVAILABLE" });

  const exactRace = await Promise.all([
    featured.pin(firstInput),
    featured.pin(firstInput),
  ]);
  expect(exactRace.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "DEDUPLICATED",
  ]);
  await expect(
    featured.pin({
      ...firstInput,
      commandId: randomUUID(),
      expectedRevision: 1,
    }),
  ).resolves.toEqual({ status: "PROJECT_ALREADY_FEATURED" });

  await expect(
    featured.pin({
      ...firstInput,
      commandId: randomUUID(),
      expectedRevision: 1,
      portfolioProjectId: ownProjectIds[1]!,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });

  const competing = [ownProjectIds[2]!, ownProjectIds[3]!].map(
    (portfolioProjectId) => ({
      ...firstInput,
      commandId: randomUUID(),
      expectedRevision: 2,
      portfolioProjectId,
    }),
  );
  const fourthRace = await Promise.all(
    competing.map((input) => featured.pin(input)),
  );
  expect(fourthRace.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "STALE_REVISION",
  ]);
  const winnerIndex = fourthRace.findIndex(
    ({ status }) => status === "APPLIED",
  );
  if (winnerIndex < 0) throw new Error("Expected featured race winner.");
  const winnerId = competing[winnerIndex]!.portfolioProjectId;
  const spareId = competing[1 - winnerIndex]!.portfolioProjectId;
  await expect(
    featured.pin({
      ...firstInput,
      commandId: randomUUID(),
      expectedRevision: 3,
      portfolioProjectId: ownProjectIds[4]!,
    }),
  ).resolves.toEqual({ status: "FEATURED_LIMIT_REACHED" });

  const ordered = [winnerId, ownProjectIds[1]!, ownProjectIds[0]!] as const;
  await expect(
    featured.reorder({
      actorUserId: owner.userId,
      commandId: randomUUID(),
      craftsmanProfileId: owner.profileId,
      expectedRevision: 2,
      orderedPortfolioProjectIds: ordered,
    }),
  ).resolves.toEqual({ status: "STALE_REVISION" });
  await expect(
    featured.reorder({
      actorUserId: owner.userId,
      commandId: randomUUID(),
      craftsmanProfileId: owner.profileId,
      expectedRevision: 3,
      orderedPortfolioProjectIds: [winnerId, ownProjectIds[1]!],
    }),
  ).resolves.toEqual({ status: "INVALID_ORDER" });
  const reordered = await featured.reorder({
    actorUserId: owner.userId,
    commandId: randomUUID(),
    craftsmanProfileId: owner.profileId,
    expectedRevision: 3,
    orderedPortfolioProjectIds: ordered,
  });
  expect(reordered).toMatchObject({
    featured: {
      items: [
        { portfolioProjectId: winnerId, position: 1 },
        { portfolioProjectId: ownProjectIds[1], position: 2 },
        { portfolioProjectId: ownProjectIds[0], position: 3 },
      ],
      revision: 4,
    },
    status: "APPLIED",
  });

  await expect(
    projects.hide({
      actorUserId: owner.userId,
      commandId: randomUUID(),
      craftsmanProfileId: owner.profileId,
      expectedRevision: 1,
      portfolioProjectId: ownProjectIds[0]!,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const privateAfterHide = await featured.listOwned({
    actorUserId: owner.userId,
    craftsmanProfileId: owner.profileId,
  });
  expect(
    privateAfterHide?.items.find(
      ({ portfolioProjectId }) => portfolioProjectId === ownProjectIds[0],
    ),
  ).toEqual({
    availability: "UNAVAILABLE",
    portfolioProjectId: ownProjectIds[0],
    position: 3,
    title: null,
  });
  await expect(featured.pin(firstInput)).resolves.toMatchObject({
    featured: {
      items: [
        {
          availability: "UNAVAILABLE",
          portfolioProjectId: ownProjectIds[0],
          title: null,
        },
      ],
      revision: 1,
    },
    status: "DEDUPLICATED",
  });
  await expect(
    featured.unpin({
      actorUserId: owner.userId,
      commandId: randomUUID(),
      craftsmanProfileId: owner.profileId,
      expectedRevision: 4,
      portfolioProjectId: ownProjectIds[0]!,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const current = await featured.listOwned({
    actorUserId: owner.userId,
    craftsmanProfileId: owner.profileId,
  });
  if (current === null) throw new Error("Expected current featured set.");
  expect(current.revision).toBe(5);
  expect(() =>
    featured.reorder({
      actorUserId: owner.userId,
      commandId: randomUUID(),
      craftsmanProfileId: owner.profileId,
      expectedRevision: current.revision,
      orderedPortfolioProjectIds: [winnerId, winnerId],
    }),
  ).toThrow(/INVALID_FEATURED_PROJECT_COMMAND|Invalid featured project/u);

  await expect(
    projects.hide({
      actorUserId: owner.userId,
      commandId: randomUUID(),
      craftsmanProfileId: owner.profileId,
      expectedRevision: 1,
      portfolioProjectId: ownProjectIds[5]!,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    projects.archive({
      actorUserId: owner.userId,
      commandId: randomUUID(),
      craftsmanProfileId: owner.profileId,
      expectedRevision: 1,
      portfolioProjectId: ownProjectIds[4]!,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  for (const unavailableId of [ownProjectIds[5]!, ownProjectIds[4]!]) {
    await expect(
      featured.pin({
        ...firstInput,
        commandId: randomUUID(),
        expectedRevision: current.revision,
        portfolioProjectId: unavailableId,
      }),
    ).resolves.toEqual({ status: "PROJECT_UNAVAILABLE" });
  }

  const overflowProjectId = await createProject(
    projects,
    owner,
    professionId,
    location,
    6,
  );

  await runFeaturedRawSqlNegatives(sql, {
    actorUserId: owner.userId,
    craftsmanProfileId: owner.profileId,
    currentProjectIds: current.items.map(
      ({ portfolioProjectId }) => portfolioProjectId,
    ),
    currentRevision: current.revision,
    foreignProjectId,
    overflowProjectId,
    spareProjectId: spareId,
  });
  await runFeaturedSuspensionRace(sql, featured, owner, current);
}

async function runFeaturedRawSqlNegatives(
  sql: Sql,
  fixture: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly currentProjectIds: readonly PortfolioProjectId[];
    readonly currentRevision: number;
    readonly foreignProjectId: PortfolioProjectId;
    readonly overflowProjectId: PortfolioProjectId;
    readonly spareProjectId: PortfolioProjectId;
  },
): Promise<void> {
  const four = [
    ...fixture.currentProjectIds,
    fixture.spareProjectId,
    fixture.overflowProjectId,
  ];
  await expect(sql`
    INSERT INTO featured_project_commands (
      command_id, command_kind, craftsman_profile_id, actor_user_id,
      expected_revision, resulting_revision, target_project_id,
      resulting_project_ids, payload_fingerprint
    ) VALUES (${randomUUID()}, 'PIN', ${fixture.craftsmanProfileId},
      ${fixture.actorUserId}, ${fixture.currentRevision},
      ${fixture.currentRevision + 1}, ${fixture.spareProjectId}, ${four},
      ${"0".repeat(64)})
  `).rejects.toThrow(/max_three_unique/u);
  await expect(sql`
    INSERT INTO featured_project_commands (
      command_id, command_kind, craftsman_profile_id, actor_user_id,
      expected_revision, resulting_revision, resulting_project_ids,
      payload_fingerprint
    ) VALUES (${randomUUID()}, 'REORDER', ${fixture.craftsmanProfileId},
      ${fixture.actorUserId}, ${fixture.currentRevision},
      ${fixture.currentRevision + 1},
      ${[fixture.currentProjectIds[0]!, fixture.currentProjectIds[0]!]},
      ${"9".repeat(64)})
  `).rejects.toThrow(/max_three_unique/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO featured_project_commands (
          command_id, command_kind, craftsman_profile_id, actor_user_id,
          expected_revision, resulting_revision, target_project_id,
          resulting_project_ids, payload_fingerprint
        ) VALUES (${randomUUID()}, 'PIN', ${fixture.craftsmanProfileId},
          ${fixture.actorUserId}, ${fixture.currentRevision},
          ${fixture.currentRevision + 1}, ${fixture.foreignProjectId},
          ${[...fixture.currentProjectIds, fixture.foreignProjectId]},
          ${"1".repeat(64)})
      `;
    }),
  ).rejects.toThrow(/owned current draft featured projects required/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        UPDATE featured_project_sets SET revision = revision + 1
        WHERE craftsman_profile_id = ${fixture.craftsmanProfileId}
      `;
    }),
  ).rejects.toThrow(/requires matching command/u);
  await expect(sql`
    DELETE FROM featured_project_revisions
    WHERE craftsman_profile_id = ${fixture.craftsmanProfileId}
  `).rejects.toThrow(/append-only/u);
  await expect(sql`
    UPDATE featured_project_revisions SET project_ids = '{}'
    WHERE craftsman_profile_id = ${fixture.craftsmanProfileId}
  `).rejects.toThrow(/append-only/u);

  const orphanCommandId = randomUUID();
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO featured_project_commands (
          command_id, command_kind, craftsman_profile_id, actor_user_id,
          expected_revision, resulting_revision, target_project_id,
          resulting_project_ids, payload_fingerprint
        ) VALUES (${orphanCommandId}, 'PIN', ${fixture.craftsmanProfileId},
          ${fixture.actorUserId}, ${fixture.currentRevision},
          ${fixture.currentRevision + 1}, ${fixture.spareProjectId},
          ${[...fixture.currentProjectIds, fixture.spareProjectId]},
          ${"2".repeat(64)})
      `;
    }),
  ).rejects.toThrow(/requires exact set and revision effects/u);

  const [revisionOne] = await sql<{ readonly projectIds: readonly string[] }[]>`
    SELECT project_ids AS "projectIds" FROM featured_project_revisions
    WHERE craftsman_profile_id = ${fixture.craftsmanProfileId} AND revision = 1
  `;
  expect(revisionOne?.projectIds).toHaveLength(1);
}

async function runFeaturedSuspensionRace(
  sql: Sql,
  featured: ReturnType<typeof createFeaturedProjectRepository>,
  owner: { readonly profileId: CraftsmanProfileId; readonly userId: UserId },
  current: NonNullable<Awaited<ReturnType<typeof featured.listOwned>>>,
): Promise<void> {
  const ordered = [
    ...current.items.map(({ portfolioProjectId }) => portfolioProjectId),
  ].reverse();
  const command = {
    actorUserId: owner.userId,
    commandId: randomUUID(),
    craftsmanProfileId: owner.profileId,
    expectedRevision: current.revision,
    orderedPortfolioProjectIds: ordered,
  };
  const [before] = await sql<{ readonly count: number }[]>`
    SELECT count(*)::integer AS count FROM featured_project_commands
    WHERE craftsman_profile_id = ${owner.profileId}
  `;
  if (before === undefined) throw new Error("Expected featured baseline.");
  const [result] = await Promise.all([
    featured.reorder(command),
    sql.begin(async (transaction) => {
      await transaction`SELECT id FROM users WHERE id = ${owner.userId} FOR UPDATE`;
      await transaction`
        UPDATE users SET account_state = 'SUSPENDED',
          account_state_changed_at = changed.at, updated_at = changed.at
        FROM (SELECT clock_timestamp() AS at) changed
        WHERE users.id = ${owner.userId}
      `;
    }),
  ]);
  expect(["APPLIED", "PROFILE_UNAVAILABLE"]).toContain(result.status);
  const [after] = await sql<{ readonly count: number }[]>`
    SELECT count(*)::integer AS count FROM featured_project_commands
    WHERE craftsman_profile_id = ${owner.profileId}
  `;
  if (after === undefined) throw new Error("Expected featured race evidence.");
  expect(after.count - before.count).toBe(result.status === "APPLIED" ? 1 : 0);
  await expect(featured.reorder(command)).resolves.toEqual({
    status: "PROFILE_UNAVAILABLE",
  });
  await expect(
    featured.listOwned({
      actorUserId: owner.userId,
      craftsmanProfileId: owner.profileId,
    }),
  ).resolves.toBeNull();
}

async function createProfileOwner(sql: Sql): Promise<{
  readonly profileId: CraftsmanProfileId;
  readonly userId: UserId;
}> {
  const [user] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (user === undefined) throw new Error("Expected featured owner.");
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${user.id}, 'INDIVIDUAL') RETURNING id
  `;
  if (profile === undefined) throw new Error("Expected featured profile.");
  return { profileId: profile.id, userId: user.id };
}

async function assignProfession(
  repository: ReturnType<typeof createCraftsmanProfessionRepository>,
  owner: { readonly profileId: CraftsmanProfileId; readonly userId: UserId },
  taxonomyReleaseId: string,
): Promise<CraftsmanProfessionId> {
  const id = randomUUID() as CraftsmanProfessionId;
  await expect(
    repository.assign({
      actorUserId: owner.userId,
      commandId: randomUUID(),
      craftsmanProfessionId: id,
      craftsmanProfileId: owner.profileId,
      declaredLevel: "BEGINNER",
      professionCode: "TEST:CAPABILITY_ALPHA",
      taxonomyReleaseId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  return id;
}

async function createProject(
  repository: ReturnType<typeof createPortfolioProjectRepository>,
  owner: { readonly profileId: CraftsmanProfileId; readonly userId: UserId },
  professionId: CraftsmanProfessionId,
  location: {
    readonly districtCode: string;
    readonly municipalityCode: string;
  },
  index: number,
): Promise<PortfolioProjectId> {
  const id = randomUUID() as PortfolioProjectId;
  await expect(
    repository.create({
      actorUserId: owner.userId,
      commandId: randomUUID(),
      contribution: null,
      craftsmanProfileId: owner.profileId,
      districtCode: location.districtCode,
      durationUnit: null,
      durationValue: null,
      indicativePriceMaxCents: null,
      indicativePriceMinCents: null,
      materialsAndTechnologies: null,
      municipalityCode: location.municipalityCode,
      portfolioProjectId: id,
      problem: null,
      professionIds: [professionId],
      shortDescription: `Bezpečný súkromný opis realizácie číslo ${index}`,
      skillIds: [],
      solution: null,
      specializationIds: [],
      title: `Realizácia číslo ${index}`,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  return id;
}

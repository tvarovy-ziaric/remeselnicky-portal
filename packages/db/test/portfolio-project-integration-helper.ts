import { randomUUID } from "node:crypto";

import type {
  CraftsmanProfessionId,
  CraftsmanProfileId,
  CraftsmanSkillId,
  CraftsmanSpecializationId,
  PortfolioProjectId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCraftsmanCapabilityRepository } from "../src/craftsman-capability-repository.js";
import { createCraftsmanProfessionRepository } from "../src/craftsman-profession-repository.js";
import { createPortfolioProjectRepository } from "../src/portfolio-project-repository.js";

/**
 * Runs after the R1-004/R1-005/R1-006 helpers in the clean migration test.
 * Those helpers supply synthetic governed taxonomy/catalog/location rows only.
 */
export async function runPortfolioProjectIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [taxonomy] = await sql<{ readonly releaseId: string }[]>`
    SELECT release_id AS "releaseId" FROM profession_taxonomy_activation_events
    ORDER BY activation_sequence DESC LIMIT 1
  `;
  const [catalog] = await sql<{ readonly releaseId: string }[]>`
    SELECT release_id AS "releaseId" FROM skill_catalog_activation_events
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
  await sql`
    INSERT INTO location_districts (
      code, region_code, name_sk, source_reference, source_revision
    )
    SELECT 'TEST:DISTRICT_PORTFOLIO_OTHER', district.region_code,
      'Iný testovací okres', 'test-fixture:R1-013', 'synthetic-v1'
    FROM location_districts district
    WHERE district.code = ${location?.districtCode ?? ""}
    ON CONFLICT (code) DO NOTHING
  `;
  const [otherDistrict] = await sql<{ readonly code: string }[]>`
    SELECT code FROM location_districts
    WHERE is_active AND code = 'TEST:DISTRICT_PORTFOLIO_OTHER'
  `;
  if (
    taxonomy === undefined ||
    catalog === undefined ||
    location === undefined ||
    otherDistrict === undefined
  ) {
    throw new Error("Expected governed taxonomy, skill and location fixtures.");
  }

  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  const [nonOwner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined || nonOwner === undefined) {
    throw new Error("Expected portfolio users.");
  }
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${owner.id}, 'INDIVIDUAL') RETURNING id
  `;
  const [foreignProfile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${nonOwner.id}, 'INDIVIDUAL') RETURNING id
  `;
  if (profile === undefined || foreignProfile === undefined) {
    throw new Error("Expected portfolio profiles.");
  }

  const professions = createCraftsmanProfessionRepository(sql);
  const capabilities = createCraftsmanCapabilityRepository(sql);
  const alphaProfessionId = randomUUID() as CraftsmanProfessionId;
  const betaProfessionId = randomUUID() as CraftsmanProfessionId;
  const foreignProfessionId = randomUUID() as CraftsmanProfessionId;
  await assignProfession(
    professions,
    owner.id,
    profile.id,
    alphaProfessionId,
    taxonomy.releaseId,
    "TEST:CAPABILITY_ALPHA",
  );
  await assignProfession(
    professions,
    owner.id,
    profile.id,
    betaProfessionId,
    taxonomy.releaseId,
    "TEST:CAPABILITY_BETA",
  );
  await assignProfession(
    professions,
    nonOwner.id,
    foreignProfile.id,
    foreignProfessionId,
    taxonomy.releaseId,
    "TEST:CAPABILITY_ALPHA",
  );

  const skillId = randomUUID() as CraftsmanSkillId;
  const specializationId = randomUUID() as CraftsmanSpecializationId;
  const foreignSkillId = randomUUID() as CraftsmanSkillId;
  const foreignSpecializationId = randomUUID() as CraftsmanSpecializationId;
  await expect(
    capabilities.addSkill({
      actorUserId: owner.id,
      canonicalSkillCode: "TEST:CAPABILITY_SKILL",
      commandId: randomUUID(),
      craftsmanProfileId: profile.id,
      craftsmanSkillId: skillId,
      identityKind: "CANONICAL",
      professionIds: [alphaProfessionId, betaProfessionId],
      skillCatalogReleaseId: catalog.releaseId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    capabilities.addSpecialization({
      actorUserId: owner.id,
      commandId: randomUUID(),
      craftsmanProfileId: profile.id,
      craftsmanProfessionId: alphaProfessionId,
      craftsmanSpecializationId: specializationId,
      specializationCode: "TEST:CAPABILITY_SPECIALIZATION",
      taxonomyReleaseId: taxonomy.releaseId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    capabilities.addSkill({
      actorUserId: nonOwner.id,
      canonicalSkillCode: "TEST:CAPABILITY_SKILL",
      commandId: randomUUID(),
      craftsmanProfileId: foreignProfile.id,
      craftsmanSkillId: foreignSkillId,
      identityKind: "CANONICAL",
      professionIds: [foreignProfessionId],
      skillCatalogReleaseId: catalog.releaseId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    capabilities.addSpecialization({
      actorUserId: nonOwner.id,
      commandId: randomUUID(),
      craftsmanProfileId: foreignProfile.id,
      craftsmanProfessionId: foreignProfessionId,
      craftsmanSpecializationId: foreignSpecializationId,
      specializationCode: "TEST:CAPABILITY_SPECIALIZATION",
      taxonomyReleaseId: taxonomy.releaseId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });

  const repository = createPortfolioProjectRepository(sql);
  const projectId = randomUUID() as PortfolioProjectId;
  const createCommandId = randomUUID();
  const createInput = projectInput({
    actorUserId: owner.id,
    commandId: createCommandId,
    craftsmanProfileId: profile.id,
    districtCode: location.districtCode,
    municipalityCode: location.municipalityCode,
    portfolioProjectId: projectId,
    professionIds: [alphaProfessionId],
    skillIds: [skillId],
    specializationIds: [specializationId],
  });
  await expect(
    repository.create({ ...createInput, actorUserId: nonOwner.id }),
  ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
  await expect(
    repository.create({
      ...createInput,
      commandId: randomUUID(),
      districtCode: otherDistrict.code,
      portfolioProjectId: randomUUID() as PortfolioProjectId,
    }),
  ).resolves.toEqual({ status: "LOCATION_UNAVAILABLE" });
  for (const foreignTag of [
    { professionIds: [foreignProfessionId] },
    { skillIds: [foreignSkillId] },
    { specializationIds: [foreignSpecializationId] },
  ]) {
    await expect(
      repository.create({
        ...createInput,
        ...foreignTag,
        commandId: randomUUID(),
        portfolioProjectId: randomUUID() as PortfolioProjectId,
      }),
    ).resolves.toEqual({ status: "TAG_UNAVAILABLE" });
  }

  const createRace = await Promise.all([
    repository.create(createInput),
    repository.create(createInput),
  ]);
  expect(createRace.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "DEDUPLICATED",
  ]);
  const created = createRace.find(({ status }) => status === "APPLIED");
  if (created?.status !== "APPLIED")
    throw new Error("Expected applied project.");
  expect(created.project).toMatchObject({
    evidenceStatus: "UNVERIFIED",
    provenanceKind: "SELF_DECLARED",
    recordState: "DRAFT",
    revision: 1,
  });
  expect(created.project).not.toHaveProperty("payloadFingerprint");
  expect(created.project).not.toHaveProperty("actorUserId");

  const editCommandId = randomUUID();
  const edits = await Promise.all([
    repository.edit({
      ...createInput,
      commandId: editCommandId,
      expectedRevision: 1,
      shortDescription: "Aktualizovaný bezpečný opis staršej realizácie",
    }),
    repository.edit({
      ...createInput,
      commandId: randomUUID(),
      expectedRevision: 1,
      shortDescription: "Konkurenčný bezpečný opis staršej realizácie",
    }),
  ]);
  expect(edits.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "STALE_REVISION",
  ]);
  await expect(repository.create(createInput)).resolves.toMatchObject({
    project: { revision: 1, shortDescription: createInput.shortDescription },
    status: "DEDUPLICATED",
  });

  await runRawSqlBoundaryAssertions(sql, {
    alphaProfessionId,
    foreignProfessionId,
    foreignSkillId,
    foreignSpecializationId,
    location,
    otherDistrictCode: otherDistrict.code,
    ownerUserId: owner.id,
    profileId: profile.id,
    projectId,
    skillId,
    specializationId,
  });

  const current = await repository.listOwned({
    actorUserId: owner.id,
    craftsmanProfileId: profile.id,
  });
  const currentProject = current.find(({ id }) => id === projectId);
  if (currentProject === undefined)
    throw new Error("Expected current project.");

  await expect(
    professions.deactivate({
      actorUserId: owner.id,
      commandId: randomUUID(),
      craftsmanProfessionId: betaProfessionId,
      craftsmanProfileId: profile.id,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    repository.edit({
      ...createInput,
      commandId: randomUUID(),
      expectedRevision: currentProject.revision,
      professionIds: [alphaProfessionId, betaProfessionId],
      shortDescription: "Pokus pridať neaktívne remeslo do realizácie",
    }),
  ).resolves.toEqual({ status: "TAG_UNAVAILABLE" });

  await expect(
    professions.deactivate({
      actorUserId: owner.id,
      commandId: randomUUID(),
      craftsmanProfessionId: alphaProfessionId,
      craftsmanProfileId: profile.id,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const preservedEdit = await repository.edit({
    ...createInput,
    commandId: randomUUID(),
    expectedRevision: currentProject.revision,
    shortDescription: "Opis upravený so zachovaným historickým remeslom",
  });
  expect(preservedEdit).toMatchObject({ status: "APPLIED" });
  if (preservedEdit.status !== "APPLIED") {
    throw new Error("Expected historical tag preservation.");
  }

  const hideInput = {
    actorUserId: owner.id,
    commandId: randomUUID(),
    craftsmanProfileId: profile.id,
    expectedRevision: preservedEdit.project.revision,
    portfolioProjectId: projectId,
  } as const;
  const hidden = await repository.hide(hideInput);
  expect(hidden).toMatchObject({
    project: { recordState: "HIDDEN" },
    status: "APPLIED",
  });
  if (hidden.status !== "APPLIED") throw new Error("Expected hidden project.");
  const restored = await repository.restoreDraft({
    ...hideInput,
    commandId: randomUUID(),
    expectedRevision: hidden.project.revision,
  });
  expect(restored).toMatchObject({
    project: { recordState: "DRAFT" },
    status: "APPLIED",
  });
  if (restored.status !== "APPLIED")
    throw new Error("Expected restored draft.");
  const archived = await repository.archive({
    ...hideInput,
    commandId: randomUUID(),
    expectedRevision: restored.project.revision,
  });
  expect(archived).toMatchObject({
    project: { recordState: "ARCHIVED" },
    status: "APPLIED",
  });

  await expect(sql`
    DELETE FROM portfolio_project_revisions WHERE portfolio_project_id = ${projectId}
  `).rejects.toThrow(/append-only/u);
  await expect(sql`
    UPDATE portfolio_projects SET author_user_id = ${nonOwner.id}
    WHERE id = ${projectId}
  `).rejects.toThrow(/authorship and provenance are immutable/u);
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO portfolio_projects (
          id, craftsman_profile_id, author_user_id, title, short_description,
          profession_ids, latest_command_id
        ) VALUES (${randomUUID()}, ${foreignProfile.id}, ${nonOwner.id},
          'Volajte +421 900 123 456', 'Dostatočne dlhý bezpečný opis',
          ${[foreignProfessionId]}, ${randomUUID()})
      `;
    }),
  ).rejects.toThrow(/portfolio_projects_title_safe/u);

  await runSuspensionRace(sql, taxonomy.releaseId, repository, professions);
}

async function runRawSqlBoundaryAssertions(
  sql: Sql,
  fixture: {
    readonly alphaProfessionId: CraftsmanProfessionId;
    readonly foreignProfessionId: CraftsmanProfessionId;
    readonly foreignSkillId: CraftsmanSkillId;
    readonly foreignSpecializationId: CraftsmanSpecializationId;
    readonly location: {
      readonly districtCode: string;
      readonly municipalityCode: string;
    };
    readonly otherDistrictCode: string;
    readonly ownerUserId: UserId;
    readonly profileId: CraftsmanProfileId;
    readonly projectId: PortfolioProjectId;
    readonly skillId: CraftsmanSkillId;
    readonly specializationId: CraftsmanSpecializationId;
  },
): Promise<void> {
  const validInsert = {
    description: "Bezpečný opis databázovej obchádzky realizácie",
    title: "Databázová skúška realizácie",
  } as const;

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO portfolio_projects (
          id, craftsman_profile_id, author_user_id, title, short_description,
          profession_ids, latest_command_id
        ) VALUES (${randomUUID()}, ${fixture.profileId}, ${fixture.ownerUserId},
          ${validInsert.title}, ${validInsert.description},
          ${[fixture.foreignProfessionId]}, ${randomUUID()})
      `;
    }),
  ).rejects.toThrow(/owned relevant profession tags required/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO portfolio_projects (
          id, craftsman_profile_id, author_user_id, title, short_description,
          profession_ids, skill_ids, latest_command_id
        ) VALUES (${randomUUID()}, ${fixture.profileId}, ${fixture.ownerUserId},
          ${validInsert.title}, ${validInsert.description},
          ${[fixture.alphaProfessionId]}, ${[fixture.foreignSkillId]}, ${randomUUID()})
      `;
    }),
  ).rejects.toThrow(/owned relevant skill tags required/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO portfolio_projects (
          id, craftsman_profile_id, author_user_id, title, short_description,
          profession_ids, specialization_ids, latest_command_id
        ) VALUES (${randomUUID()}, ${fixture.profileId}, ${fixture.ownerUserId},
          ${validInsert.title}, ${validInsert.description},
          ${[fixture.alphaProfessionId]}, ${[fixture.foreignSpecializationId]},
          ${randomUUID()})
      `;
    }),
  ).rejects.toThrow(/owned relevant specialization tags required/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO portfolio_projects (
          id, craftsman_profile_id, author_user_id, title, short_description,
          municipality_code, district_code, profession_ids, skill_ids,
          specialization_ids, latest_command_id
        ) VALUES (${randomUUID()}, ${fixture.profileId}, ${fixture.ownerUserId},
          ${validInsert.title}, ${validInsert.description},
          ${fixture.location.municipalityCode}, ${fixture.otherDistrictCode},
          ${[fixture.alphaProfessionId]}, ${[fixture.skillId]},
          ${[fixture.specializationId]}, ${randomUUID()})
      `;
    }),
  ).rejects.toThrow(/active approximate municipality required/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        UPDATE portfolio_projects
        SET short_description = 'Priama zmena obsahu bez príkazu'
        WHERE id = ${fixture.projectId}
      `;
    }),
  ).rejects.toThrow(/portfolio update requires matching command provenance/u);
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        UPDATE portfolio_projects SET record_state = 'HIDDEN'
        WHERE id = ${fixture.projectId}
      `;
    }),
  ).rejects.toThrow(/portfolio update requires matching command provenance/u);

  const orphanProjectId = randomUUID();
  const orphanCommandId = randomUUID();
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO portfolio_projects (
          id, craftsman_profile_id, author_user_id, title, short_description,
          profession_ids, skill_ids, specialization_ids, latest_command_id
        ) VALUES (${orphanProjectId}, ${fixture.profileId}, ${fixture.ownerUserId},
          ${validInsert.title}, ${validInsert.description},
          ${[fixture.alphaProfessionId]}, ${[fixture.skillId]},
          ${[fixture.specializationId]}, ${orphanCommandId})
      `;
      await transaction`
        INSERT INTO portfolio_project_commands (
          command_id, command_kind, portfolio_project_id,
          craftsman_profile_id, actor_user_id, expected_revision,
          resulting_revision, payload_fingerprint
        ) VALUES (${orphanCommandId}, 'CREATE', ${orphanProjectId},
          ${fixture.profileId}, ${fixture.ownerUserId}, 0, 1,
          ${"0".repeat(64)})
      `;
    }),
  ).rejects.toThrow(
    /portfolio command requires exact project and revision effects/u,
  );
}

async function runSuspensionRace(
  sql: Sql,
  taxonomyReleaseId: string,
  repository: ReturnType<typeof createPortfolioProjectRepository>,
  professions: ReturnType<typeof createCraftsmanProfessionRepository>,
): Promise<void> {
  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined) throw new Error("Expected race owner.");
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${owner.id}, 'INDIVIDUAL') RETURNING id
  `;
  if (profile === undefined) throw new Error("Expected race profile.");
  const professionId = randomUUID() as CraftsmanProfessionId;
  await assignProfession(
    professions,
    owner.id,
    profile.id,
    professionId,
    taxonomyReleaseId,
    "TEST:CAPABILITY_ALPHA",
  );
  const input = projectInput({
    actorUserId: owner.id,
    commandId: randomUUID(),
    craftsmanProfileId: profile.id,
    districtCode: null,
    municipalityCode: null,
    portfolioProjectId: randomUUID() as PortfolioProjectId,
    professionIds: [professionId],
    skillIds: [],
    specializationIds: [],
  });
  const [result] = await Promise.all([
    repository.create(input),
    sql.begin(async (transaction) => {
      await transaction`SELECT id FROM users WHERE id = ${owner.id} FOR UPDATE`;
      await transaction`
        UPDATE users SET account_state = 'SUSPENDED',
          account_state_changed_at = changed.at, updated_at = changed.at
        FROM (SELECT clock_timestamp() AS at) changed
        WHERE users.id = ${owner.id}
      `;
    }),
  ]);
  expect(["APPLIED", "PROFILE_UNAVAILABLE"]).toContain(result.status);
  const [evidence] = await sql<
    {
      readonly accountChangedAt: Date;
      readonly commandCount: number;
      readonly createdAt: Date | null;
      readonly revisionCount: number;
    }[]
  >`
    SELECT owner.account_state_changed_at AS "accountChangedAt",
      project.created_at AS "createdAt",
      count(DISTINCT command.command_id)::integer AS "commandCount",
      count(DISTINCT revision.event_id)::integer AS "revisionCount"
    FROM users owner
    LEFT JOIN portfolio_projects project ON project.id = ${input.portfolioProjectId}
    LEFT JOIN portfolio_project_commands command ON command.portfolio_project_id = project.id
    LEFT JOIN portfolio_project_revisions revision ON revision.portfolio_project_id = project.id
    WHERE owner.id = ${owner.id}
    GROUP BY owner.account_state_changed_at, project.created_at
  `;
  if (evidence === undefined)
    throw new Error("Expected portfolio race evidence.");
  expect(evidence.commandCount).toBe(result.status === "APPLIED" ? 1 : 0);
  expect(evidence.revisionCount).toBe(result.status === "APPLIED" ? 1 : 0);
  if (evidence.createdAt !== null) {
    expect(evidence.createdAt.valueOf()).toBeLessThanOrEqual(
      evidence.accountChangedAt.valueOf(),
    );
  }
  await expect(repository.create(input)).resolves.toEqual({
    status: "PROFILE_UNAVAILABLE",
  });
}

async function assignProfession(
  repository: ReturnType<typeof createCraftsmanProfessionRepository>,
  actorUserId: UserId,
  craftsmanProfileId: CraftsmanProfileId,
  craftsmanProfessionId: CraftsmanProfessionId,
  taxonomyReleaseId: string,
  professionCode: string,
): Promise<void> {
  await expect(
    repository.assign({
      actorUserId,
      commandId: randomUUID(),
      craftsmanProfessionId,
      craftsmanProfileId,
      declaredLevel: "BEGINNER",
      professionCode,
      taxonomyReleaseId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
}

function projectInput(input: {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly districtCode: string | null;
  readonly municipalityCode: string | null;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly professionIds: readonly CraftsmanProfessionId[];
  readonly skillIds: readonly CraftsmanSkillId[];
  readonly specializationIds: readonly CraftsmanSpecializationId[];
}) {
  return {
    ...input,
    contribution: "Realizácia rozvodov a zapojenie rozvádzača",
    durationUnit: "DAYS" as const,
    durationValue: 4,
    indicativePriceMaxCents: 250_000,
    indicativePriceMinCents: 180_000,
    materialsAndTechnologies: "Potrubie 1/2 palca a rozvody 230/400 V",
    problem: "Pôvodné vedenie bolo technicky nevyhovujúce",
    shortDescription: "Bezpečný opis staršej realizácie mimo platformy",
    solution: "Rozvody boli bezpečne nahradené a označené",
    title: "Staršia elektroinštalačná realizácia",
  };
}

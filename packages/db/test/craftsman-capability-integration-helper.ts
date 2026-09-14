import { createHash, randomUUID } from "node:crypto";

import type {
  CraftsmanProfessionId,
  CraftsmanProfileId,
  CraftsmanSkillId,
  CraftsmanSpecializationId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCraftsmanCapabilityRepository } from "../src/craftsman-capability-repository.js";
import { createCraftsmanProfessionRepository } from "../src/craftsman-profession-repository.js";
import {
  createSkillCatalogRepository,
  prepareSkillCatalogRelease,
} from "../src/skill-catalog-repository.js";

/** Runs inside the single clean-migration integration test to avoid migration races. */
export async function runCraftsmanCapabilityIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [currentTaxonomy] = await sql<
    { readonly releaseId: string; readonly version: number }[]
  >`
    SELECT release.release_id AS "releaseId", release.version
    FROM profession_taxonomy_activation_events activation
    JOIN profession_taxonomy_releases release ON release.release_id = activation.release_id
    ORDER BY activation.activation_sequence DESC LIMIT 1
  `;
  const [latestTaxonomy] = await sql<
    { readonly releaseId: string; readonly version: number }[]
  >`
    SELECT release_id AS "releaseId", version FROM profession_taxonomy_releases
    ORDER BY version DESC LIMIT 1
  `;
  if (currentTaxonomy === undefined || latestTaxonomy === undefined) {
    throw new Error(
      "Expected current profession taxonomy for capability tests.",
    );
  }

  const taxonomyReleaseId = randomUUID();
  const taxonomyVersion = latestTaxonomy.version + 1;
  const taxonomyReview = `review:integration/capabilities-${taxonomyVersion}`;
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO profession_taxonomy_releases (
        release_id, version, content_class, review_state, review_reference,
        supersedes_release_id, checksum_sha256
      ) VALUES (
        ${taxonomyReleaseId}, ${taxonomyVersion}, 'CANONICAL',
        'HUMAN_REVIEW_APPROVED', ${taxonomyReview}, ${latestTaxonomy.releaseId},
        ${createHash("sha256").update(`capability-taxonomy:${taxonomyReleaseId}`).digest("hex")}
      )
    `;
    await transaction`
      INSERT INTO taxonomy_professions (
        release_id, profession_code, slug, label_sk, state
      ) VALUES
        (${taxonomyReleaseId}, 'TEST:CAPABILITY_ALPHA',
          'capability-alpha', 'Testovacie remeslo alfa', 'ACTIVE'),
        (${taxonomyReleaseId}, 'TEST:CAPABILITY_BETA',
          'capability-beta', 'Testovacie remeslo beta', 'ACTIVE')
    `;
    await transaction`
      INSERT INTO taxonomy_specializations (
        release_id, specialization_code, profession_code, slug, label_sk, state
      ) VALUES (
        ${taxonomyReleaseId}, 'TEST:CAPABILITY_SPECIALIZATION',
        'TEST:CAPABILITY_ALPHA', 'capability-specialization',
        'Testovacia špecializácia', 'ACTIVE'
      )
    `;
  });
  await sql`
    INSERT INTO profession_taxonomy_activation_events (
      activation_id, release_id, previous_release_id, actor_reference, review_reference
    ) VALUES (${randomUUID()}, ${taxonomyReleaseId}, ${currentTaxonomy.releaseId},
      'system:integration-capabilities', ${taxonomyReview})
  `;

  const catalog = prepareSkillCatalogRelease({
    contentClass: "CANONICAL",
    professionTaxonomyReleaseId: taxonomyReleaseId,
    releaseId: randomUUID(),
    reviewReference: "review:integration/skill-catalog-1",
    reviewState: "HUMAN_REVIEW_APPROVED",
    skills: [
      {
        code: "TEST:CAPABILITY_SKILL",
        labelSk: "Testovacia zručnosť",
        professionCodes: ["TEST:CAPABILITY_ALPHA", "TEST:CAPABILITY_BETA"],
        replacedByCode: null,
        slug: "capability-skill",
        state: "ACTIVE",
      },
    ],
    supersedesReleaseId: null,
    version: 1,
  });
  const catalogRepository = createSkillCatalogRepository(sql);
  const concurrentInstall = await Promise.all([
    catalogRepository.install(catalog),
    catalogRepository.install(catalog),
  ]);
  expect(concurrentInstall.sort()).toEqual(["CREATED", "UNCHANGED"]);
  await expect(
    catalogRepository.activate({
      activationId: randomUUID(),
      actorReference: "system:integration-skill-catalog",
      previousReleaseId: null,
      releaseId: catalog.releaseId,
      reviewReference: catalog.reviewReference!,
    }),
  ).resolves.toBe(true);

  await expect(sql`
    INSERT INTO skill_catalog_skills (
      release_id, skill_code, slug, label_sk, state
    ) VALUES (${catalog.releaseId}, 'TEST:LATE_SKILL', 'late-skill',
      'Oneskorená zručnosť', 'ACTIVE')
  `).rejects.toThrow(/sealed/u);

  const unsafeLabelReleaseId = randomUUID();
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO skill_catalog_releases (
          release_id, version, profession_taxonomy_release_id, content_class,
          review_state, review_reference, supersedes_release_id, checksum_sha256
        ) VALUES (${unsafeLabelReleaseId}, 2, ${taxonomyReleaseId}, 'CANONICAL',
          'HUMAN_REVIEW_APPROVED', 'review:integration/unsafe-label',
          ${catalog.releaseId}, ${createHash("sha256").update(unsafeLabelReleaseId).digest("hex")})
      `;
      await transaction`
        INSERT INTO skill_catalog_skills (
          release_id, skill_code, slug, label_sk, state
        ) VALUES (${unsafeLabelReleaseId}, 'TEST:UNSAFE_SKILL', 'unsafe-skill',
          'Volajte +421 900 123 456', 'ACTIVE')
      `;
    }),
  ).rejects.toThrow(/skill_catalog_skill_label_safe/u);

  const partialReleaseId = randomUUID();
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO skill_catalog_releases (
          release_id, version, profession_taxonomy_release_id, content_class,
          review_state, review_reference, supersedes_release_id, checksum_sha256
        ) VALUES (${partialReleaseId}, 2, ${taxonomyReleaseId}, 'CANONICAL',
          'HUMAN_REVIEW_APPROVED', 'review:integration/partial-catalog',
          ${catalog.releaseId}, ${createHash("sha256").update(partialReleaseId).digest("hex")})
      `;
      await transaction`
        INSERT INTO skill_catalog_skills (
          release_id, skill_code, slug, label_sk, state
        ) VALUES (${partialReleaseId}, 'TEST:ORPHAN_SKILL', 'orphan-skill',
          'Osirotená zručnosť', 'ACTIVE')
      `;
    }),
  ).rejects.toThrow(/at least one relevant profession/u);

  const emptyCatalog = prepareSkillCatalogRelease({
    contentClass: "CANONICAL",
    professionTaxonomyReleaseId: taxonomyReleaseId,
    releaseId: randomUUID(),
    reviewReference: "review:integration/empty-catalog",
    reviewState: "HUMAN_REVIEW_APPROVED",
    skills: [],
    supersedesReleaseId: catalog.releaseId,
    version: 2,
  });
  await expect(catalogRepository.install(emptyCatalog)).resolves.toBe(
    "CREATED",
  );
  await expect(
    catalogRepository.activate({
      activationId: randomUUID(),
      actorReference: "system:integration-empty-catalog",
      previousReleaseId: catalog.releaseId,
      releaseId: emptyCatalog.releaseId,
      reviewReference: emptyCatalog.reviewReference!,
    }),
  ).rejects.toThrow(/must contain a profession-linked skill/u);

  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  const [nonOwner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined || nonOwner === undefined) {
    throw new Error("Expected capability test users.");
  }
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${owner.id}, 'INDIVIDUAL') RETURNING id
  `;
  if (profile === undefined)
    throw new Error("Expected capability test profile.");

  const professionRepository = createCraftsmanProfessionRepository(sql);
  const alphaProfessionId = randomUUID() as CraftsmanProfessionId;
  const betaProfessionId = randomUUID() as CraftsmanProfessionId;
  for (const [id, professionCode] of [
    [alphaProfessionId, "TEST:CAPABILITY_ALPHA"],
    [betaProfessionId, "TEST:CAPABILITY_BETA"],
  ] as const) {
    await expect(
      professionRepository.assign({
        actorUserId: owner.id,
        commandId: randomUUID(),
        craftsmanProfessionId: id,
        craftsmanProfileId: profile.id,
        declaredLevel: "BEGINNER",
        professionCode,
        taxonomyReleaseId,
      }),
    ).resolves.toMatchObject({ status: "APPLIED" });
  }

  const repository = createCraftsmanCapabilityRepository(sql);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO craftsman_skills (
          id, craftsman_profile_id, identity_kind,
          retained_custom_text, created_by_user_id
        ) VALUES (${randomUUID()}, ${profile.id}, 'CUSTOM',
          'majster@example.sk', ${owner.id})
      `;
    }),
  ).rejects.toThrow(/craftsman_skill_identity_consistent/u);
  const specializationId = randomUUID() as CraftsmanSpecializationId;
  await expect(
    repository.addSpecialization({
      actorUserId: nonOwner.id,
      commandId: randomUUID(),
      craftsmanProfileId: profile.id,
      craftsmanProfessionId: alphaProfessionId,
      craftsmanSpecializationId: specializationId,
      specializationCode: "TEST:CAPABILITY_SPECIALIZATION",
      taxonomyReleaseId,
    }),
  ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
  await expect(
    repository.addSpecialization({
      actorUserId: owner.id,
      commandId: randomUUID(),
      craftsmanProfileId: profile.id,
      craftsmanProfessionId: betaProfessionId,
      craftsmanSpecializationId: specializationId,
      specializationCode: "TEST:CAPABILITY_SPECIALIZATION",
      taxonomyReleaseId,
    }),
  ).resolves.toEqual({ status: "SPECIALIZATION_NOT_ACTIVE" });
  const specializationCommandId = randomUUID();
  const specializationInput = {
    actorUserId: owner.id,
    commandId: specializationCommandId,
    craftsmanProfileId: profile.id,
    craftsmanProfessionId: alphaProfessionId,
    craftsmanSpecializationId: specializationId,
    specializationCode: "TEST:CAPABILITY_SPECIALIZATION",
    taxonomyReleaseId,
  } as const;
  await expect(
    repository.addSpecialization(specializationInput),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    repository.addSpecialization(specializationInput),
  ).resolves.toMatchObject({ status: "DEDUPLICATED" });

  const canonicalSkillId = randomUUID() as CraftsmanSkillId;
  const canonicalInput = {
    actorUserId: owner.id,
    canonicalSkillCode: "TEST:CAPABILITY_SKILL",
    commandId: randomUUID(),
    craftsmanProfileId: profile.id,
    craftsmanSkillId: canonicalSkillId,
    identityKind: "CANONICAL" as const,
    professionIds: [alphaProfessionId, betaProfessionId],
    skillCatalogReleaseId: catalog.releaseId,
  };
  const concurrentClaim = await Promise.all([
    repository.addSkill(canonicalInput),
    repository.addSkill(canonicalInput),
  ]);
  expect(concurrentClaim.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "DEDUPLICATED",
  ]);

  const customText = "Ručné drážkovanie – lokálny výraz";
  const customSkillId = randomUUID() as CraftsmanSkillId;
  await expect(
    repository.addSkill({
      actorUserId: owner.id,
      commandId: randomUUID(),
      craftsmanProfileId: profile.id,
      craftsmanSkillId: customSkillId,
      customText,
      identityKind: "CUSTOM",
      professionIds: [alphaProfessionId, betaProfessionId],
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const mappingInput = {
    actorUserId: owner.id,
    canonicalSkillCode: "TEST:CAPABILITY_SKILL",
    commandId: randomUUID(),
    craftsmanProfileId: profile.id,
    craftsmanSkillId: customSkillId,
    expectedMappingRevision: 0,
    skillCatalogReleaseId: catalog.releaseId,
  } as const;
  await expect(repository.mapCustomSkill(mappingInput)).resolves.toMatchObject({
    skill: {
      evidence: null,
      mappedCanonicalSkillCode: "TEST:CAPABILITY_SKILL",
      mappingRevision: 1,
      rankingSignal: "NONE",
      retainedCustomText: customText,
    },
    status: "APPLIED",
  });
  await expect(repository.mapCustomSkill(mappingInput)).resolves.toMatchObject({
    skill: { retainedCustomText: customText },
    status: "DEDUPLICATED",
  });

  const owned = await repository.listOwned({
    actorUserId: owner.id,
    craftsmanProfileId: profile.id,
  });
  expect(owned.skills).toHaveLength(2);
  expect(owned.specializations).toHaveLength(1);
  expect(owned.skills.every((skill) => skill.evidence === null)).toBe(true);
  expect(owned.skills.every((skill) => skill.rankingSignal === "NONE")).toBe(
    true,
  );
  expect(owned.skills).not.toHaveProperty("declaredLevel");
  await expect(
    repository.listOwned({
      actorUserId: nonOwner.id,
      craftsmanProfileId: profile.id,
    }),
  ).resolves.toEqual({ skills: [], specializations: [] });

  await expect(sql`
    UPDATE craftsman_skills SET retained_custom_text = 'Prepísaná história'
    WHERE id = ${customSkillId}
  `).rejects.toThrow(/invalid skill history mutation/u);
  await expect(sql`
    DELETE FROM craftsman_custom_skill_mapping_events
    WHERE craftsman_skill_id = ${customSkillId}
  `).rejects.toThrow(/append-only/u);
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO craftsman_skills (
          id, craftsman_profile_id, identity_kind,
          retained_custom_text, created_by_user_id
        ) VALUES (${randomUUID()}, ${profile.id}, 'CUSTOM',
          'Cudzí zápis', ${nonOwner.id})
      `;
    }),
  ).rejects.toThrow(/active craftsman profile owner required/u);

  const deactivation = {
    actorUserId: owner.id,
    commandId: randomUUID(),
    craftsmanProfileId: profile.id,
    targetId: customSkillId,
  } as const;
  await expect(repository.deactivateSkill(deactivation)).resolves.toMatchObject(
    {
      skill: { retainedCustomText: customText, state: "INACTIVE" },
      status: "APPLIED",
    },
  );
  await expect(repository.deactivateSkill(deactivation)).resolves.toMatchObject(
    {
      status: "DEDUPLICATED",
    },
  );
}

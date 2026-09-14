import { createHash, randomUUID } from "node:crypto";

import type {
  AssignCraftsmanProfessionInput,
  CraftsmanProfessionId,
  CraftsmanProfileId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCraftsmanProfessionRepository } from "../src/craftsman-profession-repository.js";

/** Runs inside the single clean-migration integration test to avoid migration races. */
export async function runCraftsmanProfessionIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [current] = await sql<
    { readonly releaseId: string; readonly version: number }[]
  >`
    SELECT release.release_id AS "releaseId", release.version
    FROM profession_taxonomy_activation_events activation
    JOIN profession_taxonomy_releases release
      ON release.release_id = activation.release_id
    ORDER BY activation.activation_sequence DESC
    LIMIT 1
  `;
  const [latestInstalled] = await sql<
    { readonly releaseId: string; readonly version: number }[]
  >`
    SELECT release_id AS "releaseId", version
    FROM profession_taxonomy_releases
    ORDER BY version DESC
    LIMIT 1
  `;
  if (current === undefined || latestInstalled === undefined) {
    throw new Error("Expected an activated and installed taxonomy release.");
  }

  const canonicalReleaseId = randomUUID();
  const canonicalVersion = latestInstalled.version + 1;
  const reviewReference = `review:integration/professions-${canonicalVersion}`;
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO profession_taxonomy_releases (
        release_id,
        version,
        content_class,
        review_state,
        review_reference,
        supersedes_release_id,
        checksum_sha256
      ) VALUES (
        ${canonicalReleaseId},
        ${canonicalVersion},
        'CANONICAL',
        'HUMAN_REVIEW_APPROVED',
        ${reviewReference},
        ${latestInstalled.releaseId},
        ${createHash("sha256").update(canonicalReleaseId).digest("hex")}
      )
    `;
    await transaction`
      INSERT INTO taxonomy_professions (
        release_id, profession_code, slug, label_sk, state, replaced_by_code
      ) VALUES
        (
          ${canonicalReleaseId}, 'TEST:INTEGRATION_ALPHA',
          'integracne-remeslo-alpha', 'Integračné remeslo alfa', 'ACTIVE', NULL
        ),
        (
          ${canonicalReleaseId}, 'TEST:INTEGRATION_BETA',
          'integracne-remeslo-beta', 'Integračné remeslo beta', 'ACTIVE', NULL
        ),
        (
          ${canonicalReleaseId}, 'TEST:INTEGRATION_GAMMA',
          'integracne-remeslo-gamma', 'Integračné remeslo gama', 'ACTIVE', NULL
        ),
        (
          ${canonicalReleaseId}, 'TEST:INTEGRATION_OLD',
          'integracne-remeslo-stare', 'Staré integračné remeslo',
          'DEPRECATED', 'TEST:INTEGRATION_ALPHA'
        )
    `;
  });
  await sql`
    INSERT INTO profession_taxonomy_activation_events (
      activation_id,
      release_id,
      previous_release_id,
      actor_reference,
      review_reference
    ) VALUES (
      ${randomUUID()},
      ${canonicalReleaseId},
      ${current.releaseId},
      'system:integration-professions',
      ${reviewReference}
    )
  `;

  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  const [nonOwner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined || nonOwner === undefined) {
    throw new Error("Expected profession test users.");
  }
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${owner.id}, 'INDIVIDUAL')
    RETURNING id
  `;
  if (profile === undefined) throw new Error("Expected craftsman profile.");

  const repository = createCraftsmanProfessionRepository(sql);
  const stale = assignmentInput({
    actorUserId: owner.id,
    craftsmanProfileId: profile.id,
    professionCode: "TEST:INTEGRATION_ALPHA",
    taxonomyReleaseId: current.releaseId,
  });
  await expect(repository.assign(stale)).resolves.toEqual({
    status: "TAXONOMY_RELEASE_NOT_CURRENT",
  });

  await expect(
    repository.assign(
      assignmentInput({
        actorUserId: owner.id,
        craftsmanProfileId: profile.id,
        professionCode: "TEST:INTEGRATION_OLD",
        taxonomyReleaseId: canonicalReleaseId,
      }),
    ),
  ).resolves.toEqual({ status: "PROFESSION_NOT_ACTIVE" });

  await expect(
    repository.assign(
      assignmentInput({
        actorUserId: nonOwner.id,
        craftsmanProfileId: profile.id,
        professionCode: "TEST:INTEGRATION_ALPHA",
        taxonomyReleaseId: canonicalReleaseId,
      }),
    ),
  ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });

  const [raceOwner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (raceOwner === undefined) throw new Error("Expected race-test owner.");
  const [raceProfile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${raceOwner.id}, 'INDIVIDUAL')
    RETURNING id
  `;
  if (raceProfile === undefined) throw new Error("Expected race-test profile.");
  const suspendedOwnerInput = assignmentInput({
    actorUserId: raceOwner.id,
    craftsmanProfileId: raceProfile.id,
    professionCode: "TEST:INTEGRATION_GAMMA",
    taxonomyReleaseId: canonicalReleaseId,
  });
  const [suspensionRace] = await Promise.all([
    repository.assign(suspendedOwnerInput),
    sql`
      UPDATE users
      SET
        account_state = 'SUSPENDED',
        account_state_changed_at = changed.at,
        updated_at = changed.at
      FROM (SELECT clock_timestamp() AS at) changed
      WHERE users.id = ${raceOwner.id}
    `,
  ]);
  expect(["APPLIED", "PROFILE_UNAVAILABLE"]).toContain(suspensionRace.status);
  const [raceEvidence] = await sql<
    {
      readonly accountStateChangedAt: Date;
      readonly assignmentCreatedAt: Date | null;
      readonly commandCount: number;
    }[]
  >`
    SELECT
      owner.account_state_changed_at AS "accountStateChangedAt",
      assignment.created_at AS "assignmentCreatedAt",
      count(command.command_id)::integer AS "commandCount"
    FROM users owner
    LEFT JOIN craftsman_professions assignment
      ON assignment.id = ${suspendedOwnerInput.craftsmanProfessionId}
    LEFT JOIN craftsman_profession_commands command
      ON command.craftsman_profession_id = assignment.id
    WHERE owner.id = ${raceOwner.id}
    GROUP BY owner.account_state_changed_at, assignment.created_at
  `;
  if (raceEvidence === undefined)
    throw new Error("Expected suspension race evidence.");
  expect(raceEvidence.commandCount).toBe(
    suspensionRace.status === "APPLIED" ? 1 : 0,
  );
  if (raceEvidence.assignmentCreatedAt !== null) {
    expect(raceEvidence.assignmentCreatedAt.valueOf()).toBeLessThanOrEqual(
      raceEvidence.accountStateChangedAt.valueOf(),
    );
  }
  await expect(repository.assign(suspendedOwnerInput)).resolves.toEqual({
    status: "PROFILE_UNAVAILABLE",
  });
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO craftsman_professions (
          id, craftsman_profile_id, taxonomy_release_id,
          profession_code, created_by_user_id
        ) VALUES (
          ${randomUUID()}, ${raceProfile.id}, ${canonicalReleaseId},
          'TEST:INTEGRATION_ALPHA', ${raceOwner.id}
        )
      `;
    }),
  ).rejects.toThrow(/active craftsman profile owner required/u);

  const alphaInput = assignmentInput({
    actorUserId: owner.id,
    craftsmanProfileId: profile.id,
    professionCode: "TEST:INTEGRATION_ALPHA",
    taxonomyReleaseId: canonicalReleaseId,
  });
  const concurrentAssignment = await Promise.all([
    repository.assign(alphaInput),
    repository.assign(alphaInput),
  ]);
  expect(concurrentAssignment.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "DEDUPLICATED",
  ]);
  const [{ effectCount: initialEffectCount } = { effectCount: -1 }] = await sql<
    { readonly effectCount: number }[]
  >`
    SELECT count(*)::integer AS "effectCount"
    FROM craftsman_profession_declared_level_events
    WHERE craftsman_profession_id = ${alphaInput.craftsmanProfessionId}
  `;
  expect(initialEffectCount).toBe(1);

  const betaInput = assignmentInput({
    actorUserId: owner.id,
    craftsmanProfileId: profile.id,
    professionCode: "TEST:INTEGRATION_BETA",
    taxonomyReleaseId: canonicalReleaseId,
  });
  await expect(repository.assign(betaInput)).resolves.toMatchObject({
    status: "APPLIED",
  });
  await expect(
    repository.listOwned({
      actorUserId: owner.id,
      craftsmanProfileId: profile.id,
    }),
  ).resolves.toHaveLength(2);
  await expect(
    repository.listOwned({
      actorUserId: nonOwner.id,
      craftsmanProfileId: profile.id,
    }),
  ).resolves.toEqual([]);

  const competingChanges = await Promise.all([
    repository.changeDeclaredLevel({
      actorUserId: owner.id,
      commandId: randomUUID(),
      craftsmanProfessionId: alphaInput.craftsmanProfessionId,
      craftsmanProfileId: profile.id,
      declaredLevel: "ADVANCED",
      expectedDeclaredLevelRevision: 1,
    }),
    repository.changeDeclaredLevel({
      actorUserId: owner.id,
      commandId: randomUUID(),
      craftsmanProfessionId: alphaInput.craftsmanProfessionId,
      craftsmanProfileId: profile.id,
      declaredLevel: "MASTER",
      expectedDeclaredLevelRevision: 1,
    }),
  ]);
  expect(competingChanges.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "STALE_REVISION",
  ]);
  const appliedChange = competingChanges.find(
    ({ status }) => status === "APPLIED",
  );
  if (appliedChange?.status !== "APPLIED") {
    throw new Error("Expected one applied declared-level change.");
  }
  await expect(
    repository.changeDeclaredLevel({
      actorUserId: owner.id,
      commandId: randomUUID(),
      craftsmanProfessionId: alphaInput.craftsmanProfessionId,
      craftsmanProfileId: profile.id,
      declaredLevel: appliedChange.profession.declaredLevel,
      expectedDeclaredLevelRevision: 2,
    }),
  ).resolves.toEqual({ status: "LEVEL_UNCHANGED" });
  await expect(
    repository.changeDeclaredLevel({
      actorUserId: nonOwner.id,
      commandId: randomUUID(),
      craftsmanProfessionId: alphaInput.craftsmanProfessionId,
      craftsmanProfileId: profile.id,
      declaredLevel: "MASTER",
      expectedDeclaredLevelRevision: 2,
    }),
  ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO craftsman_professions (
          id, craftsman_profile_id, taxonomy_release_id,
          profession_code, created_by_user_id
        ) VALUES (
          ${randomUUID()}, ${profile.id}, ${canonicalReleaseId},
          'TEST:INTEGRATION_GAMMA', ${owner.id}
        )
      `;
    }),
  ).rejects.toThrow(/initial declared proficiency/u);

  await expect(sql`
    UPDATE craftsman_profession_declared_level_events
    SET declared_level = 'MASTER'
    WHERE craftsman_profession_id = ${alphaInput.craftsmanProfessionId}
      AND revision = 1
  `).rejects.toThrow(/append-only/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO craftsman_profession_commands (
          command_id,
          command_kind,
          craftsman_profession_id,
          craftsman_profile_id,
          actor_user_id,
          payload_fingerprint
        ) VALUES (
          ${randomUUID()},
          'CHANGE_DECLARED_LEVEL',
          ${betaInput.craftsmanProfessionId},
          ${profile.id},
          ${owner.id},
          ${"e".repeat(64)}
        )
      `;
    }),
  ).rejects.toThrow(/requires an event/u);

  await expect(sql`
    UPDATE craftsman_professions
    SET
      state = 'INACTIVE',
      deactivated_by_user_id = ${owner.id},
      deactivation_command_id = ${randomUUID()}
    WHERE id = ${alphaInput.craftsmanProfessionId}
  `).rejects.toThrow(/matching command provenance/u);

  const deactivation = {
    actorUserId: owner.id,
    commandId: randomUUID(),
    craftsmanProfessionId: alphaInput.craftsmanProfessionId,
    craftsmanProfileId: profile.id,
  } as const;
  await expect(repository.deactivate(deactivation)).resolves.toMatchObject({
    profession: { state: "INACTIVE" },
    status: "APPLIED",
  });
  await expect(repository.deactivate(deactivation)).resolves.toMatchObject({
    profession: { state: "INACTIVE" },
    status: "DEDUPLICATED",
  });
  await expect(
    repository.deactivate({ ...deactivation, commandId: randomUUID() }),
  ).resolves.toEqual({ status: "ASSIGNMENT_NOT_ACTIVE" });
  await expect(sql`
    DELETE FROM craftsman_professions
    WHERE id = ${alphaInput.craftsmanProfessionId}
  `).rejects.toThrow(/append-only/u);

  const [history] = await sql<
    {
      readonly evidenceSupportedLevel: string | null;
      readonly levelEvents: number;
      readonly state: string;
    }[]
  >`
    SELECT
      current.state,
      current.evidence_supported_level AS "evidenceSupportedLevel",
      count(event.event_id)::integer AS "levelEvents"
    FROM current_craftsman_professions current
    JOIN craftsman_profession_declared_level_events event
      ON event.craftsman_profession_id = current.id
    WHERE current.id = ${alphaInput.craftsmanProfessionId}
    GROUP BY current.state, current.evidence_supported_level
  `;
  expect(history).toEqual({
    evidenceSupportedLevel: null,
    levelEvents: 2,
    state: "INACTIVE",
  });
}

function assignmentInput(input: {
  readonly actorUserId: UserId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly professionCode: string;
  readonly taxonomyReleaseId: string;
}): AssignCraftsmanProfessionInput {
  return {
    ...input,
    commandId: randomUUID(),
    craftsmanProfessionId: randomUUID() as CraftsmanProfessionId,
    declaredLevel: "BEGINNER",
  };
}

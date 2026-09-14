import { randomUUID } from "node:crypto";

import type {
  CraftsmanProfileId,
  ReplaceCraftsmanExperienceInput,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCraftsmanExperienceRepository } from "../src/craftsman-experience-repository.js";

/** Runs inside the single clean-migration integration test to avoid migration races. */
export async function runCraftsmanExperienceIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  const [nonOwner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined || nonOwner === undefined) {
    throw new Error("Expected craftsman experience integration users.");
  }
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${owner.id}, 'INDIVIDUAL')
    RETURNING id
  `;
  if (profile === undefined) {
    throw new Error("Expected craftsman experience integration profile.");
  }

  const repository = createCraftsmanExperienceRepository(sql);
  const initialNull = replacement(owner.id, profile.id, null);
  await expect(repository.replaceOwnedDraft(initialNull)).resolves.toEqual({
    experience: null,
    status: "UNCHANGED",
  });
  await expect(repository.replaceOwnedDraft(initialNull)).resolves.toEqual({
    experience: null,
    status: "DEDUPLICATED",
  });
  const [{ revisionCount: initialRevisionCount } = { revisionCount: -1 }] =
    await sql<{ readonly revisionCount: number }[]>`
      SELECT count(*)::integer AS "revisionCount"
      FROM craftsman_experience_revisions
      WHERE craftsman_profile_id = ${profile.id}
    `;
  expect(initialRevisionCount).toBe(0);

  const firstYear = replacement(owner.id, profile.id, 2010);
  const concurrentSet = await Promise.all([
    repository.replaceOwnedDraft(firstYear),
    repository.replaceOwnedDraft(firstYear),
  ]);
  expect(concurrentSet.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "DEDUPLICATED",
  ]);

  await expect(
    repository.replaceOwnedDraft({
      ...replacement(nonOwner.id, profile.id, 2011),
      expectedRevision: 1,
    }),
  ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
  await expect(
    repository.findOwned({
      actorUserId: nonOwner.id,
      craftsmanProfileId: profile.id,
    }),
  ).resolves.toBeNull();
  await expect(
    repository.replaceOwnedDraft({
      ...replacement(owner.id, profile.id, 2011),
      expectedRevision: 0,
    }),
  ).resolves.toEqual({ status: "STALE_REVISION" });

  const changed = {
    ...replacement(owner.id, profile.id, 2015),
    expectedRevision: 1,
  };
  await expect(repository.replaceOwnedDraft(changed)).resolves.toMatchObject({
    experience: { revision: 2, workingSinceYear: 2015 },
    status: "APPLIED",
  });
  const cleared = {
    ...replacement(owner.id, profile.id, null),
    expectedRevision: 2,
  };
  await expect(repository.replaceOwnedDraft(cleared)).resolves.toMatchObject({
    experience: {
      provenance: "SELF_DECLARED",
      revision: 3,
      workingSinceYear: null,
    },
    status: "APPLIED",
  });
  await expect(repository.replaceOwnedDraft(firstYear)).resolves.toMatchObject({
    experience: { revision: 1, workingSinceYear: 2010 },
    status: "DEDUPLICATED",
  });
  await expect(
    repository.findOwned({
      actorUserId: owner.id,
      craftsmanProfileId: profile.id,
    }),
  ).resolves.toMatchObject({ revision: 3, workingSinceYear: null });

  await expect(sql`
    INSERT INTO craftsman_experience_commands (
      command_id,
      craftsman_profile_id,
      actor_user_id,
      expected_revision,
      result_kind,
      resulting_revision,
      working_since_year,
      payload_fingerprint
    ) VALUES (
      ${randomUUID()},
      ${profile.id},
      ${owner.id},
      3,
      'APPLIED',
      4,
      9999,
      ${"a".repeat(64)}
    )
  `).rejects.toThrow(/server calendar range/u);

  await expect(sql`
    INSERT INTO craftsman_experience_commands (
      command_id,
      craftsman_profile_id,
      actor_user_id,
      expected_revision,
      result_kind,
      resulting_revision,
      working_since_year,
      payload_fingerprint
    ) VALUES (
      ${randomUUID()},
      ${profile.id},
      ${owner.id},
      0,
      'APPLIED',
      1,
      2018,
      ${"b".repeat(64)}
    )
  `).rejects.toThrow(/stale revision/u);

  await expect(sql`
    INSERT INTO craftsman_experience_commands (
      command_id,
      craftsman_profile_id,
      actor_user_id,
      expected_revision,
      result_kind,
      resulting_revision,
      working_since_year,
      payload_fingerprint
    ) VALUES (
      ${randomUUID()},
      ${profile.id},
      ${nonOwner.id},
      3,
      'APPLIED',
      4,
      2018,
      ${"c".repeat(64)}
    )
  `).rejects.toThrow(/active owned craftsman profile required/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO craftsman_experience_commands (
          command_id,
          craftsman_profile_id,
          actor_user_id,
          expected_revision,
          result_kind,
          resulting_revision,
          working_since_year,
          payload_fingerprint
        ) VALUES (
          ${randomUUID()},
          ${profile.id},
          ${owner.id},
          3,
          'APPLIED',
          4,
          2018,
          ${"d".repeat(64)}
        )
      `;
    }),
  ).rejects.toThrow(/requires exact revision effect/u);

  await expect(
    sql.begin(async (transaction) => {
      const effectCommandId = randomUUID();
      await transaction`
        INSERT INTO craftsman_experience_commands (
          command_id,
          craftsman_profile_id,
          actor_user_id,
          expected_revision,
          result_kind,
          resulting_revision,
          working_since_year,
          payload_fingerprint
        ) VALUES (
          ${effectCommandId},
          ${profile.id},
          ${owner.id},
          3,
          'APPLIED',
          4,
          2018,
          ${"e".repeat(64)}
        )
      `;
      await transaction`
        INSERT INTO craftsman_experience_revisions (
          craftsman_profile_id,
          command_id,
          revision,
          working_since_year
        ) VALUES (
          ${profile.id},
          ${effectCommandId},
          4,
          2019
        )
      `;
    }),
  ).rejects.toThrow(/must match applied command provenance/u);

  await expect(sql`
    UPDATE craftsman_experience_commands
    SET working_since_year = 2020
    WHERE command_id = ${changed.commandId}
  `).rejects.toThrow(/history is append-only/u);
  await expect(sql`
    DELETE FROM craftsman_experience_revisions
    WHERE craftsman_profile_id = ${profile.id}
  `).rejects.toThrow(/history is append-only/u);

  await runExperienceSuspensionRace(sql);
}

function replacement(
  actorUserId: UserId,
  craftsmanProfileId: CraftsmanProfileId,
  workingSinceYear: number | null,
): ReplaceCraftsmanExperienceInput {
  return {
    actorUserId,
    commandId: randomUUID(),
    craftsmanProfileId,
    expectedRevision: 0,
    workingSinceYear,
  };
}

async function runExperienceSuspensionRace(sql: Sql): Promise<void> {
  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined) throw new Error("Expected experience race owner.");
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${owner.id}, 'INDIVIDUAL')
    RETURNING id
  `;
  if (profile === undefined)
    throw new Error("Expected experience race profile.");

  const input = replacement(owner.id, profile.id, 2018);
  const [replaceResult] = await Promise.all([
    createCraftsmanExperienceRepository(sql).replaceOwnedDraft(input),
    sql.begin(async (transaction) => {
      await transaction`
        SELECT id FROM users WHERE id = ${owner.id} FOR UPDATE
      `;
      return transaction`
        UPDATE users
        SET
          account_state = 'SUSPENDED',
          account_state_changed_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE id = ${owner.id}
      `;
    }),
  ]);
  expect(["APPLIED", "PROFILE_UNAVAILABLE"]).toContain(replaceResult.status);

  const [evidence] = await sql<
    {
      readonly accountStateChangedAt: Date;
      readonly commandCount: number;
      readonly recordedAt: Date | null;
      readonly revisionCount: number;
    }[]
  >`
    SELECT
      owner.account_state_changed_at AS "accountStateChangedAt",
      history.created_at AS "recordedAt",
      count(DISTINCT command.command_id)::integer AS "commandCount",
      count(DISTINCT history.id)::integer AS "revisionCount"
    FROM users owner
    LEFT JOIN craftsman_experience_commands command
      ON command.command_id = ${input.commandId}
    LEFT JOIN craftsman_experience_revisions history
      ON history.command_id = command.command_id
    WHERE owner.id = ${owner.id}
    GROUP BY owner.account_state_changed_at, history.created_at
  `;
  if (evidence === undefined) {
    throw new Error("Expected experience suspension-race evidence.");
  }
  const expectedEffects = replaceResult.status === "APPLIED" ? 1 : 0;
  expect(evidence.commandCount).toBe(expectedEffects);
  expect(evidence.revisionCount).toBe(expectedEffects);
  if (evidence.recordedAt !== null) {
    expect(evidence.recordedAt.valueOf()).toBeLessThanOrEqual(
      evidence.accountStateChangedAt.valueOf(),
    );
  }
  await expect(
    createCraftsmanExperienceRepository(sql).replaceOwnedDraft(input),
  ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
}

import { randomUUID } from "node:crypto";

import type {
  AddCraftsmanAvailabilityBlockInput,
  CraftsmanAvailabilityBlockId,
  CraftsmanProfileId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  createCraftsmanAvailabilityRepository,
  CraftsmanAvailabilityIdempotencyError,
} from "../src/craftsman-availability-repository.js";

/** Runs inside the single clean-migration integration test. */
export async function runCraftsmanAvailabilityIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  const [nonOwner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined || nonOwner === undefined) {
    throw new Error("Expected availability test users.");
  }
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${owner.id}, 'INDIVIDUAL') RETURNING id
  `;
  if (profile === undefined) throw new Error("Expected availability profile.");

  const repository = createCraftsmanAvailabilityRepository(sql);
  const first = addInput(owner.id, profile.id, "AVAILABLE");
  await expect(repository.add(first)).resolves.toMatchObject({
    block: { availability: "AVAILABLE", revision: 1, state: "ACTIVE" },
    status: "APPLIED",
  });
  await expect(repository.add(first)).resolves.toMatchObject({
    block: { revision: 1 },
    status: "DEDUPLICATED",
  });

  const overlapping = addInput(owner.id, profile.id, "BUSY", {
    startsAt: new Date("2027-02-01T10:00:00.000Z"),
    endsAt: new Date("2027-02-01T11:00:00.000Z"),
  });
  await expect(repository.add(overlapping)).resolves.toMatchObject({
    block: { availability: "BUSY", revision: 1 },
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

  const firstReplacement = {
    ...first,
    availability: "UNAVAILABLE" as const,
    commandId: randomUUID(),
    endsAt: new Date("2027-02-01T13:00:00.000Z"),
    expectedRevision: 1,
  };
  await expect(repository.replace(firstReplacement)).resolves.toMatchObject({
    block: { availability: "UNAVAILABLE", revision: 2 },
    status: "APPLIED",
  });

  const competing = await Promise.all([
    repository.replace({
      ...first,
      availability: "AVAILABLE",
      commandId: randomUUID(),
      expectedRevision: 2,
    }),
    repository.replace({
      ...first,
      availability: "BUSY",
      commandId: randomUUID(),
      expectedRevision: 2,
    }),
  ]);
  expect(competing.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "STALE_REVISION",
  ]);
  const applied = competing.find(({ status }) => status === "APPLIED");
  if (applied?.status !== "APPLIED") {
    throw new Error("Expected one applied availability update.");
  }
  await expect(repository.add(first)).resolves.toMatchObject({
    block: { availability: "AVAILABLE", revision: 1 },
    status: "DEDUPLICATED",
  });
  await expect(repository.replace(firstReplacement)).resolves.toMatchObject({
    block: {
      availability: "UNAVAILABLE",
      endsAt: firstReplacement.endsAt,
      revision: 2,
    },
    status: "DEDUPLICATED",
  });
  await expect(
    repository.replace({
      actorUserId: owner.id,
      availability: applied.block.availability,
      blockId: first.blockId,
      commandId: randomUUID(),
      craftsmanProfileId: profile.id,
      endsAt: applied.block.endsAt,
      expectedRevision: applied.block.revision,
      startsAt: applied.block.startsAt,
    }),
  ).resolves.toMatchObject({
    block: { revision: applied.block.revision },
    status: "UNCHANGED",
  });

  await expect(
    repository.archive({
      actorUserId: owner.id,
      blockId: overlapping.blockId,
      commandId: randomUUID(),
      craftsmanProfileId: profile.id,
      expectedRevision: 1,
    }),
  ).resolves.toMatchObject({
    block: { revision: 2, state: "ARCHIVED" },
    status: "APPLIED",
  });
  await expect(
    repository.listOwned({
      actorUserId: owner.id,
      craftsmanProfileId: profile.id,
    }),
  ).resolves.toHaveLength(1);
  await expect(
    repository.listOwned({
      actorUserId: owner.id,
      craftsmanProfileId: profile.id,
      includeArchived: true,
    }),
  ).resolves.toHaveLength(2);

  await expect(
    repository.replace({
      ...first,
      commandId: first.commandId,
      expectedRevision: 3,
    }),
  ).rejects.toThrow(CraftsmanAvailabilityIdempotencyError);

  const [otherOwner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (otherOwner === undefined) throw new Error("Expected second owner.");
  const [otherProfile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${otherOwner.id}, 'COMPANY') RETURNING id
  `;
  if (otherProfile === undefined) throw new Error("Expected second profile.");
  await expect(
    repository.add({
      ...first,
      actorUserId: otherOwner.id,
      craftsmanProfileId: otherProfile.id,
    }),
  ).rejects.toThrow(CraftsmanAvailabilityIdempotencyError);

  await exerciseRawSqlGuards(
    sql,
    owner.id,
    nonOwner.id,
    profile.id,
    first.blockId,
  );
  await exerciseSuspendedReplay(sql, repository);
  await exerciseSuspensionRace(sql, repository);

  const forbidden = await sql<{ readonly columnName: string }[]>`
    SELECT column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_name IN (
      'craftsman_availability_commands', 'craftsman_availability_revisions'
    )
      AND column_name IN (
        'booking_id', 'capacity', 'crew_id', 'customer_id', 'employer',
        'external_source', 'note', 'recurrence_rule', 'calendar_sync_id',
        'contractual_guarantee', 'email', 'phone'
      )
  `;
  expect(forbidden).toEqual([]);
  const publicViews = await sql<{ readonly tableName: string }[]>`
    SELECT table_name AS "tableName"
    FROM information_schema.views
    WHERE table_name LIKE 'public%availability%'
  `;
  expect(publicViews).toEqual([]);
}

async function exerciseRawSqlGuards(
  sql: Sql,
  ownerUserId: UserId,
  nonOwnerUserId: UserId,
  profileId: CraftsmanProfileId,
  blockId: CraftsmanAvailabilityBlockId,
): Promise<void> {
  const [current] = await sql<
    {
      readonly availability: "AVAILABLE" | "BUSY" | "UNAVAILABLE";
      readonly endsAt: Date;
      readonly revision: number;
      readonly startsAt: Date;
    }[]
  >`
    SELECT availability, ends_at AS "endsAt", revision, starts_at AS "startsAt"
    FROM current_craftsman_availability_blocks
    WHERE block_id = ${blockId}
  `;
  if (current === undefined)
    throw new Error("Expected current availability block.");

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO craftsman_availability_commands (
          command_id, command_kind, block_id, craftsman_profile_id,
          actor_user_id, expected_revision, result_kind, resulting_revision,
          target_state, availability, starts_at, ends_at, payload_fingerprint
        ) VALUES (
          ${randomUUID()}, 'REPLACE', ${blockId}, ${profileId},
          ${nonOwnerUserId}, ${current.revision}, 'UNCHANGED', ${current.revision},
          'ACTIVE', ${current.availability}, ${current.startsAt}, ${current.endsAt},
          ${"a".repeat(64)}
        )
      `;
    }),
  ).rejects.toThrow(/active owned craftsman profile/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO craftsman_availability_commands (
          command_id, command_kind, block_id, craftsman_profile_id,
          actor_user_id, expected_revision, result_kind, resulting_revision,
          target_state, availability, starts_at, ends_at, payload_fingerprint
        ) VALUES (
          ${randomUUID()}, 'REPLACE', ${blockId}, ${profileId},
          ${ownerUserId}, ${current.revision}, 'UNCHANGED', ${current.revision},
          'ACTIVE', ${current.availability}, ${current.startsAt},
          ${new Date(current.endsAt.valueOf() + 60_000)}, ${"b".repeat(64)}
        )
      `;
    }),
  ).rejects.toThrow(/changed availability command requires revision effect/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO craftsman_availability_commands (
          command_id, command_kind, block_id, craftsman_profile_id,
          actor_user_id, expected_revision, result_kind, resulting_revision,
          target_state, availability, starts_at, ends_at, payload_fingerprint
        ) VALUES (
          ${randomUUID()}, 'REPLACE', ${blockId}, ${profileId},
          ${ownerUserId}, ${current.revision}, 'APPLIED', ${current.revision + 1},
          'ACTIVE', ${current.availability}, ${current.startsAt},
          ${new Date(current.endsAt.valueOf() + 60_000)}, ${"c".repeat(64)}
        )
      `;
    }),
  ).rejects.toThrow(/requires exact revision effect/u);

  await expect(sql`
    UPDATE craftsman_availability_revisions
    SET availability = 'UNAVAILABLE'
    WHERE block_id = ${blockId} AND revision = 1
  `).rejects.toThrow(/append-only/u);
  await expect(sql`
    DELETE FROM craftsman_availability_commands
    WHERE block_id = ${blockId}
  `).rejects.toThrow(/append-only/u);
  await expect(sql`
    INSERT INTO craftsman_availability_revisions (
      block_id, craftsman_profile_id, command_id, revision, state,
      availability, starts_at, ends_at
    ) VALUES (
      ${randomUUID()}, ${profileId}, ${randomUUID()}, 999, 'ACTIVE',
      'AVAILABLE', ${current.startsAt}, ${current.endsAt}
    )
  `).rejects.toThrow(/must exactly match applied command provenance/u);
  await expect(sql`
    INSERT INTO craftsman_availability_commands (
      command_id, command_kind, block_id, craftsman_profile_id,
      actor_user_id, expected_revision, result_kind, resulting_revision,
      target_state, availability, starts_at, ends_at, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, 'ADD', ${randomUUID()}, ${profileId}, ${ownerUserId},
      0, 'APPLIED', 1, 'ACTIVE', 'AVAILABLE',
      timestamptz '2027-01-02 00:00:00+00',
      timestamptz '2027-01-01 00:00:00+00', ${"d".repeat(64)}
    )
  `).rejects.toThrow(/craftsman_availability_commands_range_safe/u);
}

async function exerciseSuspendedReplay(
  sql: Sql,
  repository: ReturnType<typeof createCraftsmanAvailabilityRepository>,
): Promise<void> {
  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined) throw new Error("Expected suspended owner.");
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${owner.id}, 'INDIVIDUAL') RETURNING id
  `;
  if (profile === undefined) throw new Error("Expected suspended profile.");
  const command = addInput(owner.id, profile.id, "UNAVAILABLE");
  await expect(repository.add(command)).resolves.toMatchObject({
    status: "APPLIED",
  });
  await sql`
    UPDATE users
    SET account_state = 'SUSPENDED',
        account_state_changed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    WHERE id = ${owner.id}
  `;
  await expect(repository.add(command)).resolves.toEqual({
    status: "PROFILE_UNAVAILABLE",
  });
}

async function exerciseSuspensionRace(
  sql: Sql,
  repository: ReturnType<typeof createCraftsmanAvailabilityRepository>,
): Promise<void> {
  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined) throw new Error("Expected race owner.");
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${owner.id}, 'COMPANY') RETURNING id
  `;
  if (profile === undefined) throw new Error("Expected race profile.");
  const command = addInput(owner.id, profile.id, "BUSY");
  const [result] = await Promise.all([
    repository.add(command),
    sql.begin(async (transaction) => {
      await transaction`
        SELECT id FROM users WHERE id = ${owner.id} FOR UPDATE
      `;
      await transaction`
        UPDATE users
        SET account_state = 'SUSPENDED',
            account_state_changed_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE id = ${owner.id}
      `;
    }),
  ]);
  expect(["APPLIED", "PROFILE_UNAVAILABLE"]).toContain(result.status);
  const [evidence] = await sql<
    {
      readonly accountStateChangedAt: Date;
      readonly commandCount: number;
      readonly revisionChangedAt: Date | null;
    }[]
  >`
    SELECT
      owner.account_state_changed_at AS "accountStateChangedAt",
      count(command.command_id)::integer AS "commandCount",
      max(revision.changed_at) AS "revisionChangedAt"
    FROM users owner
    LEFT JOIN craftsman_availability_commands command
      ON command.craftsman_profile_id = ${profile.id}
    LEFT JOIN craftsman_availability_revisions revision
      ON revision.command_id = command.command_id
    WHERE owner.id = ${owner.id}
    GROUP BY owner.account_state_changed_at
  `;
  if (evidence === undefined)
    throw new Error("Expected availability race evidence.");
  expect(evidence.commandCount).toBe(result.status === "APPLIED" ? 1 : 0);
  if (evidence.revisionChangedAt !== null) {
    expect(evidence.revisionChangedAt.valueOf()).toBeLessThanOrEqual(
      evidence.accountStateChangedAt.valueOf(),
    );
  }
}

function addInput(
  actorUserId: UserId,
  craftsmanProfileId: CraftsmanProfileId,
  availability: "AVAILABLE" | "BUSY" | "UNAVAILABLE",
  changes: Partial<AddCraftsmanAvailabilityBlockInput> = {},
): AddCraftsmanAvailabilityBlockInput {
  return {
    actorUserId,
    availability,
    blockId: randomUUID() as CraftsmanAvailabilityBlockId,
    commandId: randomUUID(),
    craftsmanProfileId,
    endsAt: new Date("2027-02-01T12:00:00.000Z"),
    startsAt: new Date("2027-02-01T09:00:00.000Z"),
    ...changes,
  };
}

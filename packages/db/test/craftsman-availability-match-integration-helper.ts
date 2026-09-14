import { randomUUID } from "node:crypto";

import type {
  CraftsmanAvailabilityBlockId,
  CraftsmanProfileId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCraftsmanAvailabilityMatchRepository } from "../src/craftsman-availability-match-repository.js";
import { createCraftsmanAvailabilityRepository } from "../src/craftsman-availability-repository.js";
import { runCraftsmanDistanceIntegrationAssertions } from "./craftsman-distance-integration-helper.js";

interface CandidateRow {
  readonly ownerId: string;
  readonly profileId: string;
}

interface CountRow {
  readonly count: number;
}

interface ColumnRow {
  readonly parameterName: string;
}

/** Standalone R2-007 live-PostgreSQL assertions; not wired into the shared runner. */
export async function runCraftsmanAvailabilityMatchIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const before = await currentCandidateIds(sql);
  await runCraftsmanDistanceIntegrationAssertions(sql);
  const candidates = (await currentCandidates(sql)).filter(
    ({ profileId }) => !before.has(profileId),
  );
  expect(candidates).toHaveLength(3);
  const [available, unavailable, mixed] = candidates;
  if (
    available === undefined ||
    unavailable === undefined ||
    mixed === undefined
  ) {
    throw new Error("R2-007 availability fixtures were not created.");
  }

  const calendar = createCraftsmanAvailabilityRepository(sql);
  const match = createCraftsmanAvailabilityMatchRepository(sql);
  const startsAt = new Date("2098-06-01T10:00:00.000Z");
  const endsAt = new Date("2098-06-01T12:00:00.000Z");

  const availableBlockId = await addMarking(
    calendar,
    available,
    "AVAILABLE",
    startsAt,
    endsAt,
  );
  await addMarking(calendar, unavailable, "UNAVAILABLE", startsAt, endsAt);
  await addMarking(calendar, mixed, "AVAILABLE", startsAt, endsAt);
  await addMarking(calendar, mixed, "BUSY", startsAt, endsAt);

  const ownIds = candidates.map(({ profileId }) => profileId);
  const omitted = await match.findMatches({
    endsAt: null,
    filterIndicativelyAvailable: false,
    limit: 100,
    startsAt: null,
  });
  const omittedOwn = omitted.filter(({ craftsmanProfileId }) =>
    ownIds.includes(craftsmanProfileId),
  );
  expect(omittedOwn).toHaveLength(3);
  expect(
    omittedOwn.every(({ matchKind }) => matchKind === "TIMING_NOT_SUPPLIED"),
  ).toBe(true);

  const ordinary = await match.findMatches(timed(false));
  expect(factFor(ordinary, available.profileId)).toMatchObject({
    indicativelyAvailable: true,
    matchKind: "AVAILABLE_OVERLAP",
  });
  expect(factFor(ordinary, unavailable.profileId)).toMatchObject({
    indicativelyAvailable: false,
    matchKind: "UNAVAILABLE_OVERLAP",
  });
  expect(factFor(ordinary, mixed.profileId)).toMatchObject({
    indicativelyAvailable: false,
    matchKind: "MIXED_OVERLAP",
  });

  const filtered = await match.findMatches(timed(true));
  expect(
    filtered.some(
      ({ craftsmanProfileId }) => craftsmanProfileId === available.profileId,
    ),
  ).toBe(true);
  expect(
    filtered.some(
      ({ craftsmanProfileId }) => craftsmanProfileId === unavailable.profileId,
    ),
  ).toBe(false);
  expect(
    filtered.some(
      ({ craftsmanProfileId }) => craftsmanProfileId === mixed.profileId,
    ),
  ).toBe(false);

  const touching = await match.findMatches({
    endsAt: new Date("2098-06-01T13:00:00.000Z"),
    filterIndicativelyAvailable: false,
    limit: 100,
    startsAt: endsAt,
  });
  expect(factFor(touching, available.profileId)?.matchKind).toBe(
    "NO_OVERLAPPING_DECLARATION",
  );

  await assertReplaceRace(
    match,
    calendar,
    available,
    availableBlockId,
    startsAt,
    endsAt,
  );
  await assertSuspensionRace(sql, match, unavailable);
  await assertRawSqlPrivacyAndBounds(sql);
}

async function assertReplaceRace(
  match: ReturnType<typeof createCraftsmanAvailabilityMatchRepository>,
  calendar: ReturnType<typeof createCraftsmanAvailabilityRepository>,
  candidate: CandidateRow,
  blockId: CraftsmanAvailabilityBlockId,
  startsAt: Date,
  endsAt: Date,
): Promise<void> {
  const [raced, replaced] = await Promise.all([
    match.findMatches(timed(false)),
    calendar.replace({
      actorUserId: candidate.ownerId as UserId,
      availability: "UNAVAILABLE",
      blockId,
      commandId: randomUUID(),
      craftsmanProfileId: candidate.profileId as CraftsmanProfileId,
      endsAt,
      expectedRevision: 1,
      startsAt,
    }),
  ]);
  expect(replaced.status).toBe("APPLIED");
  expect(["AVAILABLE_OVERLAP", "UNAVAILABLE_OVERLAP"]).toContain(
    factFor(raced, candidate.profileId)?.matchKind,
  );
  const after = await match.findMatches(timed(false));
  expect(factFor(after, candidate.profileId)?.matchKind).toBe(
    "UNAVAILABLE_OVERLAP",
  );
}

async function assertSuspensionRace(
  sql: Sql,
  match: ReturnType<typeof createCraftsmanAvailabilityMatchRepository>,
  candidate: CandidateRow,
): Promise<void> {
  try {
    const [raced] = await Promise.all([
      match.findMatches(timed(false)),
      sql`
        UPDATE users
        SET account_state = 'SUSPENDED', updated_at = clock_timestamp()
        WHERE id = ${candidate.ownerId}
      `,
    ]);
    expect(
      raced.filter(
        ({ craftsmanProfileId }) => craftsmanProfileId === candidate.profileId,
      ).length,
    ).toBeLessThanOrEqual(1);
    const after = await match.findMatches(timed(false));
    expect(
      after.some(
        ({ craftsmanProfileId }) => craftsmanProfileId === candidate.profileId,
      ),
    ).toBe(false);
  } finally {
    await sql`
      UPDATE users
      SET account_state = 'ACTIVE', updated_at = clock_timestamp()
      WHERE id = ${candidate.ownerId}
    `;
  }
}

async function assertRawSqlPrivacyAndBounds(sql: Sql): Promise<void> {
  const columns = await sql<ColumnRow[]>`
    SELECT parameter_name AS "parameterName"
    FROM information_schema.parameters
    WHERE specific_schema = 'public'
      AND specific_name LIKE 'craftsman_availability_match_facts_%'
      AND parameter_mode = 'OUT'
    ORDER BY ordinal_position
  `;
  expect(columns.map(({ parameterName }) => parameterName)).toEqual([
    "craftsman_profile_id",
    "match_kind",
    "indicatively_available",
  ]);
  expect(
    columns.map(({ parameterName }) => parameterName).join(" "),
  ).not.toMatch(
    /starts|ends|owner|email|phone|address|contact|capacity|booking|count/iu,
  );

  const [invalid] = await sql<CountRow[]>`
    SELECT count(*)::integer AS count
    FROM craftsman_availability_match_facts(
      timestamptz '1999-12-31 23:00:00+00',
      timestamptz '2000-01-01 01:00:00+00',
      false
    )
  `;
  expect(invalid?.count).toBe(0);

  const [filterWithoutTiming] = await sql<CountRow[]>`
    SELECT count(*)::integer AS count
    FROM craftsman_availability_match_facts(NULL, NULL, true)
  `;
  expect(filterWithoutTiming?.count).toBe(0);
}

async function addMarking(
  calendar: ReturnType<typeof createCraftsmanAvailabilityRepository>,
  candidate: CandidateRow,
  availability: "AVAILABLE" | "BUSY" | "UNAVAILABLE",
  startsAt: Date,
  endsAt: Date,
): Promise<CraftsmanAvailabilityBlockId> {
  const blockId = randomUUID() as CraftsmanAvailabilityBlockId;
  const result = await calendar.add({
    actorUserId: candidate.ownerId as UserId,
    availability,
    blockId,
    commandId: randomUUID(),
    craftsmanProfileId: candidate.profileId as CraftsmanProfileId,
    endsAt,
    startsAt,
  });
  expect(result.status).toBe("APPLIED");
  return blockId;
}

function timed(filterIndicativelyAvailable: boolean) {
  return {
    endsAt: new Date("2098-06-01T11:30:00.000Z"),
    filterIndicativelyAvailable,
    limit: 100,
    startsAt: new Date("2098-06-01T10:30:00.000Z"),
  };
}

function factFor(
  facts: Awaited<
    ReturnType<
      ReturnType<
        typeof createCraftsmanAvailabilityMatchRepository
      >["findMatches"]
    >
  >,
  profileId: string,
) {
  return facts.find(
    ({ craftsmanProfileId }) => craftsmanProfileId === profileId,
  );
}

async function currentCandidateIds(sql: Sql): Promise<Set<string>> {
  return new Set(
    (await currentCandidates(sql)).map(({ profileId }) => profileId),
  );
}

async function currentCandidates(sql: Sql): Promise<readonly CandidateRow[]> {
  return sql<CandidateRow[]>`
    SELECT
      candidate.craftsman_profile_id AS "profileId",
      profile.owner_user_id AS "ownerId"
    FROM current_searchable_craftsman_profiles candidate
    JOIN craftsman_profiles profile
      ON profile.id = candidate.craftsman_profile_id
    ORDER BY candidate.craftsman_profile_id
  `;
}

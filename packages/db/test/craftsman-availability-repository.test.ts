import { createHash } from "node:crypto";

import type {
  AddCraftsmanAvailabilityBlockInput,
  CraftsmanAvailabilityBlockId,
  CraftsmanProfileId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  createCraftsmanAvailabilityRepository,
  CraftsmanAvailabilityIdempotencyError,
} from "../src/craftsman-availability-repository.js";

const ownerUserId = "73000000-0000-4000-8000-000000000001" as UserId;
const nonOwnerUserId = "73000000-0000-4000-8000-000000000002" as UserId;
const profileId = "73000000-0000-4000-8000-000000000003" as CraftsmanProfileId;
const blockId =
  "73000000-0000-4000-8000-000000000004" as CraftsmanAvailabilityBlockId;
const commandId = "73000000-0000-4000-8000-000000000005";

describe("craftsman availability repository", () => {
  it("fails closed for a non-owner before reading a command or block", async () => {
    const sql = scriptedSql([[]]);
    await expect(
      createCraftsmanAvailabilityRepository(sql).add({
        ...addInput(),
        actorUserId: nonOwnerUserId,
      }),
    ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
    expect(sql.queries).toHaveLength(1);
  });

  it("adds an immutable explicit marking without overlap or booking logic", async () => {
    const sql = scriptedSql([[ownedProfile()], [], [], [], [], [blockRow()]]);
    await expect(
      createCraftsmanAvailabilityRepository(sql).add(addInput()),
    ).resolves.toMatchObject({
      block: { availability: "AVAILABLE", revision: 1, state: "ACTIVE" },
      status: "APPLIED",
    });
    const statements = sql.queries.join("\n");
    expect(statements).toMatch(
      /INSERT INTO craftsman_availability_commands[\s\S]*INSERT INTO craftsman_availability_revisions/u,
    );
    expect(statements).not.toMatch(/overlap|booking|capacity|recurrence/iu);
  });

  it("uses CAS and records exact no-op replacement without a revision", async () => {
    const staleSql = scriptedSql([
      [ownedProfile()],
      [],
      [blockRow({ revision: 2 })],
    ]);
    await expect(
      createCraftsmanAvailabilityRepository(staleSql).replace({
        ...addInput(),
        commandId: "73000000-0000-4000-8000-000000000006",
        expectedRevision: 1,
      }),
    ).resolves.toEqual({ status: "STALE_REVISION" });

    const unchangedSql = scriptedSql([[ownedProfile()], [], [blockRow()], []]);
    await expect(
      createCraftsmanAvailabilityRepository(unchangedSql).replace({
        ...addInput(),
        commandId: "73000000-0000-4000-8000-000000000007",
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ status: "UNCHANGED" });
    expect(unchangedSql.queries.join("\n")).not.toMatch(
      /INSERT INTO craftsman_availability_revisions/u,
    );
  });

  it("deduplicates exact intent and rejects command reuse across payload or kind", async () => {
    const input = addInput();
    const exactSql = scriptedSql([
      [ownedProfile()],
      [commandRow("ADD", fingerprint("ADD", input))],
      [blockRow()],
    ]);
    await expect(
      createCraftsmanAvailabilityRepository(exactSql).add(input),
    ).resolves.toMatchObject({ status: "DEDUPLICATED" });

    for (const prior of [
      commandRow("REPLACE", fingerprint("ADD", input)),
      commandRow("ADD", "f".repeat(64)),
      {
        ...commandRow("ADD", fingerprint("ADD", input)),
        actorUserId: nonOwnerUserId,
      },
    ]) {
      const conflictSql = scriptedSql([[ownedProfile()], [prior]]);
      await expect(
        createCraftsmanAvailabilityRepository(conflictSql).add(input),
      ).rejects.toThrow(CraftsmanAvailabilityIdempotencyError);
    }
  });

  it("archives by carrying the marked range into a new history revision", async () => {
    const sql = scriptedSql([
      [ownedProfile()],
      [],
      [blockRow()],
      [],
      [],
      [blockRow({ archived: true, revision: 2 })],
    ]);
    await expect(
      createCraftsmanAvailabilityRepository(sql).archive({
        actorUserId: ownerUserId,
        blockId,
        commandId: "73000000-0000-4000-8000-000000000008",
        craftsmanProfileId: profileId,
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({
      block: { revision: 2, state: "ARCHIVED" },
      status: "APPLIED",
    });
  });
});

interface ScriptedSql extends Sql {
  readonly queries: string[];
}

function scriptedSql(responses: readonly unknown[][]): ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  const tagged = vi.fn((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as ScriptedSql;
  Object.assign(tagged, {
    begin: (work: (transaction: Sql) => Promise<unknown>) => work(tagged),
    queries,
  });
  return tagged;
}

function addInput(): AddCraftsmanAvailabilityBlockInput {
  return {
    actorUserId: ownerUserId,
    availability: "AVAILABLE",
    blockId,
    commandId,
    craftsmanProfileId: profileId,
    endsAt: new Date("2027-01-01T12:00:00.000Z"),
    startsAt: new Date("2027-01-01T09:00:00.000Z"),
  };
}

function ownedProfile() {
  return { accountState: "ACTIVE", ownerUserId };
}

function blockRow(
  options: { readonly archived?: boolean; readonly revision?: number } = {},
) {
  const changedAt = new Date("2026-09-14T09:00:00.000Z");
  return {
    archivedAt: options.archived ? changedAt : null,
    availability: "AVAILABLE",
    blockId,
    changedAt,
    craftsmanProfileId: profileId,
    createdAt: new Date("2026-09-14T08:00:00.000Z"),
    endsAt: addInput().endsAt,
    revision: options.revision ?? 1,
    startsAt: addInput().startsAt,
    state: options.archived ? "ARCHIVED" : "ACTIVE",
  };
}

function commandRow(kind: "ADD" | "REPLACE", payloadFingerprint: string) {
  return {
    actorUserId: ownerUserId,
    blockId,
    commandKind: kind,
    craftsmanProfileId: profileId,
    payloadFingerprint,
    resultingRevision: 1,
  };
}

function fingerprint(
  kind: "ADD",
  input: AddCraftsmanAvailabilityBlockInput,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        input.commandId,
        input.blockId,
        input.craftsmanProfileId,
        input.actorUserId,
        0,
        input.availability,
        input.startsAt.toISOString(),
        input.endsAt.toISOString(),
      ]),
      "utf8",
    )
    .digest("hex");
}

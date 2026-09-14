import { createHash } from "node:crypto";

import type {
  CraftsmanExperienceRevisionId,
  CraftsmanProfileId,
  ReplaceCraftsmanExperienceInput,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  createCraftsmanExperienceRepository,
  CraftsmanExperienceIdempotencyError,
} from "../src/craftsman-experience-repository.js";

const actorUserId = "50000000-0000-4000-8000-000000000001" as UserId;
const otherUserId = "50000000-0000-4000-8000-000000000002" as UserId;
const craftsmanProfileId =
  "50000000-0000-4000-8000-000000000003" as CraftsmanProfileId;
const commandId = "50000000-0000-4000-8000-000000000004";

describe("craftsman experience repository", () => {
  it("fails closed for a non-owner before command or experience reads", async () => {
    const sql = scriptedSql([[]]);
    await expect(
      createCraftsmanExperienceRepository(sql).replaceOwnedDraft({
        ...replacement(),
        actorUserId: otherUserId,
      }),
    ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]).toMatch(/FOR UPDATE OF profile, owner/u);
  });

  it("persists one command and self-declared revision", async () => {
    const sql = scriptedSql([
      [ownedProfile()],
      [],
      [],
      [{ resultKind: "APPLIED", resultingRevision: 1 }],
      [],
      [experienceRow()],
    ]);
    const result =
      await createCraftsmanExperienceRepository(sql).replaceOwnedDraft(
        replacement(),
      );

    expect(result).toMatchObject({
      experience: {
        provenance: "SELF_DECLARED",
        revision: 1,
        workingSinceYear: 2012,
      },
      status: "APPLIED",
    });
    expect(sql.queries.join("\n")).toMatch(
      /INSERT INTO craftsman_experience_commands[\s\S]*INSERT INTO craftsman_experience_revisions/u,
    );
  });

  it("records deterministic first-null UNCHANGED without a fake revision", async () => {
    const input = { ...replacement(), workingSinceYear: null };
    const sql = scriptedSql([
      [ownedProfile()],
      [],
      [],
      [{ resultKind: "UNCHANGED", resultingRevision: 0 }],
    ]);
    await expect(
      createCraftsmanExperienceRepository(sql).replaceOwnedDraft(input),
    ).resolves.toEqual({ experience: null, status: "UNCHANGED" });
    expect(sql.queries.join("\n")).not.toMatch(
      /INSERT INTO craftsman_experience_revisions/u,
    );
  });

  it("rechecks active ownership then returns an allowlisted original replay", async () => {
    const input = replacement();
    const command = {
      actorUserId,
      craftsmanProfileId,
      payloadFingerprint: fingerprint(input),
      resultKind: "APPLIED",
      resultingRevision: 1,
    } as const;
    const sql = scriptedSql([[ownedProfile()], [command], [experienceRow()]]);
    const result =
      await createCraftsmanExperienceRepository(sql).replaceOwnedDraft(input);
    expect(result).toMatchObject({ status: "DEDUPLICATED" });
    if (!("experience" in result) || result.experience === null) {
      throw new Error("Expected experience replay.");
    }
    expect(result.experience).not.toHaveProperty("payloadFingerprint");
    expect(result.experience).not.toHaveProperty("actorUserId");

    for (const conflictingCommand of [
      { ...command, payloadFingerprint: "f".repeat(64) },
      { ...command, actorUserId: otherUserId },
      {
        ...command,
        craftsmanProfileId:
          "50000000-0000-4000-8000-000000000099" as CraftsmanProfileId,
      },
    ]) {
      const conflict = scriptedSql([[ownedProfile()], [conflictingCommand]]);
      await expect(
        createCraftsmanExperienceRepository(conflict).replaceOwnedDraft(input),
      ).rejects.toThrow(CraftsmanExperienceIdempotencyError);
    }
  });

  it("does not expose an existing command replay after owner suspension", async () => {
    const sql = scriptedSql([
      [],
      [
        {
          actorUserId,
          craftsmanProfileId,
          payloadFingerprint: fingerprint(replacement()),
          resultKind: "APPLIED",
          resultingRevision: 1,
        },
      ],
    ]);
    await expect(
      createCraftsmanExperienceRepository(sql).replaceOwnedDraft(replacement()),
    ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]).not.toMatch(/craftsman_experience_commands/u);
  });

  it("enforces revision CAS and stores null clearing as a real revision", async () => {
    const stale = scriptedSql([
      [ownedProfile()],
      [],
      [experienceRow({ revision: 2 })],
    ]);
    await expect(
      createCraftsmanExperienceRepository(stale).replaceOwnedDraft(
        replacement(),
      ),
    ).resolves.toEqual({ status: "STALE_REVISION" });

    const clearInput = {
      ...replacement(),
      commandId: "50000000-0000-4000-8000-000000000005",
      expectedRevision: 1,
      workingSinceYear: null,
    };
    const clear = scriptedSql([
      [ownedProfile()],
      [],
      [experienceRow()],
      [{ resultKind: "APPLIED", resultingRevision: 2 }],
      [],
      [experienceRow({ revision: 2, workingSinceYear: null })],
    ]);
    await expect(
      createCraftsmanExperienceRepository(clear).replaceOwnedDraft(clearInput),
    ).resolves.toMatchObject({
      experience: { revision: 2, workingSinceYear: null },
      status: "APPLIED",
    });
  });

  it("keeps reads private to the active owner", async () => {
    const sql = scriptedSql([[experienceRow()]]);
    await expect(
      createCraftsmanExperienceRepository(sql).findOwned({
        actorUserId,
        craftsmanProfileId,
      }),
    ).resolves.toMatchObject({ workingSinceYear: 2012 });
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]).toMatch(
      /FROM current_craftsman_experience current[\s\S]*JOIN users owner[\s\S]*profile\.owner_user_id[\s\S]*owner\.account_state = 'ACTIVE'/u,
    );
    await expect(
      createCraftsmanExperienceRepository(scriptedSql([[]])).findOwned({
        actorUserId,
        craftsmanProfileId,
      }),
    ).resolves.toBeNull();
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

function replacement(): ReplaceCraftsmanExperienceInput {
  return {
    actorUserId,
    commandId,
    craftsmanProfileId,
    expectedRevision: 0,
    workingSinceYear: 2012,
  };
}

function ownedProfile() {
  return { accountState: "ACTIVE", ownerUserId: actorUserId };
}

function experienceRow(
  input: {
    readonly revision?: number;
    readonly workingSinceYear?: number | null;
  } = {},
) {
  return {
    craftsmanProfileId,
    createdAt: new Date("2026-09-14T09:00:00.000Z"),
    id: "50000000-0000-4000-8000-000000000006" as CraftsmanExperienceRevisionId,
    revision: input.revision ?? 1,
    workingSinceYear:
      input.workingSinceYear === undefined ? 2012 : input.workingSinceYear,
  };
}

function fingerprint(input: ReplaceCraftsmanExperienceInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.commandId,
        input.craftsmanProfileId,
        input.actorUserId,
        input.expectedRevision,
        input.workingSinceYear,
      ]),
      "utf8",
    )
    .digest("hex");
}

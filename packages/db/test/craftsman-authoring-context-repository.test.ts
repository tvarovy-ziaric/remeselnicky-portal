import type { CraftsmanProfileId, UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createCraftsmanAuthoringContextRepository } from "../src/craftsman-authoring-context-repository.js";

const actorUserId = "9d320000-0000-4000-8000-000000000001" as UserId;
const profileId = "9d320000-0000-4000-8000-000000000002" as CraftsmanProfileId;

describe("craftsman authoring context repository", () => {
  it("finds only the ACTIVE session owner's profile identity", async () => {
    const sql = scriptedSql([[{ id: profileId }]]);
    await expect(
      createCraftsmanAuthoringContextRepository(sql).findOwnedProfileId(
        actorUserId,
      ),
    ).resolves.toBe(profileId);

    expect(sql.queries[0]).toMatch(
      /profile\.owner_user_id = [\s\S]*owner\.account_state = 'ACTIVE'/u,
    );
    expect(sql.values[0]).toEqual([actorUserId]);
  });

  it("returns null without disclosing whether another profile exists", async () => {
    const sql = scriptedSql([[]]);
    await expect(
      createCraftsmanAuthoringContextRepository(sql).findOwnedProfileId(
        actorUserId,
      ),
    ).resolves.toBeNull();
  });

  it("resolves only an active profession in the latest approved canonical release", async () => {
    const taxonomyReleaseId = "9d320000-0000-4000-8000-000000000003";
    const sql = scriptedSql([
      [{ professionCode: "PROF:TILER", taxonomyReleaseId }],
    ]);
    await expect(
      createCraftsmanAuthoringContextRepository(sql).resolveCurrentProfession(
        "PROF:TILER",
      ),
    ).resolves.toEqual({ professionCode: "PROF:TILER", taxonomyReleaseId });

    const query = sql.queries[0] ?? "";
    expect(query).toContain("profession_taxonomy_activation_events");
    expect(query).toContain("max(latest.activation_sequence)");
    expect(query).toContain("content_class = 'CANONICAL'");
    expect(query).toContain("review_state = 'HUMAN_REVIEW_APPROVED'");
    expect(query).toContain("profession.state = 'ACTIVE'");
    expect(sql.values[0]).toEqual(["PROF:TILER"]);
  });

  it("rejects malformed identities before querying", async () => {
    const sql = scriptedSql([]);
    const repository = createCraftsmanAuthoringContextRepository(sql);
    await expect(
      repository.findOwnedProfileId("not-a-user" as UserId),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.resolveCurrentProfession("../../private"),
    ).rejects.toThrow(TypeError);
    expect(sql.queries).toEqual([]);
  });
});

interface ScriptedSql {
  readonly queries: string[];
  readonly values: unknown[][];
}

function scriptedSql(responses: readonly unknown[][]): Sql & ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  const values: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...parameters: unknown[]) => {
    queries.push(
      strings.reduce(
        (query, fragment, index) =>
          `${query}${fragment}${index < parameters.length ? `$${index + 1}` : ""}`,
        "",
      ),
    );
    values.push(parameters);
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as Sql & ScriptedSql;
  Object.defineProperties(sql, {
    queries: { value: queries },
    values: { value: values },
  });
  return sql;
}

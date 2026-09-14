import type { CraftsmanProfileId, UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createCraftsmanCapabilityRepository } from "../src/craftsman-capability-repository.js";

const actorUserId = "42000000-0000-4000-8000-000000000001" as UserId;
const craftsmanProfileId =
  "42000000-0000-4000-8000-000000000002" as CraftsmanProfileId;

describe("craftsman capability repository", () => {
  it("holds the active-owner lock while reading both private collections", async () => {
    const sql = scriptedSql([
      [{ accountState: "ACTIVE", ownerUserId: actorUserId }],
      [],
      [],
    ]);
    await expect(
      createCraftsmanCapabilityRepository(sql).listOwned({
        actorUserId,
        craftsmanProfileId,
      }),
    ).resolves.toEqual({ skills: [], specializations: [] });
    expect(sql.beginCount).toBe(1);
    expect(sql.queries).toHaveLength(3);
    expect(sql.queries[0]).toMatch(
      /JOIN users owner[\s\S]*FOR UPDATE OF profile, owner/u,
    );
    expect(sql.queries[1]).toMatch(/current_craftsman_specializations/u);
    expect(sql.queries[2]).toMatch(/current_craftsman_skills/u);
  });

  it("does not read either collection after a suspended-owner result", async () => {
    const sql = scriptedSql([
      [{ accountState: "SUSPENDED", ownerUserId: actorUserId }],
      [{ privateData: "must not be consumed" }],
    ]);
    await expect(
      createCraftsmanCapabilityRepository(sql).listOwned({
        actorUserId,
        craftsmanProfileId,
      }),
    ).resolves.toEqual({ skills: [], specializations: [] });
    expect(sql.queries).toHaveLength(1);
  });
});

interface ScriptedSql extends Sql {
  readonly beginCount: number;
  readonly queries: string[];
}

function scriptedSql(responses: readonly unknown[][]): ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  let beginCount = 0;
  const tagged = vi.fn((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as ScriptedSql;
  Object.defineProperty(tagged, "beginCount", {
    get: () => beginCount,
  });
  Object.assign(tagged, {
    begin: (work: (transaction: Sql) => Promise<unknown>) => {
      beginCount += 1;
      return work(tagged);
    },
    queries,
  });
  return tagged;
}

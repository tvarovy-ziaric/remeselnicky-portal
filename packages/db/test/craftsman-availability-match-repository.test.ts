import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createCraftsmanAvailabilityMatchRepository } from "../src/craftsman-availability-match-repository.js";

const availableId = "97000000-0000-4000-8000-000000000001";
const unavailableId = "97000000-0000-4000-8000-000000000002";

describe("craftsman availability match repository", () => {
  it("rejects malformed timing before opening a snapshot", async () => {
    const sql = scriptedSql([]);
    await expect(
      repository(sql).findMatches({
        endsAt: null,
        filterIndicativelyAvailable: true,
        limit: 20,
        startsAt: null,
      }),
    ).rejects.toThrow(/availability match/u);
    expect(sql.queries).toEqual([]);
    expect(sql.beginOptions).toEqual([]);
  });

  it("keeps omitted timing neutral and uses a repeatable read snapshot", async () => {
    const sql = scriptedSql([[row(availableId, "TIMING_NOT_SUPPLIED", false)]]);
    await expect(
      repository(sql).findMatches({
        endsAt: null,
        filterIndicativelyAvailable: false,
        limit: 20,
        startsAt: null,
      }),
    ).resolves.toEqual([
      {
        craftsmanProfileId: availableId,
        indicativelyAvailable: false,
        matchKind: "TIMING_NOT_SUPPLIED",
      },
    ]);
    expect(sql.beginOptions).toEqual([
      "isolation level repeatable read read only",
    ]);
  });

  it("keeps unavailable and mixed rows in ordinary search as neutral categories", async () => {
    const sql = scriptedSql([
      [
        row(availableId, "AVAILABLE_OVERLAP", true),
        row(unavailableId, "UNAVAILABLE_OVERLAP", false),
        row("97000000-0000-4000-8000-000000000003", "MIXED_OVERLAP", false),
      ],
    ]);
    const result = await repository(sql).findMatches(timed(false));
    expect(result.map(({ matchKind }) => matchKind)).toEqual([
      "AVAILABLE_OVERLAP",
      "UNAVAILABLE_OVERLAP",
      "MIXED_OVERLAP",
    ]);
    const query = sql.queries[0] ?? "";
    expect(query).toContain("craftsman_availability_match_facts");
    expect(query).toContain("WHEN 'AVAILABLE_OVERLAP' THEN 0");
    expect(query).toContain("craftsman_profile_id ASC");
  });

  it("passes the explicit opt-in flag to the server function", async () => {
    const sql = scriptedSql([[row(availableId, "AVAILABLE_OVERLAP", true)]]);
    await expect(
      repository(sql).findMatches(timed(true)),
    ).resolves.toHaveLength(1);
    expect(sql.values[0]).toContain(true);
  });

  it.each([
    row(availableId, "MIXED_OVERLAP", true),
    row(availableId, "AVAILABLE_OVERLAP", false),
    row(availableId, "UNKNOWN", false),
    {
      ...row(availableId, "AVAILABLE_OVERLAP", true),
      indicativelyAvailable: 1,
    },
  ])("fails closed on malformed server facts %#", async (malformed) => {
    const sql = scriptedSql([[malformed]]);
    await expect(repository(sql).findMatches(timed(false))).rejects.toThrow(
      /availability match/u,
    );
  });

  it("projects a frozen allowlist with no exact private fields", async () => {
    const sql = scriptedSql([[row(availableId, "AVAILABLE_OVERLAP", true)]]);
    const result = await repository(sql).findMatches(timed(false));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(Object.keys(result[0] ?? {})).toEqual([
      "craftsmanProfileId",
      "indicativelyAvailable",
      "matchKind",
    ]);
  });
});

interface ScriptedSql extends Sql {
  readonly beginOptions: string[];
  readonly queries: string[];
  readonly values: unknown[][];
}

function repository(sql: Sql) {
  return createCraftsmanAvailabilityMatchRepository(sql);
}

function scriptedSql(responses: unknown[][]): ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  const values: unknown[][] = [];
  const beginOptions: string[] = [];
  const tagged = vi.fn(
    (strings: TemplateStringsArray, ...parameters: unknown[]) => {
      queries.push(strings.join("?"));
      values.push(parameters);
      return Promise.resolve(queue.shift() ?? []);
    },
  ) as unknown as ScriptedSql;
  Object.assign(tagged, {
    begin: (options: string, work: (transaction: Sql) => Promise<unknown>) => {
      beginOptions.push(options);
      return work(tagged);
    },
    beginOptions,
    queries,
    values,
  });
  return tagged;
}

function timed(filterIndicativelyAvailable: boolean) {
  return {
    endsAt: new Date("2028-06-01T12:00:00.000Z"),
    filterIndicativelyAvailable,
    limit: 20,
    startsAt: new Date("2028-06-01T10:00:00.000Z"),
  };
}

function row(
  craftsmanProfileId: string,
  matchKind: string,
  indicativelyAvailable: boolean,
) {
  return { craftsmanProfileId, indicativelyAvailable, matchKind };
}

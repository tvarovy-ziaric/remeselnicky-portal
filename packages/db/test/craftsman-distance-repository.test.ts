import type { MunicipalityCode } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createCraftsmanDistanceRepository } from "../src/craftsman-distance-repository.js";

const municipalityCode = "TEST:MUNICIPALITY" as MunicipalityCode;

describe("craftsman distance repository", () => {
  it("rejects invalid query input before touching PostgreSQL", async () => {
    const sql = scriptedSql([]);
    await expect(
      repository(sql).findPublicDistanceFacts({
        limit: 0,
        municipalityCode,
      }),
    ).rejects.toThrow(/distance query/u);
    expect(sql.queries).toEqual([]);
    expect(sql.beginOptions).toEqual([]);
  });

  it("fails closed on an unknown or inactive origin before reading candidates", async () => {
    const sql = scriptedSql([[{ available: false }]]);
    await expect(
      repository(sql).findPublicDistanceFacts({
        limit: 20,
        municipalityCode,
      }),
    ).resolves.toEqual({ status: "LOCATION_UNAVAILABLE" });
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]).toContain("location_municipalities");
    expect(sql.queries[0]).not.toContain("public_craftsman_distance_facts");
    expect(sql.beginOptions).toEqual([
      "isolation level repeatable read read only",
    ]);
  });

  it("returns deterministic internal facts for a governed origin", async () => {
    const sql = scriptedSql([
      [{ available: true }],
      [
        {
          approximateDistanceKm: 0,
          craftsmanProfileId: "74000000-0000-4000-8000-000000000001",
          latitude: 48.123456,
          rankingDistanceMeters: 0,
          storageKey: "private/must-not-leak",
        },
        {
          approximateDistanceKm: 18,
          craftsmanProfileId: "74000000-0000-4000-8000-000000000002",
          rankingDistanceMeters: 17_501,
        },
      ],
    ]);
    const result = await repository(sql).findPublicDistanceFacts({
      limit: 20,
      municipalityCode,
    });

    expect(result).toEqual({
      facts: [
        {
          approximateDistanceKm: 0,
          craftsmanProfileId: "74000000-0000-4000-8000-000000000001",
          rankingDistanceMeters: 0,
        },
        {
          approximateDistanceKm: 18,
          craftsmanProfileId: "74000000-0000-4000-8000-000000000002",
          rankingDistanceMeters: 17_501,
        },
      ],
      status: "OK",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /latitude|longitude|coordinate|address|storage|sha256/iu,
    );
    const query = sql.queries[1] ?? "";
    expect(query).toContain("public_craftsman_distance_facts");
    expect(query).toMatch(
      /ranking_distance_meters ASC NULLS LAST[\s\S]*craftsman_profile_id ASC/u,
    );
    expect(sql.beginOptions).toEqual([
      "isolation level repeatable read read only",
    ]);
  });

  it("keeps candidates but marks distance unavailable when location is omitted", async () => {
    const sql = scriptedSql([
      [
        {
          approximateDistanceKm: null,
          craftsmanProfileId: "74000000-0000-4000-8000-000000000001",
          rankingDistanceMeters: null,
        },
      ],
    ]);
    await expect(
      repository(sql).findPublicDistanceFacts({
        limit: 20,
        municipalityCode: null,
      }),
    ).resolves.toEqual({
      facts: [
        {
          approximateDistanceKm: null,
          craftsmanProfileId: "74000000-0000-4000-8000-000000000001",
          rankingDistanceMeters: null,
        },
      ],
      status: "OK",
    });
    expect(sql.queries).toHaveLength(1);
  });
});

interface ScriptedSql extends Sql {
  readonly beginOptions: string[];
  readonly queries: string[];
}

function repository(sql: Sql) {
  return createCraftsmanDistanceRepository(sql);
}

function scriptedSql(responses: unknown[][]): ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  const beginOptions: string[] = [];
  const tagged = vi.fn((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as ScriptedSql;
  Object.assign(tagged, {
    begin: (options: string, work: (transaction: Sql) => Promise<unknown>) => {
      beginOptions.push(options);
      return work(tagged);
    },
    beginOptions,
    queries,
  });
  return tagged;
}

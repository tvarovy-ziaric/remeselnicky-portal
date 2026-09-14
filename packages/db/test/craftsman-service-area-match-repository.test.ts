import type { MunicipalityCode } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createCraftsmanServiceAreaMatchRepository } from "../src/craftsman-service-area-match-repository.js";

const municipalityCode = "TEST:MUNICIPALITY" as MunicipalityCode;

describe("craftsman service-area match repository", () => {
  it("rejects malformed input before opening a snapshot", async () => {
    const sql = scriptedSql([]);
    await expect(
      repository(sql).findMatches({
        includeOutsideDeclaredArea: 1 as unknown as boolean,
        limit: 20,
        municipalityCode,
      }),
    ).rejects.toThrow(/service-area match/u);
    expect(sql.queries).toEqual([]);
    expect(sql.beginOptions).toEqual([]);
  });

  it("returns a uniform absence for an unknown or inactive origin", async () => {
    const sql = scriptedSql([[{ available: false }]]);
    await expect(
      repository(sql).findMatches({
        includeOutsideDeclaredArea: false,
        limit: 20,
        municipalityCode,
      }),
    ).resolves.toEqual({ status: "LOCATION_UNAVAILABLE" });
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]).not.toContain("craftsman_service_area_match_facts");
  });

  it("returns deterministic strong, farther-by-agreement, then explicit outside matches", async () => {
    const sql = scriptedSql([
      [{ available: true }],
      [
        row(
          "94000000-0000-4000-8000-000000000001",
          "ADDITIONAL_SERVICE_AREA",
          2_000,
        ),
        row(
          "94000000-0000-4000-8000-000000000002",
          "WITHIN_NORMAL_RADIUS",
          5_000,
        ),
        row(
          "94000000-0000-4000-8000-000000000003",
          "WITHIN_MAXIMUM_RADIUS",
          15_000,
        ),
        row(
          "94000000-0000-4000-8000-000000000004",
          "OUTSIDE_DECLARED_AREA",
          30_000,
        ),
      ],
    ]);
    const result = await repository(sql).findMatches({
      includeOutsideDeclaredArea: true,
      limit: 20,
      municipalityCode,
    });
    expect(result).toMatchObject({
      matches: [
        { matchKind: "ADDITIONAL_SERVICE_AREA" },
        { matchKind: "WITHIN_NORMAL_RADIUS" },
        { matchKind: "WITHIN_MAXIMUM_RADIUS" },
        { matchKind: "OUTSIDE_DECLARED_AREA" },
      ],
      status: "OK",
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === "OK")
      expect(Object.isFrozen(result.matches)).toBe(true);
    const query = sql.queries[1] ?? "";
    expect(query).toContain("craftsman_service_area_match_facts");
    expect(query).toContain("WHEN 'WITHIN_MAXIMUM_RADIUS' THEN 1");
    expect(query).toContain("WHEN 'OUTSIDE_DECLARED_AREA' THEN 2");
    expect(query).toMatch(
      /ranking_distance_meters ASC NULLS LAST[\s\S]*craftsman_profile_id ASC/u,
    );
  });

  it("keeps omitted-origin candidates neutral without a location preflight", async () => {
    const sql = scriptedSql([
      [
        {
          approximateDistanceKm: null,
          craftsmanProfileId: "94000000-0000-4000-8000-000000000001",
          matchKind: "DISTANCE_UNAVAILABLE",
          rankingDistanceMeters: null,
        },
      ],
    ]);
    await expect(
      repository(sql).findMatches({
        includeOutsideDeclaredArea: false,
        limit: 20,
        municipalityCode: null,
      }),
    ).resolves.toEqual({
      matches: [
        {
          approximateDistanceKm: null,
          craftsmanProfileId: "94000000-0000-4000-8000-000000000001",
          matchKind: "DISTANCE_UNAVAILABLE",
          rankingDistanceMeters: null,
        },
      ],
      status: "OK",
    });
    expect(sql.queries).toHaveLength(1);
  });

  it("fails closed on a malformed persisted band/distance pair", async () => {
    const sql = scriptedSql([
      [
        {
          approximateDistanceKm: null,
          craftsmanProfileId: "94000000-0000-4000-8000-000000000001",
          matchKind: "WITHIN_NORMAL_RADIUS",
          rankingDistanceMeters: null,
        },
      ],
    ]);
    await expect(
      repository(sql).findMatches({
        includeOutsideDeclaredArea: false,
        limit: 20,
        municipalityCode: null,
      }),
    ).rejects.toThrow(/service-area match/u);
  });
});

interface ScriptedSql extends Sql {
  readonly beginOptions: string[];
  readonly queries: string[];
}

function repository(sql: Sql) {
  return createCraftsmanServiceAreaMatchRepository(sql);
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

function row(profileId: string, matchKind: string, metres: number) {
  return {
    approximateDistanceKm: Math.round(metres / 1000),
    craftsmanProfileId: profileId,
    matchKind,
    rankingDistanceMeters: metres,
  };
}

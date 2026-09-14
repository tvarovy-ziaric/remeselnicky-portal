import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CRAFTSMAN_SERVICE_AREA_MATCH_FUNCTION,
  CRAFTSMAN_SERVICE_AREA_MATCH_RESULT_COLUMNS,
} from "../src/schema/craftsman-service-area-match.js";

const migration = readFileSync(
  new URL(
    "../migrations/0031_craftsman_service_area_matching.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("craftsman service-area matching SQL boundary", () => {
  it("classifies the live 0029 candidates using only 0030 distance facts", () => {
    expect(migration).toContain(
      `CREATE FUNCTION ${CRAFTSMAN_SERVICE_AREA_MATCH_FUNCTION}`,
    );
    expect(migration).toContain("current_searchable_craftsman_profiles");
    expect(migration).toContain("public_craftsman_distance_facts");
    expect(migration).toContain("STABLE");
    expect(migration).toContain("SECURITY INVOKER");
    expect(migration).toContain("SET search_path = pg_catalog, public");
    expect(migration).not.toMatch(/CREATE TABLE|MATERIALIZED|ST_Distance/iu);
  });

  it("keeps additional and normal areas strong, maximum default-eligible, and outside explicit", () => {
    const additional = migration.indexOf("THEN 'ADDITIONAL_SERVICE_AREA'");
    const normal = migration.indexOf("THEN 'WITHIN_NORMAL_RADIUS'");
    const maximum = migration.indexOf("THEN 'WITHIN_MAXIMUM_RADIUS'");
    const outside = migration.indexOf("ELSE 'OUTSIDE_DECLARED_AREA'");
    expect(additional).toBeGreaterThan(0);
    expect(additional).toBeLessThan(normal);
    expect(normal).toBeLessThan(maximum);
    expect(maximum).toBeLessThan(outside);
    expect(migration).toContain(
      "distance.ranking_distance_meters <= candidate.normal_radius_meters",
    );
    expect(migration).toContain(
      "distance.ranking_distance_meters <= candidate.maximum_radius_meters",
    );
    expect(migration).toContain(
      "classified.match_kind <> 'OUTSIDE_DECLARED_AREA'",
    );
    expect(migration).toContain(
      "OR COALESCE(include_outside_declared_area, false)",
    );
    expect(migration).not.toMatch(
      /classified\.match_kind <> 'WITHIN_MAXIMUM_RADIUS'/u,
    );
  });

  it("treats an omitted origin as neutral and retains every candidate", () => {
    expect(migration).toMatch(
      /WHEN query_municipality_code IS NULL\s+THEN 'DISTANCE_UNAVAILABLE'/u,
    );
    expect(migration).toContain("ranking_distance_meters ASC NULLS LAST");
    expect(migration).toContain("classified.craftsman_profile_id ASC");
  });

  it("returns only server facts and no private geography or policy text", () => {
    expect(CRAFTSMAN_SERVICE_AREA_MATCH_RESULT_COLUMNS).toEqual([
      "craftsman_profile_id",
      "match_kind",
      "ranking_distance_meters",
      "approximate_distance_km",
    ]);
    const returns = migration.match(
      /RETURNS TABLE \(([\s\S]*?)\)\s*LANGUAGE/u,
    )?.[1];
    expect(returns).toBeDefined();
    expect(returns).not.toMatch(
      /owner|centroid|latitude|longitude|coordinate|address|street|postal|travel_fee|policy|normal_radius|maximum_radius|extra_municipality/iu,
    );
  });

  it("documents preference semantics without inventing an acceptance or price rule", () => {
    expect(migration).toContain("never a contractual acceptance");
    expect(migration).not.toMatch(
      /auto.?price|hard.?reject|guaranteed_available|booking_state/iu,
    );
  });
});

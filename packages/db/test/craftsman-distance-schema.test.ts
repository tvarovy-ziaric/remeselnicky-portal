import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0030_craftsman_distance_facts.sql", import.meta.url),
  "utf8",
);

describe("R2 craftsman distance SQL boundary", () => {
  it("uses a stable SECURITY INVOKER PostGIS query over the live candidate seam", () => {
    expect(migration).toContain(
      "CREATE FUNCTION public_craftsman_distance_facts",
    );
    expect(migration).toContain("STABLE");
    expect(migration).toContain("SECURITY INVOKER");
    expect(migration).toContain("SET search_path = pg_catalog, public");
    expect(migration).toContain("current_searchable_craftsman_profiles");
    expect(migration).toContain("current_craftsman_service_areas");
    expect(migration).toContain("public.ST_Distance");
  });

  it("returns only the profile id and bounded distance facts", () => {
    const returns = migration.match(
      /RETURNS TABLE \(([\s\S]*?)\)\s*LANGUAGE/u,
    )?.[1];
    expect(returns).toBeDefined();
    expect(returns).toContain("craftsman_profile_id uuid");
    expect(returns).toContain("ranking_distance_meters integer");
    expect(returns).toContain("approximate_distance_km integer");
    expect(returns).not.toMatch(
      /owner|centroid|latitude|longitude|coordinate|address|street|postal/iu,
    );
    expect(migration).toContain("LEAST(\n          20040000::bigint");
  });

  it("sorts null distances last and resolves ties by stable profile identity", () => {
    expect(migration).toMatch(
      /ranking_distance_meters ASC NULLS LAST,\s*measured\.craftsman_profile_id ASC/u,
    );
  });

  it("does not invent service-radius or client-coordinate semantics", () => {
    expect(migration).not.toMatch(/ST_DWithin|normal_radius|maximum_radius/iu);
    expect(migration).not.toMatch(
      /query_(latitude|longitude|coordinate)|input_(latitude|longitude)/iu,
    );
  });
});

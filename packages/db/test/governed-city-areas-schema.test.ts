import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migration = await readFile(
  new URL("../migrations/0122_governed_city_areas.sql", import.meta.url),
  "utf8",
);

describe("governed whole-city area schema", () => {
  it("keeps canonical municipality rows and explicit many-member provenance", () => {
    expect(migration).toContain("CREATE TABLE location_city_areas");
    expect(migration).toContain("CREATE TABLE location_city_area_members");
    expect(migration).toContain(
      "REFERENCES location_municipalities(code) ON DELETE RESTRICT",
    );
    expect(migration).toContain(
      "PRIMARY KEY (city_area_code, municipality_code)",
    );
    expect(migration).not.toContain("location_municipality_postal_codes");
  });

  it("expands city membership before radius bands", () => {
    expect(migration).toContain("governed_locations_overlap");
    expect(migration).toMatch(
      /WHEN public\.governed_locations_overlap\([\s\S]*WITHIN_NORMAL_RADIUS/u,
    );
    expect(migration).toMatch(
      /unnest\(candidate\.extra_municipality_codes\)[\s\S]*ADDITIONAL_SERVICE_AREA/u,
    );
  });
});

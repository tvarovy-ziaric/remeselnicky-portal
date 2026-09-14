import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  craftsmanServiceAreaCommands,
  craftsmanServiceAreaExtraMunicipalities,
  craftsmanServiceAreaRevisions,
  locationDistricts,
  locationMunicipalities,
  locationRegions,
} from "../src/index.js";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0018_craftsman_service_area.sql", import.meta.url),
  ),
  "utf8",
);

describe("normalized location and craftsman service-area schema", () => {
  it("models the governed region to district to municipality hierarchy", () => {
    expect(
      getTableConfig(locationRegions).columns.map(({ name }) => name),
    ).toEqual([
      "code",
      "name_sk",
      "source_reference",
      "source_revision",
      "is_active",
      "created_at",
      "updated_at",
    ]);
    expect(getTableConfig(locationDistricts).foreignKeys).toHaveLength(1);
    expect(getTableConfig(locationMunicipalities).foreignKeys).toHaveLength(1);
    expect(migration).toContain(
      "region_code text NOT NULL REFERENCES location_regions(code)",
    );
    expect(migration).toContain(
      "district_code text NOT NULL REFERENCES location_districts(code)",
    );
    expect(
      getTableConfig(locationMunicipalities).columns.map(({ name }) => name),
    ).toContain("centroid");
  });

  it("uses a municipality-only PostGIS geography point and geo index", () => {
    expect(migration).toMatch(/centroid geography\(Point, 4326\) NOT NULL/u);
    expect(migration).toContain("location_municipalities_centroid_shape");
    expect(migration).toMatch(/ST_SRID\(centroid::geometry\) = 4326/u);
    expect(migration).toContain("ST_X(centroid::geometry) BETWEEN 16 AND 23");
    expect(migration).toContain("ST_Y(centroid::geometry) BETWEEN 47 AND 50");
    expect(migration).toMatch(/USING gist \(centroid\)/u);
    const regionDefinition = migration.match(
      /CREATE TABLE location_regions \(([\s\S]*?)\n\);/u,
    )?.[1];
    const districtDefinition = migration.match(
      /CREATE TABLE location_districts \(([\s\S]*?)\n\);/u,
    )?.[1];
    expect(regionDefinition).not.toContain("centroid");
    expect(districtDefinition).not.toContain("centroid");
  });

  it("ships no invented real Slovak location content and preserves catalog history", () => {
    expect(migration).not.toMatch(
      /INSERT INTO location_(regions|districts|municipalities)/u,
    );
    expect(migration).toContain(
      "governed location catalog rows are append-only",
    );
    expect(migration).toContain("source_reference text NOT NULL");
    expect(migration).toContain("source_revision text NOT NULL");
  });

  it("keeps an append-only profile-wide preference with command provenance", () => {
    expect(
      getTableConfig(craftsmanServiceAreaCommands).columns.map(
        ({ name }) => name,
      ),
    ).toEqual(
      expect.arrayContaining([
        "craftsman_profile_id",
        "actor_user_id",
        "expected_revision",
        "resulting_revision",
        "base_municipality_code",
        "normal_radius_meters",
        "maximum_radius_meters",
        "extra_municipality_codes",
        "travel_fee_policy",
        "travel_fee_threshold_meters",
        "payload_fingerprint",
      ]),
    );
    expect(
      getTableConfig(craftsmanServiceAreaRevisions).uniqueConstraints,
    ).toHaveLength(1);
    expect(migration).toContain("command_id uuid NOT NULL UNIQUE");
    expect(
      getTableConfig(craftsmanServiceAreaExtraMunicipalities).primaryKeys,
    ).toHaveLength(1);
    expect(migration).toContain(
      "service-area revision must exactly match applied command provenance",
    );
    expect(migration).toContain(
      "unchanged service-area command must match current state exactly",
    );
    expect(migration).toContain("NEW.revision := source.resulting_revision");
    expect(migration).toContain("NEW.created_at := source.created_at");
    expect(migration).toContain(
      "craftsman service-area history is append-only",
    );
    expect(migration).toContain("FOR UPDATE OF profile, owner");
    expect(migration).toContain("owner_state <> 'ACTIVE'");
  });

  it("keeps schema extensible beyond the alpha owner-command UX cap", () => {
    expect(migration).toContain(
      "jsonb_array_length(extra_municipality_codes) <= 256",
    );
    expect(migration).not.toContain(
      "jsonb_array_length(extra_municipality_codes) <= 3",
    );
    expect(migration).not.toMatch(/ordinal <= 3/u);
  });

  it("stores no exact address, contact, profession-specific area or automatic price", () => {
    const columns = [
      ...getTableConfig(craftsmanServiceAreaCommands).columns,
      ...getTableConfig(craftsmanServiceAreaRevisions).columns,
    ].map(({ name }) => name);
    expect(columns).not.toEqual(
      expect.arrayContaining([
        "street",
        "house_number",
        "postal_address",
        "latitude",
        "longitude",
        "email",
        "phone",
        "profession_code",
        "travel_fee_amount",
      ]),
    );
    expect(migration).toContain("radius is a matching preference");
  });
});

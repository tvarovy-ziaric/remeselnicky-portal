import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../migrations/0116_location_postal_reference.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const importer = readFileSync(
  fileURLToPath(
    new URL("../src/slovakia-location-import-cli.ts", import.meta.url),
  ),
  "utf8",
);

describe("postal reference schema and importer", () => {
  it("models PSČ independently with a temporal many-to-many relationship", () => {
    expect(migration).toContain("CREATE TABLE location_postal_codes");
    expect(migration).toContain(
      "CREATE TABLE location_municipality_postal_codes",
    );
    expect(migration).toContain(
      "REFERENCES location_municipalities(code) ON DELETE RESTRICT",
    );
    expect(migration).toContain(
      "REFERENCES location_postal_codes(code) ON DELETE RESTRICT",
    );
    expect(migration).toContain(
      "PRIMARY KEY (municipality_code, postal_code, valid_from)",
    );
    expect(migration).toContain("valid_to date");
    expect(migration).toContain("is_active boolean NOT NULL DEFAULT true");
    expect(migration).not.toMatch(/UNIQUE\s*\(municipality_code\)/u);
    expect(migration).not.toMatch(/UNIQUE\s*\(postal_code\)/u);
  });

  it("enforces canonical PSČ and append-safe provenance", () => {
    expect(migration).toContain("code ~ '^[0-9]{5}$'");
    expect(migration).toContain("CREATE TABLE location_reference_imports");
    expect(migration).toContain("snapshot_sha256 char(64) NOT NULL UNIQUE");
    expect(importer).toContain("pg_advisory_xact_lock");
    expect(importer).toContain("ON CONFLICT (code) DO NOTHING");
    expect(importer).not.toMatch(/\bDELETE\s+FROM\b/iu);
    expect(importer).not.toMatch(/\bTRUNCATE\b/iu);
  });
});

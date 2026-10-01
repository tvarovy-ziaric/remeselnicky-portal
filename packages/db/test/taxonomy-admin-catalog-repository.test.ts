import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../src/taxonomy-suggestion-repository.ts", import.meta.url),
  "utf8",
);

describe("admin taxonomy catalog immutable release contract", () => {
  it("creates and activates a successor instead of rewriting current rows", () => {
    expect(source).toContain("INSERT INTO profession_taxonomy_releases");
    expect(source).toContain("supersedes_release_id");
    expect(source).toContain(
      "INSERT INTO profession_taxonomy_activation_events",
    );
    expect(source).not.toMatch(
      /UPDATE taxonomy_(?:professions|services|aliases)/u,
    );
    expect(source).not.toMatch(
      /DELETE FROM taxonomy_(?:professions|services|aliases)/u,
    );
  });

  it("preserves explicit service routing and creates one primary link", () => {
    expect(source).toContain("profession_code, is_primary");
    expect(source).toContain("professionCode === input.primaryProfessionCode");
    expect(source).toContain(
      "A service requires an explicit primary profession.",
    );
  });

  it("preflights alias collisions and records the privileged audit provenance", () => {
    expect(source).toContain("findAliasConflicts");
    expect(source).toContain('status: "ALIAS_CONFLICT"');
    expect(source).toContain("'admin.taxonomy.manage'");
    expect(source).toContain("'taxonomy.catalog.edit'");
    expect(source).toContain("input.fingerprint.toUpperCase()");
  });
});

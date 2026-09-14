import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0013_profession_taxonomy.sql", import.meta.url),
  "utf8",
);

describe("profession taxonomy migration", () => {
  it("defines governed snapshot content and current projections", () => {
    for (const token of [
      "profession_taxonomy_releases",
      "taxonomy_professions",
      "taxonomy_specializations",
      "taxonomy_capability_criteria",
      "taxonomy_aliases",
      "current_profession_taxonomy",
      "current_specialization_taxonomy",
      "current_profession_capability_criteria",
      "current_taxonomy_aliases",
      "HUMAN_REVIEW_APPROVED",
      "PLACEHOLDER",
    ]) {
      expect(migration).toContain(token);
    }
  });

  it("seals installation and preserves append-only history", () => {
    expect(migration).toContain("installation_txid");
    expect(migration).toContain("taxonomy release content is sealed");
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
    expect(migration).toContain("taxonomy history is append-only");
    expect(migration).not.toMatch(/ON DELETE CASCADE/iu);
  });

  it("serializes activation with server order and rejects replacement cycles", () => {
    expect(migration).toContain("pg_advisory_xact_lock(1301001)");
    expect(migration).toContain("GENERATED ALWAYS AS IDENTITY");
    expect(migration).toContain("NEW.occurred_at := clock_timestamp()");
    expect(migration).toContain("ORDER BY activation_sequence DESC");
    expect(migration).toContain("taxonomy_release_has_replacement_cycle");
  });

  it("keeps credentials and ratings outside taxonomy schema", () => {
    expect(migration).not.toMatch(/credential_requirement|rating|reputation/iu);
  });
});

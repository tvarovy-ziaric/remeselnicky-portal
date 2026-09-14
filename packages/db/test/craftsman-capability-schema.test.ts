import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0017_skills_specializations.sql", import.meta.url),
  ),
  "utf8",
);

describe("skills and specializations migration", () => {
  it("keeps skills in a separately versioned, checksum-sealed governed catalog", () => {
    expect(migration).toMatch(/CREATE TABLE skill_catalog_releases/u);
    expect(migration).toMatch(/checksum_sha256/u);
    expect(migration).toMatch(/installation_txid/u);
    expect(migration).toMatch(/skill catalog release content is sealed/u);
    expect(migration).toMatch(
      /canonical skill catalog must contain a profession-linked skill/u,
    );
    expect(migration).not.toMatch(/ALTER TABLE profession_taxonomy_releases/u);
  });

  it("models catalog skills to professions as many-to-many", () => {
    expect(migration).toMatch(/CREATE TABLE skill_catalog_skill_professions/u);
    expect(migration).toMatch(
      /PRIMARY KEY \(release_id, skill_code, profession_code\)/u,
    );
    expect(migration).toMatch(
      /catalog skill requires at least one relevant profession/u,
    );
  });

  it("keeps custom wording and mapping history immutable", () => {
    expect(migration).toMatch(/retained_custom_text/u);
    expect(migration).toMatch(
      /CREATE TABLE craftsman_custom_skill_mapping_events/u,
    );
    expect(migration).toMatch(/craftsman_skill_mapping_events_immutable/u);
    expect(migration).toMatch(/invalid skill history mutation/u);
  });

  it("blocks contact-channel bypass in governed labels and custom wording", () => {
    expect(migration).toMatch(/craftsman_capability_public_text_safe/u);
    expect(migration).toMatch(
      /craftsman_capability_public_text_safe\(label_sk\)/u,
    );
    expect(migration).toMatch(
      /craftsman_capability_public_text_safe\(retained_custom_text\)/u,
    );
    expect(migration).toContain("\\m(https?://|www\\.)");
  });

  it("has no per-skill proficiency or quantity reputation primitive", () => {
    const skillSection = migration.slice(
      migration.indexOf("CREATE TABLE craftsman_skills"),
      migration.indexOf("CREATE TABLE craftsman_skill_profession_links"),
    );
    expect(skillSection).not.toMatch(
      /BEGINNER|ADVANCED|MASTER|proficiency|level/u,
    );
    expect(migration).toMatch(/'NONE'::text AS ranking_signal/u);
    expect(migration).toMatch(/NULL::timestamptz AS evidence_supported_at/u);
  });

  it("requires explicit command effects and append-only histories", () => {
    expect(migration).toMatch(
      /skill add command requires an active linked claim/u,
    );
    expect(migration).toMatch(
      /custom skill mapping command requires an event/u,
    );
    expect(migration).toMatch(
      /specialization requires add command provenance/u,
    );
    expect(migration).toMatch(/craftsman capability history is append-only/u);
  });
});

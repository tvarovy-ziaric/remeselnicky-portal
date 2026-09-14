import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  craftsmanProfessionCommands,
  craftsmanProfessionDeclaredLevelEvents,
  craftsmanProfessions,
} from "../src/schema/craftsman-profession.js";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0016_craftsman_professions.sql", import.meta.url),
  ),
  "utf8",
);

describe("craftsman profession schema", () => {
  it("exports assignment, idempotency and declared-level history tables", () => {
    expect(craftsmanProfessions.taxonomyReleaseId).toBeDefined();
    expect(craftsmanProfessionCommands.payloadFingerprint).toBeDefined();
    expect(craftsmanProfessionDeclaredLevelEvents.revision).toBeDefined();
  });

  it("uses the locked profession-specific proficiency levels", () => {
    expect(migration).toContain("'BEGINNER'");
    expect(migration).toContain("'ADVANCED'");
    expect(migration).toContain("'MASTER'");
    expect(migration).not.toMatch(/EXPERT|GLOBAL_PROFICIENCY/u);
  });

  it("references governed taxonomy without copying taxonomy labels", () => {
    expect(migration).toMatch(
      /FOREIGN KEY \(taxonomy_release_id, profession_code\)[\s\S]*REFERENCES taxonomy_professions/u,
    );
    expect(migration).toMatch(/stale profession taxonomy release/u);
    expect(migration).toMatch(
      /profession must be active in current canonical taxonomy/u,
    );
    expect(migration).not.toMatch(/profession_label|label_sk/u);
  });

  it("keeps declared history append-only and evidence support separate", () => {
    expect(migration).toMatch(
      /declared proficiency revisions must be contiguous/u,
    );
    expect(migration).toMatch(/craftsman profession history is append-only/u);
    expect(migration).toMatch(
      /NULL::profession_proficiency_level AS evidence_supported_level/u,
    );
    expect(migration).not.toMatch(/evidence_threshold|rating_threshold/u);
    expect(migration).toMatch(/DEFERRABLE INITIALLY DEFERRED/u);
    expect(migration).toMatch(
      /craftsman profession requires initial declared proficiency/u,
    );
  });

  it("guards owner activity, invalid transitions and hard deletion", () => {
    expect(migration).toMatch(/active craftsman profile owner required/u);
    expect(migration).toMatch(/FOR UPDATE OF profile, owner/u);
    expect(migration).toMatch(/invalid craftsman profession transition/u);
    expect(migration).toMatch(
      /deactivation requires matching command provenance/u,
    );
    expect(migration).toMatch(/BEFORE DELETE ON craftsman_professions/u);
    expect(migration).toMatch(/WHERE state = 'ACTIVE'/u);
  });
});

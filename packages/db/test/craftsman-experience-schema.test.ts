import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  craftsmanExperienceCommands,
  craftsmanExperienceRevisions,
} from "../src/schema/craftsman-experience.js";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0020_craftsman_experience.sql", import.meta.url),
  ),
  "utf8",
);

describe("craftsman experience schema", () => {
  it("exports profile-wide commands and immutable revisions", () => {
    expect(craftsmanExperienceCommands.expectedRevision).toBeDefined();
    expect(craftsmanExperienceRevisions.workingSinceYear).toBeDefined();
  });

  it("stores working-since year rather than manually maintained years", () => {
    expect(migration).toMatch(/working_since_year integer/u);
    expect(migration).not.toMatch(/years_of_experience|experience_years/u);
  });

  it("uses the DB calendar and a broad technical lower bound", () => {
    expect(migration).toMatch(/EXTRACT\(YEAR FROM CURRENT_DATE\)::integer/u);
    expect(migration).toMatch(/working_since_year BETWEEN 1800 AND 9999/u);
    expect(migration).toMatch(/cannot be outside the server calendar range/u);
  });

  it("is self-declared context without evidence or reputation coupling", () => {
    expect(migration).toMatch(/self-declared working-since context/u);
    expect(migration).not.toMatch(
      /evidence_supported_level|reputation_score|rating_score/u,
    );
    expect(migration).not.toMatch(/craftsman_profession_id/u);
  });

  it("supports real null clearing and deterministic initial-null unchanged semantics", () => {
    expect(migration).toMatch(/working_since_year integer,/u);
    expect(migration).toMatch(/result_kind = 'UNCHANGED'/u);
    expect(migration).toMatch(/resulting_revision = expected_revision/u);
    expect(migration).toMatch(/result_kind = 'APPLIED'/u);
  });

  it("enforces active ownership, exact effects and append-only history", () => {
    expect(migration).toMatch(/FOR UPDATE OF profile, owner/u);
    expect(migration).toMatch(/active owned craftsman profile required/u);
    expect(migration).toMatch(/requires exact revision effect/u);
    expect(migration).toMatch(/history is append-only/u);
    expect(migration).toMatch(/DEFERRABLE INITIALLY DEFERRED/u);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0022_portfolio_project_core.sql", import.meta.url),
  ),
  "utf8",
);

describe("portfolio project core migration", () => {
  it("starts every project as private self-declared and unverified", () => {
    expect(migration).toMatch(
      /portfolio_project_provenance_kind AS ENUM \('SELF_DECLARED'\)/u,
    );
    expect(migration).toMatch(/must start as self-declared private draft/u);
    expect(migration).toMatch(/'UNVERIFIED'::text AS evidence_status/u);
    expect(migration).not.toMatch(
      /source_job_id|job_participant_id|public_portfolio_projects/u,
    );
  });

  it("requires bounded unique profession tags and validates all owned relations", () => {
    expect(migration).toMatch(
      /portfolio_uuid_array_valid\(profession_ids, 1, 20\)/u,
    );
    expect(migration).toMatch(/owned relevant profession tags required/u);
    expect(migration).toMatch(/owned relevant skill tags required/u);
    expect(migration).toMatch(/owned relevant specialization tags required/u);
    expect(migration).toMatch(/craftsman_skill_profession_links/u);
  });

  it("keeps approximate location consistent without exact address fields", () => {
    expect(migration).toMatch(
      /municipality\.district_code = candidate_district_code/u,
    );
    expect(migration).not.toMatch(
      /street|house_number|exact_address|customer_(?:id|name)/u,
    );
  });

  it("mirrors privacy checks across all future-public text fields", () => {
    expect(migration).toMatch(/portfolio_project_public_text_safe/u);
    for (const field of [
      "title",
      "short_description",
      "contribution",
      "materials_and_technologies",
      "problem",
      "solution",
    ]) {
      expect(migration).toMatch(
        new RegExp(`portfolio_project_public_text_safe\\(${field}\\)`, "u"),
      );
    }
    expect(migration).toMatch(/zákazník\|zákazníčka\|klient/u);
  });

  it("preserves exact revision, authorship and state history", () => {
    expect(migration).toMatch(
      /portfolio revision must be an exact command snapshot/u,
    );
    expect(migration).toMatch(
      /portfolio authorship and provenance are immutable/u,
    );
    expect(migration).toMatch(/portfolio history is append-only/u);
    expect(migration).toMatch(
      /portfolio command requires exact project and revision effects/u,
    );
  });

  it("uses bounded duration and integer-cent indicative ranges", () => {
    expect(migration).toMatch(/duration_value BETWEEN 1 AND 1200/u);
    expect(migration).toMatch(/indicative_price_min_cents bigint/u);
    expect(migration).toMatch(
      /indicative_price_max_cents BETWEEN indicative_price_min_cents/u,
    );
    expect(migration).not.toMatch(/LOW|MEDIUM|HIGH|exact_price/u);
  });
});

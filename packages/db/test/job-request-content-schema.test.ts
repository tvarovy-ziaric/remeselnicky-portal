import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../migrations/0038_job_request_content_validation.sql",
  import.meta.url,
);

describe("job request content schema", () => {
  it("allowlists the six versioned sections and rejects unknown content", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    for (const section of [
      "request.core",
      "request.location",
      "request.timing",
      "request.budget",
      "request.details",
      "request.media",
    ]) {
      expect(migration).toContain(section);
    }
    expect(migration).toContain("job_request_json_has_only_keys");
    expect(migration).toContain("job request section content is invalid");
    expect(migration).toMatch(/candidate_schema_version <> 1/iu);
    expect(migration).toMatch(/RETURN false;\s*END;/iu);
  });

  it("uses governed profession, skill, and municipality references", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    expect(migration).toContain("current_profession_taxonomy");
    expect(migration).toContain("current_specialization_taxonomy");
    expect(migration).toContain("current_skill_catalog_professions");
    expect(migration).toContain("location_municipalities");
    expect(migration).toMatch(/profession\.state = 'ACTIVE'/u);
    expect(migration).toMatch(/location\.is_active/u);
    expect(migration).not.toMatch(/municipality\.active|location\.active/u);
  });

  it("keeps media private, purpose-bound, and limited", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    expect(migration).toContain("JOB_REQUEST_DOCUMENT");
    expect(migration).toContain("'photoMediaAssetIds', 10");
    expect(migration).toContain("'documentMediaAssetIds', 128");
    expect(migration).toContain("asset.status = 'READY'");
    expect(migration).toContain("asset.owner_user_id = owner_id");
    expect(migration).toContain("asset.provenance_entity_type = 'JOB_REQUEST'");
    expect(migration).toContain(
      "asset.provenance_entity_id = NEW.job_request_id",
    );
    expect(migration).not.toMatch(/public[-_]derivative|public_url/iu);
  });

  it("replaces the activation seam with revision-aware authoritative checks", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION job_request_missing_submission_requirements",
    );
    expect(migration).toContain(
      "section.request_revision <= candidate_revision",
    );
    expect(migration).toContain("'PRIMARY_PROFESSION'");
    expect(migration).toContain("'DESCRIPTION'");
    expect(migration).toContain("'MUNICIPALITY'");
    expect(migration).not.toMatch(/readiness_token|client_eligibility/iu);
  });
});

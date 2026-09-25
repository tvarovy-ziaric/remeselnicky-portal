import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../migrations/0109_job_property_photo_consent.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("D27 Job property-photo consent migration", () => {
  it("binds every decision to one Job, customer, photo and policy version", () => {
    expect(migration).toContain(
      "CREATE TABLE job_property_photo_consent_events",
    );
    expect(migration).toContain("job_id uuid NOT NULL");
    expect(migration).toContain("media_asset_id uuid NOT NULL");
    expect(migration).toContain("customer_user_id uuid NOT NULL");
    expect(migration).toContain("policy_version_id uuid NOT NULL");
    expect(migration).toContain("PORTFOLIO_PROPERTY_PHOTO_PUBLICATION");
  });

  it("requires the exact Job customer and same-Job safe private image", () => {
    expect(migration).toContain(
      "exact Job customer required for photo consent",
    );
    expect(migration).toContain("job_property_photo_is_candidate");
    expect(migration).toContain("job_conversation_media");
    expect(migration).toContain(
      "same-Job READY private property photo required",
    );
  });

  it("keeps completion separate and supports auditable easy withdrawal", () => {
    expect(migration).not.toMatch(/completion.*consent|consent.*completion/iu);
    expect(migration).toContain("'GRANTED', 'DECLINED', 'WITHDRAWN'");
    expect(migration).toContain(
      "withdrawal must reference the exact granted policy",
    );
    expect(migration).toContain(
      "property-photo consent history is append-only",
    );
  });

  it("exports a fail-closed predicate without publishing private media", () => {
    expect(migration).toContain("job_property_photo_consent_is_current");
    expect(migration).toContain("consent.action = 'GRANTED'");
    expect(migration).not.toMatch(/INSERT INTO media_asset_storage_objects/iu);
  });
});

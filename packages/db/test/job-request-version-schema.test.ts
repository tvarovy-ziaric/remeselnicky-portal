import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../migrations/0039_job_request_active_versions.sql",
  import.meta.url,
);

describe("active job request version schema", () => {
  it("keeps commands, versions, and section effects append-only and exact", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    expect(migration).toContain("job_request_active_edit_commands");
    expect(migration).toContain("job_request_active_content_revisions");
    expect(migration).toContain("job_request_active_section_revisions");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("applied active edit requires exact effects");
    expect(
      migration.match(/reject_job_request_history_mutation/g)?.length,
    ).toBe(3);
  });

  it("derives classification and visible versions on the server", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    expect(migration).toContain("job_request_classify_active_change");
    for (const category of [
      "ATTACHMENTS",
      "BUDGET",
      "LOCATION",
      "MATERIAL_RESPONSIBILITY",
      "OTHER_REQUIREMENTS",
      "PROFESSION",
      "SCHEDULE",
      "SCOPE",
    ]) {
      expect(migration).toContain(`'${category}'`);
    }
    expect(migration).toMatch(
      /expected_visible := current_content\.visible_version[\s\S]*computed_material/iu,
    );
    expect(migration).not.toMatch(/client.*material|client.*categor/iu);
  });

  it("creates a sealed baseline from the activation snapshot", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    expect(migration).toContain("create_job_request_active_content_baseline");
    expect(migration).toContain("section.request_revision <= NEW.revision");
    expect(migration).toContain("parent.created_txid <> txid_current()");
    expect(migration).toContain(
      "active section must be installed with its revision",
    );
  });

  it("revalidates private media and active ownership", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    expect(migration).toContain("owner.account_state");
    expect(migration).toContain("current_lifecycle.state <> 'ACTIVE'");
    expect(migration).toContain("job_request_active_media_available");
    expect(migration).toContain("asset.status = 'READY'");
    expect(migration).toContain("asset.provenance_entity_type = 'JOB_REQUEST'");
    expect(migration).not.toMatch(/public_url|storage_key/iu);
  });
});

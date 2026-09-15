import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../migrations/0037_job_request_draft_autosave.sql",
  import.meta.url,
);

describe("job request draft autosave schema", () => {
  it("keeps draft payloads bounded, private and append-only", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    expect(migration).toContain("job_request_draft_json_is_bounded");
    expect(migration).toMatch(/COALESCE\(max\(depth\), 0\) <= 8/u);
    expect(migration).toMatch(/octet_length\(payload::text\) <= 34816/u);
    expect(migration).toMatch(/section_count >= 32/u);
    expect(migration).toContain(
      "job_request_draft_section_revisions_append_only",
    );
    expect(migration).toContain("PRIVATE server draft transport only");
    expect(migration).not.toMatch(/outbox_payload|public_url/iu);
  });

  it("requires exact effects for APPLIED and no effect for UNCHANGED", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    expect(migration).toContain("CREATE_DRAFT_WITH_SECTION");
    expect(migration).toContain("equivalent draft autosave must be unchanged");
    expect(migration).toContain(
      "changed draft autosave must append one revision",
    );
    expect(migration).toContain("unchanged autosave cannot create an effect");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
  });
});

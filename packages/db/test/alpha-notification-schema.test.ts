import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("R4-024 alpha notification migration", () => {
  it("captures mandatory events and preserves canonical in-app delivery", async () => {
    const migration = await readFile(
      new URL(
        "../migrations/0106_alpha_notification_catalog_preferences.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const event of [
      "job.confirmed",
      "job.review.response.created",
      "credential.approved",
      "credential.rejected",
      "credential.revoked",
      "profile.approved",
      "profile.rejected",
    ]) {
      expect(migration).toContain(`'${event}'`);
    }
    expect(migration).toContain("notification_channel_preferences");
    expect(migration).toContain("requested_channels");
    expect(migration).toContain("delivery_channels");
    expect(migration).toContain("CHECK (channel IN ('EMAIL', 'PUSH'))");
    expect(migration).not.toMatch(
      /exact_address|phone|email_address|private_admin_note/iu,
    );
  });
});

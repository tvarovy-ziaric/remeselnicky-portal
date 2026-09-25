import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../migrations/0112_privacy_notification_delivery_disposition.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const executor = readFileSync(
  fileURLToPath(
    new URL("../src/privacy-category-disposition-executor.ts", import.meta.url),
  ),
  "utf8",
);

describe("D27 notification delivery disposition executor", () => {
  it("deletes only subject delivery metadata and preserves notifications", () => {
    expect(executor).toContain("DELETE FROM notification_deliveries delivery");
    expect(executor).toContain(
      "notification.recipient_user_id = ${job.subjectUserId}",
    );
    expect(executor).not.toMatch(/DELETE FROM notifications/u);
    expect(executor).not.toMatch(/DELETE FROM users/u);
  });

  it("records a non-sensitive immutable idempotency receipt", () => {
    expect(migration).toContain("privacy_category_execution_receipts");
    expect(migration).toContain("affected_record_count");
    expect(migration).toContain("result_digest char(64)");
    expect(migration).toContain(
      "privacy_category_execution_receipts_immutable",
    );
    expect(executor).not.toContain("provider_message_reference AS");
  });

  it("requires the exact active leased job identity", () => {
    expect(migration).toContain(
      "privacy execution receipt does not match its active job",
    );
    expect(executor).toContain('active.state !== "PROCESSING"');
    expect(executor).toContain("active.attempt !== context.attempt");
  });
});

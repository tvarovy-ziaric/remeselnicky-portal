import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../migrations/0113_privacy_restore_reapplication.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const reapplicator = readFileSync(
  fileURLToPath(
    new URL(
      "../../../infra/postgres/recovery/reapply-privacy-tombstones.mjs",
      import.meta.url,
    ),
  ),
  "utf8",
);
const alphaGrant = readFileSync(
  fileURLToPath(
    new URL("../../../infra/alpha/grant-runtime.sh", import.meta.url),
  ),
  "utf8",
);

describe("D27 disaster-restore tombstone reapplication", () => {
  it("supports only the reviewed notification-delivery deletion effect", () => {
    expect(migration).toContain("NEW.category = 'NOTIFICATION_DELIVERY'");
    expect(migration).toContain("NEW.disposition = 'DELETE'");
    expect(migration).toContain("DELETE FROM notification_deliveries delivery");
    expect(migration).toContain(
      "notification.recipient_user_id = NEW.subject_user_id",
    );
    expect(migration).toContain(
      "unsupported privacy restore tombstone category",
    );
    expect(migration).not.toMatch(/DELETE FROM notifications/u);
    expect(migration).not.toMatch(/DELETE FROM users/u);
    expect(migration).not.toMatch(/DELETE FROM jobs/u);
  });

  it("requires an isolated database owner and denies the runtime role", () => {
    expect(migration).toContain("assert_privacy_restore_database_owner");
    expect(migration).toContain("database_owner IS DISTINCT FROM current_user");
    expect(migration).toContain(
      "REVOKE ALL ON privacy_restore_reapplication_runs FROM PUBLIC",
    );
    expect(alphaGrant).toContain(
      "REVOKE ALL ON TABLE privacy_restore_applied_tombstones",
    );
    expect(alphaGrant).toContain(
      "REVOKE EXECUTE ON FUNCTION apply_privacy_restore_tombstone",
    );
  });

  it("is immutable, exact-identity bound and globally idempotent", () => {
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain(
      "target_tombstone_id <> target_source_event_id",
    );
    expect(migration).toContain("privacy restore tombstone identity conflict");
    expect(migration).toContain("privacy restore history is immutable");
    expect(migration).toContain(
      "ON CONFLICT (run_id, tombstone_id) DO NOTHING",
    );
    expect(migration).toContain("ALREADY_APPLIED");
  });

  it("cannot attest completion without one outcome per ledger record", () => {
    expect(migration).toContain(
      "applied_count + already_count <> OLD.records_expected",
    );
    expect(migration).toContain("privacy restore run item count mismatch");
    expect(reapplicator).toContain('"BEGIN;"');
    expect(reapplicator).toContain('"COMMIT;"');
    expect(reapplicator).toContain("PORTAL_TOMBSTONE_LEDGER_SHA256");
    expect(reapplicator).toContain("Tombstone ledger digest mismatch");
  });

  it("emits only content-free bounded failure and completion evidence", () => {
    expect(reapplicator).toContain(
      "Privacy tombstone reapplication failed without exposing ledger content.",
    );
    expect(reapplicator).not.toContain("console.error");
    expect(migration).not.toMatch(
      /raw_receipt|provider_reference|message_body|exact_address/iu,
    );
  });
});

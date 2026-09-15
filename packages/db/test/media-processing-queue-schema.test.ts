import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0054_media_processing_queue.sql", import.meta.url),
  ),
  "utf8",
);

describe("0054 media processing queue schema", () => {
  it("captures every PROCESSING asset atomically with a privacy-minimal payload", () => {
    expect(migration).toContain("AFTER INSERT ON media_assets");
    expect(migration).toContain("WHEN (NEW.status = 'PROCESSING')");
    expect(migration).toContain(
      "INSERT INTO media_processing_jobs (asset_id, kind)",
    );
    expect(migration).toContain("WHERE asset.status = 'PROCESSING'");
    expect(migration).not.toMatch(
      /filename|storage_key|content_sha|owner_user/iu,
    );
  });

  it("has reclaimable leases, bounded attempts and terminal evidence", () => {
    expect(migration).toContain("lease_token uuid");
    expect(migration).toContain("lease_expires_at timestamptz");
    expect(migration).toContain("max_attempts >= 1 AND max_attempts <= 100");
    expect(migration).toContain("'NON_RETRYABLE', 'RETRIES_EXHAUSTED'");
    expect(migration).toContain("media_processing_jobs_reclaim_idx");
  });

  it("protects identity, transitions and deletion", () => {
    expect(migration).toContain("media processing job identity is immutable");
    expect(migration).toContain("invalid media processing job transition");
    expect(migration).toContain("media processing retry has invalid counters");
    expect(migration).toContain(
      "media processing success has invalid counters",
    );
    expect(migration).toContain(
      "media processing terminal result has invalid counters",
    );
    expect(migration).toContain("media processing jobs cannot be deleted");
  });
});

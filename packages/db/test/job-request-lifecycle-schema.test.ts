import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../migrations/0040_job_request_operational_lifecycle.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("job request operational lifecycle schema", () => {
  it("adds history-preserving cancel, expiry, extension, and reactivation", () => {
    expect(migration).toContain("ADD VALUE IF NOT EXISTS 'EXPIRED'");
    expect(migration).toContain("ADD VALUE IF NOT EXISTS 'CANCELLED'");
    expect(migration).toContain("ELSIF kind = 'EXTEND'");
    expect(migration).toContain("ELSIF kind = 'EXPIRE'");
    expect(migration).toContain("ELSIF kind = 'REACTIVATE'");
    expect(migration).toContain("ELSIF kind = 'CANCEL'");
    expect(migration).toContain("cancellation_reason");
    expect(migration).not.toMatch(/DELETE FROM job_request/iu);
  });

  it("enforces the configurable active limit and server-owned inactivity", () => {
    expect(migration).toContain("CREATE TABLE job_request_runtime_policy");
    expect(migration).toContain(
      "active_request_limit integer NOT NULL DEFAULT 5",
    );
    expect(migration).toContain("inactivity_days integer NOT NULL DEFAULT 30");
    expect(migration).toContain("warning_lead_days integer NOT NULL DEFAULT 7");
    expect(migration).toContain("job_request_effective_expires_at");
    expect(migration).toContain(
      "hashtextextended(NEW.customer_profile_id::text, 40006)",
    );
    expect(migration).toContain("active_count >= active_limit");
  });

  it("keeps active content submission-ready and revalidates reactivation", () => {
    expect(migration).toContain(
      "job_request_active_missing_submission_requirements",
    );
    expect(migration).toContain("job_request_active_content_ready");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain(
      "NEW.submission_eligibility_revision IS DISTINCT FROM",
    );
  });
});

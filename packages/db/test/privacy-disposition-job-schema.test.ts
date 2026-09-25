import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0111_privacy_disposition_jobs.sql", import.meta.url),
  ),
  "utf8",
);
const repository = readFileSync(
  fileURLToPath(
    new URL("../src/privacy-disposition-queue.ts", import.meta.url),
  ),
  "utf8",
);

describe("D27 resumable disposition jobs and recovery tombstones", () => {
  it("captures only reviewed destructive READY decisions", () => {
    expect(migration).toContain("capture_privacy_disposition_job");
    expect(migration).toContain("NEW.state <> 'READY'");
    expect(migration).toContain(
      "NEW.disposition NOT IN ('DELETE', 'ANONYMIZE')",
    );
    expect(migration).toContain("NEW.disposition_admin_command_id IS NULL");
    expect(migration).toContain(
      "FROM current_privacy_data_dispositions current",
    );
    expect(migration).toContain("ON CONFLICT (tombstone_id) DO NOTHING");
    expect(migration).toContain("ON CONFLICT (job_id) DO NOTHING");
  });

  it("requires an independent receipt before a job can be claimed", () => {
    expect(migration).toContain("privacy_recovery_tombstones");
    expect(migration).toContain("privacy_recovery_tombstone_receipts");
    expect(repository).toContain(
      "JOIN privacy_recovery_tombstone_receipts receipt",
    );
    expect(repository).toContain("receipt.tombstone_id = job.tombstone_id");
    expect(repository).not.toContain("${input.receipt}");
    expect(repository).toContain("const receiptDigest = digest(input.receipt)");
  });

  it("uses bounded leases and explicit retryable failure history", () => {
    expect(migration).toContain("lease_expires_at");
    expect(migration).toContain("interval '5 minutes'");
    expect(repository).toContain("FOR UPDATE OF job SKIP LOCKED");
    expect(repository).toContain('appendWorkerEvent(tx, row, "PROCESSING")');
    expect(repository).toContain('appendWorkerEvent(tx, row, "FAILED")');
    expect(repository).toContain('appendWorkerEvent(tx, row, "COMPLETED")');
    expect(repository).toContain("job.attempt_count >= job.max_attempts");
    expect(repository).toContain("last_error_code = 'LEASE_EXPIRED'");
    expect(repository).toContain("job.attempt_count < job.max_attempts");
    expect(repository).toContain(
      "JOIN privacy_category_execution_receipts receipt",
    );
    expect(repository).toContain(
      'appendWorkerEvent(tx, completed, "COMPLETED")',
    );
  });

  it("preserves exact category, policy, subject and immutable provenance", () => {
    expect(migration).toContain(
      "privacy worker event does not match its exact job",
    );
    expect(migration).toContain(
      "privacy worker event has stale category state",
    );
    expect(migration).toContain(
      "privacy disposition job identity is immutable",
    );
    expect(migration).toContain("privacy_recovery_tombstones_immutable");
    expect(migration).toContain(
      "privacy_recovery_tombstone_receipts_immutable",
    );
    expect(migration).toContain("privacy disposition jobs cannot be deleted");
  });

  it("binds every job to its exact reviewed event and recovery tombstone", () => {
    expect(migration).toContain(
      "CREATE FUNCTION validate_privacy_disposition_job_insert()",
    );
    expect(migration).toContain(
      "privacy disposition job must exactly match its reviewed tombstone",
    );
    expect(repository).not.toContain("JSON.stringify(payloadFromRow(row))");
  });

  it("never performs a category transformation inside the queue adapter", () => {
    expect(migration).not.toMatch(/DELETE FROM users|DELETE FROM jobs/iu);
    expect(repository).not.toMatch(/DELETE FROM|UPDATE users|UPDATE jobs/iu);
  });
});

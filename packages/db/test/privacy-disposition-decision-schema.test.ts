import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../migrations/0110_privacy_disposition_decisions.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("D27 category disposition decisions", () => {
  it("initializes all erasure categories only on the action-required boundary", () => {
    expect(migration).toContain("initialize_erasure_data_dispositions");
    expect(migration).toContain("NEW.state <> 'ACTION_REQUIRED'");
    expect(migration).toContain("request.request_type = 'ERASURE'");
    expect(migration).toContain(
      "unnest(enum_range(NULL::privacy_retention_category))",
    );
    expect(migration).toContain("'REVIEW_REQUIRED', 'BLOCKED'");
  });

  it("requires a current action-required case and an exact optimistic head", () => {
    expect(migration).toContain("privacy_data_disposition_admin_commands");
    expect(migration).toContain(
      "request_state IS DISTINCT FROM 'ACTION_REQUIRED'",
    );
    expect(migration).toContain(
      "current_event.revision IS DISTINCT FROM NEW.expected_revision",
    );
    expect(migration).toContain("stale privacy disposition state");
    expect(migration).toContain("privacy disposition is not reviewable");
  });

  it("fails closed until the exact category policy is executable", () => {
    expect(migration).toContain("category = NEW.category");
    expect(migration).toContain("legal_review_state = 'APPROVED'");
    expect(migration).toContain("launch_state = 'READY'");
    expect(migration).toContain("duration_days IS NOT NULL");
    expect(migration).toContain(
      "executable reviewed retention policy required",
    );
  });

  it("queues destructive transformations but completes no-data/retain decisions", () => {
    expect(migration).toContain(
      "resulting_disposition IN ('DELETE', 'ANONYMIZE')",
    );
    expect(migration).toContain("resulting_state = 'READY'");
    expect(migration).toContain(
      "resulting_disposition IN ('RETAIN', 'NO_DATA')",
    );
    expect(migration).toContain("resulting_state = 'COMPLETED'");
    expect(migration).not.toMatch(/DELETE FROM|UPDATE users/u);
  });

  it("requires a matching immutable recent-MFA audit trail", () => {
    expect(migration).toContain("privacy_admin_session_is_recent");
    expect(migration).toContain("admin.privacy.manage");
    expect(migration).toContain("admin.privacy.disposition_decided");
    expect(migration).toContain(
      "matching immutable privacy disposition audit required",
    );
    expect(migration).toContain("prevent_privacy_operational_history_mutation");
  });
});
